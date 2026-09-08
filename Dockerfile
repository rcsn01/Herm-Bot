# syntax=docker/dockerfile:1.7
FROM node:22.22.0-alpine3.23 AS build

WORKDIR /workspace/apps/mobile/client

# Keep dependency installation cacheable. The mobile lockfile contains the
# local file:../../shared dependency, so that package must exist for npm ci.
COPY apps/mobile/client/package.json apps/mobile/client/package-lock.json ./
COPY apps/shared/package.json /workspace/apps/shared/package.json
COPY apps/shared/src /workspace/apps/shared/src
COPY apps/shared/tsconfig.json /workspace/apps/shared/tsconfig.json
RUN npm ci

COPY apps/mobile/client/index.html apps/mobile/client/tsconfig.json apps/mobile/client/vite.config.ts apps/mobile/client/capacitor.config.ts ./
COPY apps/mobile/client/src ./src
COPY apps/mobile/client/public ./public

# Mobile imports these shared desktop types and UI primitives directly. Keep
# this list deliberately narrow rather than copying the desktop application.
COPY apps/desktop/src/types/hermes.ts /workspace/apps/desktop/src/types/hermes.ts
COPY apps/desktop/src/components/ui/badge.tsx \
     apps/desktop/src/components/ui/button.tsx \
     apps/desktop/src/components/ui/codicon.tsx \
     apps/desktop/src/components/ui/control.ts \
     apps/desktop/src/components/ui/empty-state.tsx \
     apps/desktop/src/components/ui/input.tsx \
     apps/desktop/src/components/ui/scroll-area.tsx \
     apps/desktop/src/components/ui/separator.tsx \
     apps/desktop/src/components/ui/skeleton.tsx \
     apps/desktop/src/components/ui/switch.tsx \
     apps/desktop/src/components/ui/tabs.tsx \
     apps/desktop/src/components/ui/textarea.tsx \
     /workspace/apps/desktop/src/components/ui/
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28.0-alpine3.21
COPY apps/mobile/deploy/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=755 apps/mobile/deploy/hermes-gateway.sh /usr/local/bin/hermes-gateway.sh
COPY --chmod=755 apps/mobile/deploy/docker-entrypoint.sh /usr/local/bin/hermes-mobile-entrypoint.sh
COPY --from=build /workspace/apps/mobile/client/dist /usr/share/nginx/html
EXPOSE 8080
# Replacing ENTRYPOINT clears the base image CMD; nginx must stay in the
# foreground or the container exits 0 and Compose restarts it forever.
CMD ["nginx", "-g", "daemon off;"]
ENTRYPOINT ["/usr/local/bin/hermes-mobile-entrypoint.sh"]
