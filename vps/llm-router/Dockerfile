FROM node:22-alpine

WORKDIR /app

# No external dependencies - uses Node 22's built-in fetch. Copy package.json
# just so `npm start` works with the declared `type: module` context.
COPY package.json ./
COPY src ./src

# Unprivileged user; matches the base image's `node` user.
USER node

EXPOSE 11435

CMD ["node", "src/index.js"]
