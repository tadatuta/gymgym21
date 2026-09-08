FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json

COPY packages/contracts/package.json packages/contracts/package.json

RUN npm ci

COPY packages/contracts packages/contracts
COPY apps/server apps/server

RUN npm run build --workspace @gym21/server

# Install only the selected runtime workspaces from the unchanged lockfile.
# Omit optional dev peers (e.g. Vite → tsx) as well as regular dev dependencies.
FROM node:22-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --omit=optional --workspace @gym21/server --workspace @gym21/contracts --include-workspace-root=false \
    && mkdir -p apps/server/node_modules packages/contracts/node_modules

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
# npm may place overridden/conflicting versions inside a workspace.
COPY --from=production-dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=production-dependencies /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY apps/server/migrations ./apps/server/migrations
COPY apps/server/docker-start.mjs ./apps/server/docker-start.mjs
WORKDIR /app/apps/server
USER node
EXPOSE 8788
CMD ["node", "dist/server.js"]
