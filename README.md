# Davorid relay

Multiplayer that works from **any network**. On eduroam, campus or hotel
Wi-Fi, a phone's hotspot, or behind an internet provider's shared address,
nobody can be reached from outside: there is no port to open, and players on
the same Wi-Fi often cannot even see each other. A relay gets around all of
that. Every player, the host included, connects **out** to the relay over a
WebSocket, and the relay passes the game's traffic along. It also keeps the
**online game list**: every game hosted on it shows up under
*Multiplayer > Games online*, and anyone joins with one click or with the
game's six-letter code.

Everyone who should see the same games needs to know the same relay. Put
your relay's address in `game/content/relays.json` and every copy of the
game uses it without anyone setting anything up. Players can also add relays
themselves under *Multiplayer > Relays...*.

Which relay to run:

| Where | Address players add | Gets out of strict networks? | Needs |
|---|---|---|---|
| Free cloud host (Render, Koyeb, Railway...) | `davorid-relay.onrender.com` | **Yes**: wss on port 443, like any web page | an account there, 5 minutes |
| Rented server / Raspberry Pi | `relay.example.com` or `203.0.113.7:8790` | Yes with TLS on 443 (Caddy), mostly without | a machine that stays on |
| Your PC at home | `203.0.113.7:8790` (your address) | Mostly (some campus networks block odd ports) | the PC on while people play, a router that forwards the port |

`relay.js` (Node.js 18 or newer, no packages) and the game's own Godot relay
(`game/scripts/net/relay_server.gd`) speak the same protocol; both are
checked by `tools/relay_probe.ps1`.

## A free cloud relay (recommended, works everywhere)

Render's free web services support WebSockets and give you an HTTPS address,
so the game reaches the relay as `wss://...` on port 443.

1. Make a GitHub repository holding the files of this `server` folder at its
   top (`relay.js`, `package.json`, `render.yaml`, `Dockerfile`).
2. On <https://render.com>: **New > Blueprint**, pick that repository, and
   confirm. (Or **New > Web Service**: runtime Node, build command
   `npm install`, start command `node relay.js`, instance type Free.)
3. When it is live, open its address (`https://<name>.onrender.com`) in a
   browser: a page saying "A Davorid relay is running here" means it works.
4. In the game: *Multiplayer > Relays... > Add a relay* and type
   `<name>.onrender.com` (no `https://`). To give it to everyone, put it in
   `game/content/relays.json`: `{ "relays": ["<name>.onrender.com"] }`.

A free Render service falls asleep after 15 minutes without visitors; the
next visit wakes it in about a minute. The game's list asks again every five
seconds, so the games appear once it is awake. Hosts that keep a game open
keep the relay awake.

The same `relay.js` runs on any host that runs Node.js and allows
WebSockets (Koyeb, Railway, Fly.io, Northflank, a Docker host with the
included `Dockerfile`). The host sets `PORT`; the relay listens on it.

## A server of your own

```bash
node relay.js --port 8790 --name "My relay"
```

Players add `your.server.address:8790` (plain `ws://`). For `wss://` on port
443, which gets through the strictest networks, put a TLS proxy in front.
With [Caddy](https://caddyserver.com) and a domain pointing at the server:

```bash
caddy reverse-proxy --from relay.example.com --to localhost:8790
```

Players then add `relay.example.com`. Or let the relay do TLS itself:
`node relay.js --port 443 --cert fullchain.pem --key privkey.pem`.

To keep it running on Linux, a systemd unit such as:

```ini
[Unit]
Description=Davorid relay
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/davorid-relay/relay.js --port 8790
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
```

## Your own PC

In the game: *Multiplayer > Relays... > Run a Relay Here*. The game asks your
router to forward the relay's TCP port (UPnP) and shows the address to give
friends. It stays on in later runs until you stop it. Without the game's
window:

```powershell
powershell -ExecutionPolicy Bypass -File tools\relay_server.ps1
```

This works when your router forwards the port and your provider gives you a
real public address. If the game says your provider or a second router
blocks the way in, only your own network can use it; a cloud relay is the
way out.

## What the relay sees and keeps

Nothing is stored. It holds the list of games open right now (host name,
map, mode, head count, game version, code) and passes the game's packets
between each host and its players without looking into them. It caps games
(200), players per game (32), message size (1 MB) and traffic per player
(4 MB/s), and drops sockets that go quiet. Pages: `/` (status), `/games`
(the public list as JSON), `/health`.

The wire format is documented at the top of
`game/scripts/net/relay_protocol.gd`.
