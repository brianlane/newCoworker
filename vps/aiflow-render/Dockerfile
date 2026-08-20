# AiFlow render service (headless Chromium). Deploy when lead pages are JS SPAs
# or login-gated; otherwise the worker's static fetch is sufficient.
#
# The base image tag MUST match the Playwright version pinned in package-lock.json
# (currently 1.62.0) so the bundled browsers match the installed library. A
# mismatch is the classic "Executable doesn't exist" container failure, and it
# is LATENT: nothing breaks until the next rebuild, which can be weeks after the
# bump that caused it. It has now bitten twice, PR #226 and again when
# Dependabot #1005 moved playwright 1.61.0 -> 1.62.0 here without touching this
# line. Bump BOTH in the same PR, or the next redeploy takes the sidecar down.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# EVERY .mjs the service imports must be listed here. The build context has the
# whole directory, so a missing name fails at RUNTIME with ERR_MODULE_NOT_FOUND
# and the container never binds 8080, taking the tenant's browse steps down.
# That is exactly what happened on 2026-08-17 when login.mjs was split out of
# server.mjs and this line was not updated: the file rsynced to the box fine and
# was simply absent from the image.
COPY server.mjs actions.mjs login.mjs demo.mjs ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
