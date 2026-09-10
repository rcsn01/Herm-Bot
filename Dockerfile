# syntax=docker/dockerfile:1.7
FROM node:22.22.0-alpine3.23 AS build

WORKDIR /workspace/client

# Keep dependency installation cacheable. The standalone repository owns the
# compatibility modules used by the client, so no Hermes checkout is needed.
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/index.html client/tsconfig.json client/vite.config.ts client/capacitor.config.ts ./
COPY client/src ./src
COPY client/public ./public
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28.0-alpine3.21
COPY --chmod=644 deploy/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=755 deploy/hermes-gateway.sh /usr/local/bin/hermes-gateway.sh
COPY --chmod=755 deploy/docker-entrypoint.sh /usr/local/bin/hermes-mobile-entrypoint.sh
COPY --from=build /workspace/client/dist /usr/share/nginx/html
EXPOSE 8080
# Replacing ENTRYPOINT clears the base image CMD; nginx must stay in the
# foreground or the container exits 0 and Compose restarts it forever.
CMD ["nginx", "-g", "daemon off;"]
ENTRYPOINT ["/usr/local/bin/hermes-mobile-entrypoint.sh"]
