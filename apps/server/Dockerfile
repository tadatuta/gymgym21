FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json

RUN npm ci

COPY apps/server apps/server

RUN npm run build --workspace @gym21/server

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/server /app/apps/server

WORKDIR /app/apps/server

EXPOSE 8788

CMD ["node", "dist/server.js"]
