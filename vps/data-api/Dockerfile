# Residency data-api image. Slim runtime, same pattern as the chat-worker:
# no build step, just `node server.mjs` against a small ESM script.
FROM node:22-alpine

WORKDIR /app

# Deps layer only invalidates when package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs ./

# Unprivileged user; the container talks only to the compose-network
# Postgres and answers loopback HTTP from cloudflared.
USER node

CMD ["node", "server.mjs"]
