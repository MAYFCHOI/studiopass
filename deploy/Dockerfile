# Built on the host by scripts/deploy.sh (docker compose build). Context = repo root.
FROM node:22-bookworm-slim AS web
WORKDIR /w
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS srv
WORKDIR /w/server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
# shared/ compiles against the root package.json ("type": "module"); without it tsc emits CommonJS
COPY package.json ../package.json
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server ./
COPY shared ../shared
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 ca-certificates curl gzip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=srv /w/server/node_modules server/node_modules
COPY --from=srv /w/server/dist server/dist
COPY --from=srv /w/server/migrations server/migrations
COPY --from=srv /w/server/package.json server/package.json
COPY --from=web /w/dist web
ENV NODE_ENV=production SP_DB=/data/studiopass.db SP_STATIC=/app/web SP_MIGRATIONS=/app/server/migrations PORT=8787
USER node
EXPOSE 8787
CMD ["node", "server/dist/server/src/main.js"]
