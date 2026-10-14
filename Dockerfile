FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV ELYTRA_SEED_DEMO=false
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    ELYTRA_DB_PATH=/app/data/elytra.db \
    ELYTRA_UPLOAD_DIR=/app/data/uploads \
    ELYTRA_SEED_DEMO=false
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
RUN mkdir -p /app/data /app/.next/cache && chown -R node:node /app/data /app/.next/cache
USER node
EXPOSE 3000
CMD ["node", "server.js"]
