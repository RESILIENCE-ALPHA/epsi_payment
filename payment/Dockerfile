# ==========================================
# Service Payment — image publiée sur GHCR
# Build depuis la racine : docker build -f payment/Dockerfile .
# ==========================================

# ------------------------------------------
# Stage 1: Base commune (toolchain pour compiler bcrypt + manifestes workspace)
# ------------------------------------------
FROM node:22-alpine AS base

WORKDIR /app

RUN apk add --no-cache python3 make g++

# payment dépend de auth (validation des sessions, blocage IP) et de database
COPY package.json package-lock.json ./
COPY database/package.json database/
COPY auth/package.json auth/
COPY payment/package.json payment/

# ------------------------------------------
# Stage 2: Dépendances de production uniquement
# ------------------------------------------
FROM base AS prod-deps

RUN npm ci --workspace=payment --workspace=auth --workspace=database --include-workspace-root --omit=dev \
    && npm cache clean --force

# ------------------------------------------
# Stage 3: Build (dépendances complètes + compilation)
# ------------------------------------------
FROM base AS builder

RUN npm ci --workspace=payment --workspace=auth --workspace=database --include-workspace-root

COPY database/ database/
COPY auth/ auth/
COPY payment/ payment/

RUN npx prisma generate --schema=database/prisma/schema.prisma

# Compilation TypeScript dans l'ordre des dépendances : database -> auth -> payment
RUN npm run build --workspace=database \
    && npm run build --workspace=auth \
    && npm run build --workspace=payment

# ------------------------------------------
# Stage 4: Runtime allégé (sans toolchain)
# ------------------------------------------
FROM node:22-alpine AS runner

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="epsi-pay-payment" \
      org.opencontainers.image.description="EPSI Pay — service de paiement (portefeuilles, paiements idempotents, validation post-incident)" \
      org.opencontainers.image.source="https://github.com/RESILIENCE-ALPHA/epsi_payment" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3002

COPY --from=prod-deps /app/package.json /app/package-lock.json ./
COPY --from=prod-deps /app/database/package.json database/
COPY --from=prod-deps /app/auth/package.json auth/
COPY --from=prod-deps /app/payment/package.json payment/
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=builder /app/node_modules/.prisma node_modules/.prisma
COPY --from=builder /app/database/dist database/dist
COPY --from=builder /app/auth/dist auth/dist
COPY --from=builder /app/payment/dist payment/dist
COPY --from=builder /app/database/prisma/schema.prisma database/prisma/schema.prisma

USER node

EXPOSE 3002

# Sonde locale (Compose) ; Kubernetes utilise ses propres liveness/readiness probes sur /health
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "payment/dist/src/server.js"]
