# AiFlow render service (headless Chromium). Deploy when lead pages are JS SPAs
# or login-gated; otherwise the worker's static fetch is sufficient.
#
# The Playwright base image ships the OS deps; we install the exact Playwright
# version from the lockfile and its matching Chromium so the two never drift.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install chromium
COPY server.mjs ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
