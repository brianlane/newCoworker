# Optional AiFlow render service (headless Chromium). Deploy only when SPA lead
# pages need JS rendering; otherwise the worker's static fetch is sufficient.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
