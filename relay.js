#!/usr/bin/env node
// Davorid relay for Node.js (18 or newer), no packages needed.
//
// The same relay as game/scripts/net/relay_server.gd, for hosts that run
// Node but not Godot: a free cloud web service (Render, Railway, Koyeb,
// Fly.io...), a VPS, a Raspberry Pi. Behind a cloud host's HTTPS the game
// reaches it as wss://<name> on port 443, which gets out of eduroam, campus,
// hotel and phone-hotspot networks alike.
//
//   node relay.js [--port 8790] [--name "My relay"] [--cert cert.pem --key key.pem] [--quiet]
//   (the PORT and RELAY_NAME environment variables work too; cloud hosts set PORT)
//
// HTTP on the same port: GET / (status page), GET /games (the public game
// list as JSON), GET /health ("ok"). Everything else is the WebSocket relay.
// Wire format: see game/scripts/net/relay_protocol.gd.

"use strict";
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");

const PROTO = 1;
const GAME = "davorid";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const HEADER = 5;
const META_PING = 0xff;
const MAX_MESSAGE = 1 << 20;
const INFO_KEYS = ["game", "name", "map", "mode", "players", "max", "v", "rules"];
const INFO_TEXT_MAX = 48;
const MAX_CONNECTIONS = 512;
const MAX_ROOMS = 200;
const MAX_ROOM_PEERS = 32;
const HANDSHAKE_MS = 10000;
const IDLE_MS = 90000;
const MAX_BYTES_PER_S = 4 * 1024 * 1024;
const SOFT_BACKLOG = 512 * 1024;
const HARD_BACKLOG = 6 * 1024 * 1024;
const TRANSFER_MODE_RELIABLE = 2;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const PORT = parseInt(option("--port", process.env.PORT || "8790"), 10);
const RELAY_NAME = String(option("--name", process.env.RELAY_NAME || "Davorid relay")).slice(0, 48);
const CERT = option("--cert", process.env.TLS_CERT || "");
const KEY = option("--key", process.env.TLS_KEY || "");
const QUIET = process.argv.includes("--quiet") || process.env.RELAY_QUIET === "1";

function log(text) {
  if (!QUIET) console.log(`[relay ${new Date().toISOString().slice(11, 19)}] ${text}`);
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

const conns = new Set();
const rooms = new Map(); // code -> {code, host, clients: Map(id -> conn), info, public}
let bytesRelayed = 0;
const started = Date.now();

function cleanCode(text) {
  const out = String(text || "").trim().toUpperCase().replace(/[ -]/g, "");
  if (out.length !== CODE_LENGTH) return "";
  for (const ch of out) if (!CODE_ALPHABET.includes(ch)) return "";
  return out;
}

function randomCode() {
  let out = "";
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function newCode() {
  for (let i = 0; i < 64; i++) {
    const code = randomCode();
    if (!rooms.has(code)) return code;
  }
  return randomCode();
}

function cleanInfo(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of INFO_KEYS) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (key === "players" || key === "max") {
      const n = typeof v === "number" ? Math.trunc(v) : 0;
      out[key] = Math.max(0, Math.min(64, n));
    } else {
      out[key] = String(v).slice(0, INFO_TEXT_MAX);
    }
  }
  return out;
}

function stats() {
  let pub = 0;
  let players = 0;
  for (const room of rooms.values()) {
    if (room.public) pub++;
    players += 1 + room.clients.size;
  }
  return { rooms: rooms.size, public_rooms: pub, players, connections: conns.size, bytes: bytesRelayed,
    uptime_s: Math.floor((Date.now() - started) / 1000) };
}

function publicList(game) {
  const out = [];
  for (const room of rooms.values()) {
    if (!room.public || !room.host || room.host.closing) continue;
    if (game && String(room.info.game || GAME) !== game) continue;
    const entry = Object.assign({}, room.info, { code: room.code });
    if (!("players" in entry)) entry.players = 1 + room.clients.size;
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// One WebSocket connection
// ---------------------------------------------------------------------------

class Conn {
  constructor(socket, ip) {
    this.socket = socket;
    this.ip = ip;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = 0;
    this.fragmentSize = 0;
    this.closing = false;
    this.role = "";
    this.room = "";
    this.peerId = 0;
    this.lastSeen = Date.now();
    this.windowStart = Date.now();
    this.windowBytes = 0;
  }

  sendFrame(opcode, payload) {
    if (this.closing && opcode !== 0x8) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  send(msg) {
    if (this.closing) return;
    this.sendFrame(0x1, Buffer.from(JSON.stringify(msg), "utf8"));
  }

  error(code, why) {
    this.send({ op: "error", code, why });
  }

  close(code, reason) {
    if (this.closing) return;
    leaveRoom(this);
    const r = Buffer.from(String(reason || "").slice(0, 120), "utf8");
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code || 1000, 0);
    r.copy(payload, 2);
    this.sendFrame(0x8, payload);
    this.closing = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 3000).unref();
  }

  // Bytes from the socket: whole frames out, partial ones kept.
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closing) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, "message too big");
        len = Number(big);
        off = 10;
      }
      if (!masked) return this.close(1002, "client frames must be masked");
      if (len > MAX_MESSAGE) return this.close(1009, "message too big");
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.frame(fin, op, payload);
    }
  }

  frame(fin, op, payload) {
    this.lastSeen = Date.now();
    if (op === 0x8) {
      if (!this.closing) this.close(1000, "");
      return;
    }
    if (op === 0x9) return this.sendFrame(0xa, payload);
    if (op === 0xa) return;
    if (op === 0x1 || op === 0x2) {
      if (this.fragments.length) return this.close(1002, "unfinished message");
      if (fin) return this.message(op, payload);
      this.fragmentOp = op;
      this.fragments = [payload];
      this.fragmentSize = payload.length;
      return;
    }
    if (op === 0x0) {
      if (!this.fragments.length) return this.close(1002, "stray continuation");
      this.fragments.push(payload);
      this.fragmentSize += payload.length;
      if (this.fragmentSize > MAX_MESSAGE) return this.close(1009, "message too big");
      if (fin) {
        const whole = Buffer.concat(this.fragments);
        this.fragments = [];
        this.message(this.fragmentOp, whole);
      }
      return;
    }
    this.close(1002, "unknown frame");
  }

  message(op, payload) {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowBytes = 0;
    }
    this.windowBytes += payload.length;
    if (this.windowBytes > MAX_BYTES_PER_S) {
      log(`cut off ${this.ip}: too much traffic`);
      return this.close(1008, "too much traffic");
    }
    if (op === 0x1) onControl(this, payload.toString("utf8"));
    else onData(this, payload);
  }
}

function leaveRoom(c) {
  if (c.role === "host") {
    const room = rooms.get(c.room);
    if (room && room.host === c) {
      rooms.delete(c.room);
      log(`room ${room.code} closed (${room.clients.size} joiners sent home)`);
      for (const j of room.clients.values()) {
        j.role = "";
        j.room = "";
        j.send({ op: "host_left" });
        // The close a moment later: Godot drops a message that arrives in the
        // same poll as the close frame.
        setTimeout(() => j.close(1000, "the host left"), 2000).unref();
      }
    }
  } else if (c.role === "client") {
    const room = rooms.get(c.room);
    if (room && room.clients.get(c.peerId) === c) {
      room.clients.delete(c.peerId);
      room.host.send({ op: "left", id: c.peerId });
    }
  }
  c.role = "";
  c.room = "";
}

// ---------------------------------------------------------------------------
// Control messages
// ---------------------------------------------------------------------------

function onControl(c, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    msg = null;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return c.error("bad", "Not a relay message.");
  const room = rooms.get(c.room);
  switch (String(msg.op || "")) {
    case "ping":
      return c.send({ op: "pong", t: msg.t || 0 });
    case "list":
      return c.send({ op: "games", games: publicList(String(msg.game || "")) });
    case "find": {
      const code = cleanCode(msg.code);
      const found = rooms.get(code);
      return c.send({ op: "found", code, exists: !!found, info: found ? found.info : {} });
    }
    case "host":
      return host(c, msg);
    case "update":
      if (c.role === "host" && room) {
        if ("info" in msg) room.info = cleanInfo(msg.info);
        if ("public" in msg) room.public = !!msg.public;
      }
      return;
    case "join":
      return join(c, msg);
    case "kick":
      if (c.role === "host" && room) {
        const target = room.clients.get(Math.trunc(Number(msg.id) || 0));
        if (target) {
          room.clients.delete(target.peerId);
          target.role = "";
          target.close(4001, "removed by the host");
        }
      }
      return;
    default:
      return c.error("bad", "Unknown request.");
  }
}

function host(c, msg) {
  if (c.role) return c.error("bad", "This connection already belongs to a room.");
  if (rooms.size >= MAX_ROOMS) return c.error("busy", `This relay is full right now (${MAX_ROOMS} games). Try another relay.`);
  let code = cleanCode(msg.want);
  if (!code || rooms.has(code)) code = newCode();
  const room = { code, host: c, clients: new Map(), info: cleanInfo(msg.info), public: msg.public !== false };
  rooms.set(code, room);
  c.role = "host";
  c.room = code;
  c.peerId = 1;
  c.send({ op: "hosted", code });
  log(`room ${code} opened by ${c.ip} (${room.info.name || "?"}, ${room.public ? "public" : "code only"})`);
}

function join(c, msg) {
  if (c.role) return c.error("bad", "This connection already belongs to a room.");
  const code = cleanCode(msg.code);
  const room = rooms.get(code);
  if (!room) return c.error("no_room", `No game with code ${code || String(msg.code || "")} on this relay (it may have ended).`);
  if (room.clients.size >= MAX_ROOM_PEERS) return c.error("full", "That game is full.");
  const id = Math.trunc(Number(msg.id) || 0);
  if (id < 2 || id > 0x7fffffff || room.clients.has(id)) return c.error("id_taken", "Pick another peer id.");
  c.role = "client";
  c.room = code;
  c.peerId = id;
  room.clients.set(id, c);
  // The joiner hears first, so it is ready before the host's first packet.
  c.send({ op: "joined", code, id, info: room.info });
  room.host.send({ op: "peer", id });
  log(`${c.ip} joined room ${code} as ${id}`);
}

// ---------------------------------------------------------------------------
// Game data
// ---------------------------------------------------------------------------

function onData(c, pkt) {
  if (pkt.length < HEADER) return;
  const room = rooms.get(c.room);
  if (!room) return;
  const meta = pkt[4];
  if (c.role === "client") {
    pkt.writeInt32LE(c.peerId, 0);
    return forward(room.host, pkt, meta);
  }
  if (c.role !== "host") return;
  const to = pkt.readInt32LE(0);
  pkt.writeInt32LE(1, 0);
  if (to > 1) {
    const target = room.clients.get(to);
    if (target) forward(target, pkt, meta);
    return;
  }
  for (const [id, target] of room.clients) {
    if (to < 0 && id === -to) continue;
    forward(target, pkt, meta);
  }
}

function forward(target, pkt, meta) {
  if (!target || target.closing) return;
  const backlog = target.socket.writableLength;
  if (backlog > HARD_BACKLOG) {
    log(`cut off ${target.ip}: not reading`);
    return target.close(1008, "too far behind");
  }
  if (backlog > SOFT_BACKLOG && (meta === META_PING || (meta & 3) !== TRANSFER_MODE_RELIABLE)) return;
  target.sendFrame(0x2, pkt);
  bytesRelayed += pkt.length;
}

// ---------------------------------------------------------------------------
// HTTP and the WebSocket handshake
// ---------------------------------------------------------------------------

function page(res) {
  const s = stats();
  const rows = publicList("").map((g) =>
    `<tr><td>${esc(g.name || "?")}</td><td>${esc(g.map || "")}</td><td>${esc(g.mode || "")}</td><td>${g.players || 0}/${g.max || 0}</td><td><code>${esc(g.code)}</code></td></tr>`).join("");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(RELAY_NAME)}</title>
<body style="font:15px system-ui;margin:2rem auto;max-width:44rem;padding:0 1rem;background:#15161a;color:#e9e2d0">
<h1 style="font-weight:600">${esc(RELAY_NAME)}</h1><p>A Davorid relay is running here. In the game: Multiplayer &rarr; Relay servers &rarr; add this page's address.</p>
<p>${s.rooms} games (${s.public_rooms} listed), ${s.players} players, up ${Math.floor(s.uptime_s / 3600)} h ${Math.floor(s.uptime_s / 60) % 60} min.</p>
<table style="border-collapse:collapse" cellpadding="6"><tr><th align=left>Host</th><th align=left>Map</th><th align=left>Mode</th><th>Players</th><th>Code</th></tr>${rows}</table></body>`);
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function onRequest(req, res) {
  const path = (req.url || "/").split("?")[0];
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  if (path === "/games") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ relay: RELAY_NAME, proto: PROTO, games: publicList(GAME) }));
  }
  return page(res);
}

function onUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  if (upgrade !== "websocket" || !key || conns.size >= MAX_CONNECTIONS) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
  // Behind a cloud host's proxy the visitor's address is in the header.
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const c = new Conn(socket, forwarded || socket.remoteAddress || "?");
  conns.add(c);
  socket.on("data", (chunk) => {
    try {
      c.feed(chunk);
    } catch (e) {
      log(`dropped ${c.ip}: ${e.message}`);
      socket.destroy();
    }
  });
  const gone = () => {
    if (!conns.has(c)) return;
    conns.delete(c);
    c.closing = true;
    leaveRoom(c);
  };
  socket.on("close", gone);
  socket.on("error", gone);
  const s = stats();
  c.send({ op: "welcome", proto: PROTO, name: RELAY_NAME, rooms: s.public_rooms, peers: s.players });
  if (head && head.length) c.feed(head);
}

const server = CERT && KEY
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, onRequest)
  : http.createServer(onRequest);
server.on("upgrade", onUpgrade);
server.headersTimeout = HANDSHAKE_MS;
server.requestTimeout = HANDSHAKE_MS;

setInterval(() => {
  const now = Date.now();
  for (const c of conns) if (!c.closing && now - c.lastSeen > IDLE_MS) c.close(1000, "idle");
}, 5000).unref();

server.listen(PORT, () => {
  console.log(`Davorid relay "${RELAY_NAME}" listening on port ${PORT} (${CERT && KEY ? "wss" : "ws"}).`);
});

function shutdown() {
  for (const c of conns) c.close(1001, "relay shutting down");
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
