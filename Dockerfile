FROM oven/bun:1 AS deps

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    ND_SERVE_HOST=0.0.0.0 \
    ND_SERVE_PORT=8788 \
    ND_DATA_DIR=/data \
    ND_MIGRATIONS_DIR=/app/migrations

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY bin ./bin
COPY functions ./functions
COPY migrations ./migrations
COPY shared ./shared
COPY src ./src

RUN mkdir -p /data

EXPOSE 8788
VOLUME ["/data"]

CMD ["bun", "run", "nd", "--", "serve", "--host", "0.0.0.0", "--port", "8788", "--data-dir", "/data", "--migrations-dir", "/app/migrations"]
