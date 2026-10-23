# 🌐 Service API — EPSI Pay

Ce répertoire héberge le service HTTP central de la plateforme **EPSI Pay** dans le cadre du projet **RESILIENCE-ALPHA**.
Il est développé selon les principes du **Clean Code** et de la responsabilité unique (**SRP** - Single Responsibility Principle).

---

## 🏗️ Architecture & Découpage

```
api/
├── src/
│   ├── app.ts            # Configuration Express, middlewares et routes (testable isolément)
│   ├── server.ts         # Cycle de vie HTTP, écoute réseau et Graceful Shutdown
│   ├── serviceProxy.ts   # Passerelle vers les services internes (timeout, 503/504)
│   ├── swagger.ts        # Spécification OpenAPI de la passerelle
│   └── __tests__/        # Tests d'intégration et de résilience (Vitest + Supertest)
│       ├── api.test.ts
│       └── serviceProxy.test.ts
├── Dockerfile            # Image multi-stage Node 22 Alpine (sécurisée non-root)
└── README.md
```

### Principes Clean Code appliqués
- **Séparation App vs Server** : `app.ts` instancie et configure Express sans ouvrir de socket réseau. Cela permet d'exécuter l'intégralité de la suite de tests en mémoire sans conflit de port.
- **Cycle de vie & Arrêt gracieux (Graceful Shutdown)** : `server.ts` intercepte les signaux `SIGTERM` et `SIGINT` (émis par Kubernetes et Docker Compose), stoppe la réception de nouvelles requêtes, libère le pool de connexions Prisma et s'arrête proprement.
- **Résilience** : La sonde `/health` interroge la base de données. Si la base est injoignable, l'API répond un statut HTTP `503 Service Unavailable` avec un rapport d'état dégradé sans faire crasher le processus Node.js.
- **Passerelle (API Gateway)** : seules les routes déclarées dans une **liste blanche** (`AUTH_PUBLIC_ROUTES`, `PAYMENT_PUBLIC_ROUTES` dans `app.ts`) sont relayées vers les services (`AUTH_SERVICE_URL`, défaut `http://localhost:3001`). L'IP cliente est transmise via `X-Forwarded-For`. Si un service est injoignable, la passerelle répond `503 SERVICE_UNAVAILABLE` ; au-delà de `UPSTREAM_TIMEOUT_MS` (défaut 5000 ms), `504 GATEWAY_TIMEOUT`. Les autres routes restent disponibles.

---

## 📡 Endpoints Disponibles

| Méthode | Route | Description | Statut nominal | Statut dégradé |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/` | Métadonnées du service (nom, statut, version, timestamp) | `200 OK` | - |
| `GET` | `/health` | Sonde de santé applicative & vérification connectivité PostgreSQL | `200 OK` | `503 Service Unavailable` |
| `POST` | `/auth/login` | Relayé vers le service auth | Réponse du service | `503` / `504` |
| `POST` | `/auth/logout` | Relayé vers le service auth | Réponse du service | `503` / `504` |
| `GET` | `/auth/me` | Relayé vers le service auth | Réponse du service | `503` / `504` |
| `GET` | `/wallets`, `/wallets/:id` | Relayé vers le service payment | Réponse du service | `503` / `504` |
| `POST` | `/payments` | Relayé vers le service payment | Réponse du service | `503` / `504` |
| `GET` | `/payments/:id` | Relayé vers le service payment | Réponse du service | `503` / `504` |
| `GET` | `/docs` | Swagger UI agrégé (passerelle, auth, payment), si `ENABLE_DOCS` | `200 OK` | - |
| `GET` | `/docs/specs/{auth,payment}.json` | Spec d'un service, récupérée côté serveur sur le réseau interne, si `ENABLE_DOCS` | `200 OK` | `503` |

Toute autre route d'un service (sondes, routes internes ou inter-services, futures routes non déclarées) répond `404` via la passerelle. Pour exposer une nouvelle route, l'ajouter explicitement à la liste blanche du service (segments `:param` acceptés, ex: `/payments/:id`).

### Exposition selon l'environnement

| Variable | Défaut | Effet |
| :--- | :--- | :--- |
| `ENABLE_DOCS` | `true` hors production, `false` si `NODE_ENV=production` | Expose `/docs`, `/docs.json` et `/docs/specs/*.json` |
| `AUTH_SERVICE_URL` / `PAYMENT_SERVICE_URL` | `http://localhost:3001` / `:3002` | Adresses internes des services |
| `NODE_ENV=production` | - | `/health` n'inclut plus le message d'erreur PostgreSQL (il reste dans les logs) |
| `TRUST_PROXY` | `0` | Proxys de confiance **devant** la passerelle : `1` en Compose (nginx du front), `2` en Kubernetes (Ingress + nginx du front). La passerelle résout l'IP cliente et la transmet **seule** dans `X-Forwarded-For` aux services : une IP forgée par le client n'est jamais relayée |

### Exemple de réponse `GET /`
```json
{
  "service": "epsi-pay-api",
  "status": "operational",
  "version": "1.0.0",
  "description": "Plateforme de paiement résiliente - Project RESILIENCE-ALPHA",
  "timestamp": "2026-10-20T10:50:00.000Z"
}
```

### Exemple de réponse `GET /health` (Opérationnel)
```json
{
  "status": "healthy",
  "uptime": 42.15,
  "timestamp": "2026-10-20T10:50:00.000Z",
  "checks": {
    "database": "up"
  }
}
```

### Exemple de réponse `GET /health` (Dégradé si DB coupée)
```json
{
  "status": "degraded",
  "uptime": 42.15,
  "timestamp": "2026-10-20T10:50:00.000Z",
  "checks": {
    "database": "down",
    "error": "Connection refused to postgres:5432"
  }
}
```

---

## 🧪 Tests

Les tests automatisés sont propulsés par **Vitest** et **Supertest** :

```bash
# Exécution de la suite de tests de l'API
npm run test:api

# Exécution de tous les tests du projet
npm test
```

---

## 🐳 Conteneurisation & Déploiement

### Construction de l'image Docker locale
```bash
docker build -t epsi-pay-api -f api/Dockerfile .
```

### Démarrage avec Docker Compose
Le service `api` est directement intégré à l'orchestration Docker Compose :
```bash
docker compose up -d --build
```
L'API démarre automatiquement une fois la base de données PostgreSQL prête et déclarée *healthy*.
