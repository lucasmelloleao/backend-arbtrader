# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Produção
FROM node:20-slim
WORKDIR /app

RUN npm install -g pm2

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copia os artefatos compilados do builder
COPY --from=builder /app/dist ./dist
# Copia arquivos proto para cTrader Open API
COPY --from=builder /app/src/strategy/forex/ctrader/proto ./dist/strategy/forex/ctrader/proto
# Copia scripts, configs e secrets
COPY scripts/ ./scripts/
COPY docs/ ./docs/
COPY ecosystem*.js ./
COPY secrets.enc* ./

ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4002) + '/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
STOPSIGNAL SIGINT

CMD ["pm2-runtime", "ecosystem.config.js"]

