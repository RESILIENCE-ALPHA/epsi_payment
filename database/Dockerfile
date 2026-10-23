# ==========================================
# Image d'initialisation BDD (Job / Migration)
# ==========================================

# ------------------------------------------
# Stage 1: Build (compilation TypeScript + génération Prisma)
# ------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copie des manifestes workspace
COPY package.json package-lock.json ./
COPY database/package.json database/

# Installation des dépendances (workspace database + racine)
RUN npm ci --workspace=database --include-workspace-root

# Copie des sources et génération du client Prisma
COPY database/ database/
RUN npx prisma generate --schema=database/prisma/schema.prisma

# Compilation TypeScript du package database
RUN npm run build --workspace=database

# ------------------------------------------
# Stage 2: Runtime
# ------------------------------------------
FROM node:22-alpine AS runner

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="epsi-pay-db-init" \
      org.opencontainers.image.description="EPSI Pay — initialisation du schéma et seed de la base PostgreSQL" \
      org.opencontainers.image.source="https://github.com/RESILIENCE-ALPHA/epsi_payment" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /app

ENV NODE_ENV=production

# Installation des dépendances (dev incluses : prisma CLI + tsx requis au runtime
# pour `prisma db push` et le seed)
COPY package.json package-lock.json ./
COPY database/package.json database/
RUN npm ci --workspace=database --include-workspace-root && npm cache clean --force

# Copie des artefacts compilés, du client Prisma généré et du schéma
COPY --from=builder /app/database/dist database/dist
COPY --from=builder /app/node_modules/.prisma node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma node_modules/@prisma
COPY database/prisma database/prisma
COPY database/entrypoint-init.sh database/entrypoint-init.sh

RUN chmod +x database/entrypoint-init.sh

# Le script d'entrée et init.ts résolvent leurs chemins relativement à database/
WORKDIR /app/database

ENTRYPOINT ["./entrypoint-init.sh"]
