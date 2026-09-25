FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY index.html vite.config.js ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG RELEASE_VERSION=development
ARG RELEASE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/dashpay/status" \
      org.opencontainers.image.version=$RELEASE_VERSION \
      org.opencontainers.image.revision=$RELEASE_REVISION
WORKDIR /app
ENV NODE_ENV=production PORT=3001 BIND_ADDRESS=0.0.0.0
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/dist ./dist/
COPY server/ ./server/
RUN mkdir -p /var/lib/dash-status && chown node:node /var/lib/dash-status
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
