# dashnet CLI from dash-network-go, pinned by ref at build time.
FROM golang:1.27-bookworm AS dashnet
ARG DASHNET_REF=main
RUN git clone --quiet https://github.com/dashpay/dash-network-go /src \
 && cd /src && git checkout --quiet "$DASHNET_REF" \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$(git rev-parse HEAD)" -o /dashnet ./cmd/dashnet \
 && /dashnet version

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY index.html vite.config.js ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG RELEASE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/dashpay/status" \
      org.opencontainers.image.revision=$RELEASE_REVISION
WORKDIR /app
ENV NODE_ENV=production PORT=3001 BIND_ADDRESS=0.0.0.0 STATUS_REVISION=$RELEASE_REVISION
COPY --from=dashnet /dashnet /usr/local/bin/dashnet
COPY --from=dashnet /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/dist ./dist/
COPY server/ ./server/
COPY shared/ ./shared/
COPY agent/ ./agent/
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(process.env.STATUS_MODE==='agent'?0:1))"
CMD ["node", "server/index.js"]
