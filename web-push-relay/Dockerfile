FROM node:22.22.0-alpine3.23

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
CMD ["node", "src/server.js"]
