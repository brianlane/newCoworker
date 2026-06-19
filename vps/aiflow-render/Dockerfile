# AiFlow render service (headless Chromium). Deploy when lead pages are JS SPAs
# or login-gated; otherwise the worker's static fetch is sufficient.
#
# The base image tag MUST match the Playwright version pinned in package-lock.json
# (currently 1.61.0) so the bundled browsers match the installed library — a
# mismatch is the classic "Executable doesn't exist" container failure.
FROM mcr.microsoft.com/playwright:v1.61.0-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
