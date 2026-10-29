# Davorid relay in a container (any host that runs Docker images).
#   docker build -t davorid-relay .
#   docker run -p 8790:8790 davorid-relay
FROM node:22-alpine
WORKDIR /app
COPY package.json relay.js ./
ENV PORT=8790
EXPOSE 8790
USER node
CMD ["node", "relay.js"]
