# Residency data-api image. Slim runtime, same pattern as the chat-worker:
# no build step, just `node server.mjs` against a small ESM script.
FROM node:22-alpine

WORKDIR /app

# Deps layer only invalidates when package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Named files, not the directory. A module server.mjs imports but this line
# does not copy is INVISIBLE until a redeploy: the file rsyncs to the box
# fine, the image simply lacks it, and the container dies with
# ERR_MODULE_NOT_FOUND. That took a tenant's render sidecar offline on
# 2026-08-17; tests/vps-dockerfile-copies-imports.test.ts now guards both.
COPY server.mjs filters.mjs ./

# Unprivileged user; the container talks only to the compose-network
# Postgres and answers loopback HTTP from cloudflared.
USER node

CMD ["node", "server.mjs"]
