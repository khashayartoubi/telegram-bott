FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY video ./video

ENV NODE_ENV=production

CMD ["node", "src/bot.js"]
