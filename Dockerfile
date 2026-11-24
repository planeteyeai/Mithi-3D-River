# Full-stack Mithi on Render (SPA + history API + JalNetra/RiverEye proxies)
FROM node:20-alpine AS builder

WORKDIR /app

# Root (Vite) deps
COPY package*.json ./
RUN npm ci --ignore-scripts

# Server deps
COPY server/package*.json ./server/
RUN npm --prefix server ci --ignore-scripts

# Source + build frontend (Vite inlines VITE_* at build time)
COPY . .

ARG VITE_HISTORY_API_BASE=/api/history
ARG VITE_JALNETRA_API_BASE=/jalnetra-api
ARG VITE_RIVEREYE_API=/rivereye-api
ARG VITE_RIVEREYE_ASSET_BASE=
ARG VITE_ANALYTICS_API_BASE=
ARG VITE_BOD_COD_VIEWER_ID=

ENV VITE_HISTORY_API_BASE=$VITE_HISTORY_API_BASE \
    VITE_JALNETRA_API_BASE=$VITE_JALNETRA_API_BASE \
    VITE_RIVEREYE_API=$VITE_RIVEREYE_API \
    VITE_RIVEREYE_ASSET_BASE=$VITE_RIVEREYE_ASSET_BASE \
    VITE_ANALYTICS_API_BASE=$VITE_ANALYTICS_API_BASE \
    VITE_BOD_COD_VIEWER_ID=$VITE_BOD_COD_VIEWER_ID

RUN npm run build

# ---- runtime ----
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    SERVE_SPA=1 \
    MITHI_PROJECT_ID=mithi

WORKDIR /app/server

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-10000}/api/health" || exit 1

CMD ["node", "index.js"]
