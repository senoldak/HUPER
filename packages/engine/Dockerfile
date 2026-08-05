FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/engine/package.json packages/engine/
RUN npm install --workspaces

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @huper/core && npm run build -w @huper/engine

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
EXPOSE 3001
CMD ["npx", "tsx", "packages/engine/src/index.ts"]
