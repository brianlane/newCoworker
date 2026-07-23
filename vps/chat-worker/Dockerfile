# Per-tenant chat-worker image. Slim runtime: no app build step, just
# `node worker.mjs` against a small ESM script. Image size ~70 MB on
# disk, ~30 MB compressed — fine to pull on every VPS deploy.
#
# Node 24 (was 22, was 20): @supabase/supabase-js >= 2.108 bundles a
# realtime-js that hard-throws at createClient() on Node < 22 ("Node.js 20
# detected without native WebSocket support"), and the knowledge-graph
# compile (graph-db-build.mjs) uses node:sqlite, which is stable on 24.
# Matches the repo-wide Node 24 runtime (CI + Vercel, PR #830). Keep this
# >= the engines floor in package.json.
FROM node:24-alpine

WORKDIR /app

# Install deps in a layer that only invalidates when package*.json
# changes; the worker source itself is the next layer so editing
# worker.mjs doesn't re-run npm install.
#
# npm ci requires a committed package-lock.json — if the build fails
# here with "lockfile not found", regenerate it from the repo root via
# `cd vps/chat-worker && npm install --package-lock-only` and commit
# the result.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY worker.mjs memory-capture.mjs email-tool.mjs graph-db-build.mjs ./

# Run as the unprivileged `node` user that comes with the base image.
# The container talks only to: localhost (Rowboat over the rowboat_default
# Docker network) and Supabase (HTTPS). It does not need root.
USER node

# Worker stays in the foreground, structured-logs to stdout, and is
# orchestrated by docker-compose's `restart: unless-stopped` policy.
# SIGTERM-driven graceful shutdown is implemented in worker.mjs.
CMD ["node", "worker.mjs"]
