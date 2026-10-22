# ==========================================
# Service Front — image publiée sur GHCR
# Build depuis la racine : docker build -f front/Dockerfile .
# ==========================================

# ------------------------------------------
# Stage 1: Build Vite (dépendances du workspace front uniquement)
# Fichiers statiques indépendants de l'architecture : construits sur la plateforme native du runner
# (pas d'émulation QEMU en CI multi-plateforme)
# ------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY front/package.json front/

RUN npm ci --workspace=front --include-workspace-root=false

COPY front/ front/

RUN npm run build --workspace=front

# ------------------------------------------
# Stage 2: nginx non-root (port 8080) : fichiers statiques + relais /api vers la passerelle
# ------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runner

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="epsi-pay-front" \
      org.opencontainers.image.description="EPSI Pay — interface web (React) servie par nginx" \
      org.opencontainers.image.source="https://github.com/RESILIENCE-ALPHA/epsi_payment" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# Compose : passerelle "api" et DNS Docker. Kubernetes : nom complet du Service et kube-dns
ENV API_UPSTREAM=http://api:3000 \
    NGINX_RESOLVER=127.0.0.11 \
    NGINX_ENVSUBST_FILTER="^(API_UPSTREAM|NGINX_RESOLVER)$"

COPY front/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /app/front/dist /usr/share/nginx/html

EXPOSE 8080

# -Y off : la sonde locale ne doit jamais passer par un proxy HTTP hérité de l'environnement
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -Y off -O /dev/null http://127.0.0.1:8080/healthz || exit 1
