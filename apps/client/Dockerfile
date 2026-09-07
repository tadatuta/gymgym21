FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json

COPY packages/contracts/package.json packages/contracts/package.json

RUN npm ci

COPY packages/contracts packages/contracts
COPY apps/client apps/client

RUN npm run build --workspace @gym21/client

FROM nginx:1.27-alpine

COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
