# ==========================================
# Service API (passerelle) — image publiée sur GHCR
# Build depuis la racine : docker build -f api/Dockerfile .
# ==========================================

# ------------------------------------------
# Stage 1: Install & Build
# ------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copie des manifestes workspace (api dépend de database)
COPY package.json package-lock.json ./
COPY database/package.json database/
COPY api/package.json api/

RUN npm ci --workspace=api --workspace=database --include-workspace-root

COPY database/ database/
COPY api/ api/

RUN npx prisma generate --schema=database/prisma/schema.prisma

# Compilation TypeScript dans l'ordre des dépendances : database -> api
RUN npm run build --workspace=database \
    && npm run build --workspace=api

# ------------------------------------------
# Stage 2: Runtime allégé
# ------------------------------------------
FROM node:22-alpine AS runner

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="epsi-pay-api" \
      org.opencontainers.image.description="EPSI Pay — passerelle API (santé, routage vers les services)" \
      org.opencontainers.image.source="https://github.com/RESILIENCE-ALPHA/epsi_payment" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY package.json package-lock.json ./
COPY database/package.json database/
COPY api/package.json api/
RUN npm ci --workspace=api --workspace=database --include-workspace-root --omit=dev \
    && npm cache clean --force

COPY --from=builder /app/database/dist database/dist
COPY --from=builder /app/api/dist api/dist
COPY --from=builder /app/node_modules/.prisma node_modules/.prisma
COPY --from=builder /app/database/prisma/schema.prisma database/prisma/schema.prisma

USER node

EXPOSE 3000

# Sonde locale (Compose) ; Kubernetes utilise ses propres liveness/readiness probes sur /health
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api/dist/src/server.js"]
