# EPSI Pay — Plateforme de Paiement Résiliente (PROJECT RESILIENCE-ALPHA)

Application de paiement conçue pour démontrer la haute résilience, la détection d'anomalies par Machine Learning et la remédiation autonome face à des cyberattaques.

---

## 🏗️ Architecture du Projet

Le projet est structuré en services découplés à la racine, orchestrés par un Docker Compose unique :

```
epsi_pay/
├── docker-compose.yml       # Orchestration locale (PostgreSQL 15, db-init, Auth, Payment, API, Front)
├── package.json             # Scripts de développement et commandes DB
│
├── database/                # 🗄️ Service Persistance & Données
│   ├── prisma/              # Schéma Prisma & scripts de Seed
│   └── README.md            # 📖 Dictionnaire de Données Officiel (Complet)
│
├── auth/                    # 🛡️ Service Authentification & Sessions
│   └── README.md            # Cible de l'attaque Brute Force (PC Attaquant)
│
├── payment/                 # 💳 Service Paiements & Portefeuilles
│   └── README.md            # Exécution du test de reprise post-remédiation
│
├── api/                     # 🌐 Passerelle (seule frontière de confiance, résout l'IP cliente)
│
├── front/                   # 🖥️ Interface web React (nginx : SPA + relais /api)
│   └── README.md            # Écrans, charte, déploiement
│
└── k8s/                     # ☸️ Déploiement minikube des images GHCR + exposition réseau
    └── README.md            # Guide pas à pas
```

Chemin d'une requête : `navigateur → front (nginx, :8080) → api (passerelle) → auth / payment → PostgreSQL`.

---

## ▶️ Démarrer la plateforme complète

```bash
cp .env.example .env          # puis renseigner les secrets
docker compose up -d --build
```

- Interface : **http://localhost:8080** (point d'entrée public)
- Passerelle et Swagger : http://localhost:3000/docs (machine locale uniquement)

Sur Kubernetes (minikube), avec les images publiées par la CI : voir [`k8s/README.md`](./k8s/README.md).

---

## 🔁 CI / Images Docker (GHCR)

Workflow : [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

| Événement | Ce qui tourne |
|---|---|
| Pull request | Build, tests unitaires, tests d'intégration payment (PostgreSQL 15), build des 5 images **sans publication** |
| Push sur `master` ou `RELEASE/**` | Idem, puis publication des images sur GHCR |
| Tag `vX.Y.Z` | Publication avec les tags de version |

Images : `ghcr.io/resilience-alpha/epsi-pay-{db-init,auth,api,payment,front}`.

| Tag | Exemple | Usage |
|---|---|---|
| `sha-<commit>` | `sha-0d1f69f` | Immuable : à privilégier en Kubernetes |
| nom de branche | `RELEASE-1.0`, `master` | Dernier build de la branche |
| `latest` | | Dernier build de `master` |
| version | `1.0.0`, `1.0` | Depuis un tag `v1.0.0` |

Récupérer une image publiée en local : `IMAGE_TAG=sha-0d1f69f docker compose pull`.

Les packages GHCR sont **privés** à leur création. Pour Kubernetes, deux options :
les rendre publics (GitHub → Packages → *Package settings*), ou créer un `imagePullSecret`
avec un token `read:packages`.

---

## 🛠️ Stack Technique

- **Runtime** : Node.js 22 LTS (via `.nvmrc`)
- **Langage** : TypeScript 5+
- **SGBD** : PostgreSQL 15 (Docker)
- **ORM** : Prisma ORM v6

---

## 📖 Dictionnaire de Données

Le **dictionnaire de données complet** avec toutes les tables, colonnes, contraintes, rôles dans l'attaque brute force et conformités (NIS2 / DORA) est consultable directement dans :
👉 [**Consulter le Dictionnaire de Données (`database/README.md`)**](./database/README.md)

---

## 🚀 Commandes Rapides

### ⚡ Initialisation en une seule commande (Recommandé)
Lance PostgreSQL 15, applique le schéma Prisma et injecte les **10 000+ données** immédiatement :
```bash
npm run db:setup
```

---

### Commandes détaillées pas-à-pas :

1. **Démarrer PostgreSQL 15 (Docker) :**
   ```bash
   npm run db:up
   ```

2. **Appliquer les migrations Prisma :**
   ```bash
   npm run prisma:deploy
   ```

3. **Générer le jeu de données massif (10k entrées) :**
   ```bash
   npm run db:seed:10k
   ```
   *(Ou `npm run db:seed` pour le jeu de données minimal de 3 comptes). ⚠️ Ces scripts effacent les données existantes.*

### 4. Visualiser les données (Prisma Studio)
```bash
npm run prisma:studio
```
Accédez à l'interface sur `http://localhost:5555`.

### 5. Arrêter la base de données
```bash
npm run db:down
```
