#!/usr/bin/env bash
# Rend le front de minikube accessible depuis le réseau (et Internet via la box) sur EDGE_PORT.
#
#   visiteur → nginx local :EDGE_PORT (vraie IP) → tunnel kubectl :TUNNEL_PORT → Service front → api …
#
# Usage : ./k8s/expose.sh            (Ctrl+C pour tout arrêter)
#         EDGE_PORT=8081 ./k8s/expose.sh
set -euo pipefail

EDGE_PORT="${EDGE_PORT:-8080}"
TUNNEL_PORT="${TUNNEL_PORT:-18080}"
NAMESPACE="${NAMESPACE:-epsi-pay}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${TMPDIR:-/tmp}/epsi-pay-edge"

command -v nginx >/dev/null || { echo "nginx introuvable : brew install nginx" >&2; exit 1; }
kubectl -n "$NAMESPACE" get svc front >/dev/null || { echo "Service front absent : kubectl apply -k k8s/" >&2; exit 1; }

mkdir -p "$RUN_DIR/tmp"
sed -e "s/__EDGE_PORT__/$EDGE_PORT/" -e "s/__TUNNEL_PORT__/$TUNNEL_PORT/" \
  "$SCRIPT_DIR/edge/nginx.conf.template" > "$RUN_DIR/nginx.conf"
nginx -t -q -p "$RUN_DIR" -c "$RUN_DIR/nginx.conf"

cleanup() {
  # Arrêt au mieux : une étape en échec ne doit pas empêcher les suivantes
  set +e
  trap - EXIT INT TERM
  echo
  echo "Arrêt du relais et du tunnel…"
  if [ -n "${TUNNEL_LOOP_PID:-}" ]; then
    kill "$TUNNEL_LOOP_PID" 2>/dev/null
    wait "$TUNNEL_LOOP_PID" 2>/dev/null
  fi
  nginx -p "$RUN_DIR" -c "$RUN_DIR/nginx.conf" -s quit 2>/dev/null
  pkill -f "port-forward .*svc/front ${TUNNEL_PORT}:8080" 2>/dev/null
}
trap cleanup EXIT
# Ctrl+C : arrêt normal (code 0) ; une autre erreur garde son code de sortie
trap 'cleanup; exit 0' INT TERM

# Tunnel vers le Service front, relancé automatiquement : port-forward s'arrête si le pod ciblé
# redémarre (mise à jour, crash), la boucle le rebranche sur un pod sain en une seconde.
(
  while true; do
    kubectl -n "$NAMESPACE" port-forward --address 127.0.0.1 svc/front "${TUNNEL_PORT}:8080" >/dev/null 2>&1 || true
    sleep 1
  done
) &
TUNNEL_LOOP_PID=$!

nginx -p "$RUN_DIR" -c "$RUN_DIR/nginx.conf" -g 'daemon off;' &
NGINX_PID=$!

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
echo "EPSI Pay exposé :"
echo "  - sur cette machine : http://localhost:${EDGE_PORT}"
[ -n "$LAN_IP" ] && echo "  - sur le réseau     : http://${LAN_IP}:${EDGE_PORT}  (cible de la redirection de port de la box)"

# Un autre programme peut écouter sur 127.0.0.1 seul (ex. Jenkins) : il répond alors à localhost à notre place
sleep 1
if lsof -nP -iTCP@127.0.0.1:"$EDGE_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 && $1 != "nginx"' | grep -q .; then
  echo "  ⚠ localhost:${EDGE_PORT} est aussi occupé par un autre programme : utilisez l'adresse réseau ci-dessus."
fi
echo "Ctrl+C pour arrêter."

wait "$NGINX_PID"
