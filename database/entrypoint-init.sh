#!/bin/sh
set -e

echo "[ENTRYPOINT] Démarrage du conteneur d'initialisation de la base de données EPSI Pay..."

if [ -f "dist/init.js" ]; then
  exec node dist/init.js "$@"
else
  exec npx tsx init.ts "$@"
fi
