# Per-tenant chat-worker image. Slim runtime: no app build step, just
# `node worker.mjs` against a small ESM script. Image size ~70 MB on
# disk, ~30 MB compressed — fine to pull on every VPS deploy.

FROM node:20-alpine

WORKDIR /app

# Install deps in a layer that only invalidates when package*.json
# changes; the worker source itself is the next layer so editing
# worker.mjs doesn't re-run npm install.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY worker.mjs ./

# Run as the unprivileged `node` user that comes with the base image.
# The container talks only to: localhost (Rowboat over the rowboat_default
# Docker network) and Supabase (HTTPS). It does not need root.
USER node

# Worker stays in the foreground, structured-logs to stdout, and is
# orchestrated by docker-compose's `restart: unless-stopped` policy.
# SIGTERM-driven graceful shutdown is implemented in worker.mjs.
CMD ["node", "worker.mjs"]
