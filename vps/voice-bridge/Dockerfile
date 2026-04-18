# ---- Build stage: install all deps (incl. dev), compile TS → JS, then prune ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage: minimal, non-root, with HEALTHCHECK ----
FROM node:22-alpine AS runtime
WORKDIR /app

# Run as a non-root user. The upstream node image ships a `node` user (uid 1000); use it
# so the bridge cannot write to /, install signal-handling tools, or mount host volumes
# owned by root even if the container is compromised.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./

ENV NODE_ENV=production \
    VOICE_BRIDGE_PORT=8090

USER node

EXPOSE 8090

# Liveness: the bridge serves plain-text 200 OK on GET /. Built-in HEALTHCHECK gives
# `docker ps` and restart policies useful signal even without an external orchestrator.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${VOICE_BRIDGE_PORT:-8090}/ > /dev/null || exit 1

CMD ["node", "dist/index.js"]
