# EPSI Pay sur Kubernetes (minikube)

Déploie les images publiées sur GHCR par la CI dans un cluster minikube local, puis expose
l'interface sur le réseau (et sur Internet via la redirection de port de la box).

```
visiteur ──► nginx local :8080 ──► tunnel kubectl ──► front ──► api ──► auth / payment ──► postgres
            (vraie IP du visiteur)                     └──────── cluster minikube (namespace epsi-pay) ────────┘
```

Pourquoi un nginx local ? Sur Mac, minikube n'est joignable que par un tunnel, qui fait apparaître
toutes les connexions comme venant de `127.0.0.1`. Bloquer l'attaquant bloquerait alors tout le
monde. Le nginx local voit la vraie IP du visiteur et la transmet dans `X-Forwarded-For`, comme
un Ingress (d'où `TRUST_PROXY=2` sur la passerelle).

## Contenu

| Fichier | Rôle |
|---|---|
| `kustomization.yaml` | Point d'entrée : namespace, secrets, tags des images |
| `postgres.yaml` | PostgreSQL 15 + volume persistant (2 Go) |
| `db-init.yaml` | Job : migrations Prisma + seed si la base est vide |
| `auth.yaml`, `api.yaml`, `payment.yaml`, `front.yaml` | Deployment + Service (ClusterIP) de chaque service |
| `secrets.example.env` | Modèle des mots de passe et jetons (copie locale `secrets.env`, ignorée par git) |
| `expose.sh`, `edge/` | Tunnel + nginx local pour l'exposition |

## Prérequis (une seule fois)

```bash
brew install minikube kubectl nginx
```

- Docker Desktop démarré, avec **au moins 4 Go de mémoire** (Settings → Resources).
- Un token GitHub pour lire les images privées : GitHub → Settings → Developer settings →
  Personal access tokens → *Tokens (classic)* → cocher **`read:packages`** uniquement.

## Pas à pas

### 1. Démarrer minikube

La stack Compose et minikube ne tiennent pas ensemble en mémoire : arrêter Compose d'abord.

```bash
docker compose stop
minikube start --driver=docker --memory=3000 --cpus=4
kubectl get nodes          # STATUS = Ready
```

### 2. Créer le namespace et l'accès à GHCR

```bash
kubectl apply -f k8s/namespace.yaml
kubectl -n epsi-pay create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<ton-pseudo-github> \
  --docker-password=<token-read:packages>
```

> Si les packages GHCR sont publics, cette étape est inutile.

### 3. Renseigner les secrets

```bash
cp k8s/secrets.example.env k8s/secrets.env
# Remplacer chaque CHANGE_ME par une valeur générée :
openssl rand -hex 32
```

`PAYMENT_INTERNAL_TOKEN` est à partager avec le moteur de remédiation.

### 4. Déployer

```bash
kubectl apply -k k8s/
kubectl -n epsi-pay wait --for=condition=complete job/db-init --timeout=300s
kubectl -n epsi-pay wait --for=condition=available deploy --all --timeout=300s
kubectl -n epsi-pay get pods
```

Tous les pods doivent être `Running` et `1/1`, `db-init` en `Completed`. Le premier déploiement
télécharge les images (quelques minutes).

### 5. Exposer l'interface

Dans un terminal dédié (Ctrl+C pour arrêter) :

```bash
./k8s/expose.sh
```

Le script affiche l'adresse réseau du Mac (ex. `http://192.168.1.20:8080`). C'est elle que la box
doit rediriger : règle de redirection **port externe → IP du Mac, port 8080**. Au premier lancement,
macOS demande d'autoriser nginx à accepter les connexions entrantes : accepter.

Port différent : `EDGE_PORT=8081 ./k8s/expose.sh`.

### 6. Vérifier

1. Ouvrir l'adresse affichée, se connecter avec `alice@epsi.fr` / `Password123!`, faire un paiement.
2. Vérifier que l'IP enregistrée est bien celle du visiteur :

   ```bash
   kubectl -n epsi-pay exec postgres-0 -- sh -c \
     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select \"ipAddress\", \"attemptedEmail\", \"createdAt\" from login_attempts order by \"createdAt\" desc limit 5"'
   ```

## Au quotidien

| Besoin | Commande |
|---|---|
| Récupérer les nouvelles images après un push (CI verte) | `kubectl -n epsi-pay rollout restart deploy` |
| Rejouer les migrations (nouvelle image db-init) | `kubectl -n epsi-pay delete job db-init --ignore-not-found && kubectl apply -k k8s/` |
| Figer une version | dans `kustomization.yaml`, `newTag: sha-<commit>`, puis `kubectl apply -k k8s/` |
| État des pods | `kubectl -n epsi-pay get pods` |
| Logs d'un service | `kubectl -n epsi-pay logs deploy/auth -f` |
| Swagger (machine locale) | `kubectl -n epsi-pay port-forward svc/api 3000:3000` puis http://localhost:3000/docs (si `ENABLE_DOCS=true`) |
| Accès SQL (Prisma Studio, outils ML) | `kubectl -n epsi-pay port-forward svc/postgres 5433:5432` puis `localhost:5433` |
| Réinitialiser les données de démo | voir ci-dessous |
| Mettre en pause | `minikube stop` (les données sont conservées) |
| Tout supprimer | `kubectl delete namespace epsi-pay` (données comprises) puis `minikube delete` |

Réinitialiser les données de démo (efface **tout**) :

```bash
kubectl -n epsi-pay delete job db-init --ignore-not-found
kubectl kustomize k8s/ \
  | sed -e 's/value: if-empty/value: reset/' -e '/name: ALLOW_DATA_RESET/{n;s/"false"/"true"/;}' \
  | kubectl apply -f -
kubectl -n epsi-pay wait --for=condition=complete job/db-init --timeout=300s
```

## Résilience

- Un pod qui plante est recréé automatiquement ; le tunnel d'`expose.sh` se rebranche en ~3 s.
- `/health` vérifie la base : si PostgreSQL tombe, les pods sortent du trafic (readiness) sans
  être redémarrés (la liveness ne teste que le port).
- Démonstration : `kubectl -n epsi-pay delete pod -l app=payment`, puis observer le bandeau
  « Paiements indisponibles » dans l'interface et son retrait automatique.

## Notes pour le déploiement Terraform

- `enableServiceLinks: false` est **obligatoire** : sinon Kubernetes injecte `AUTH_PORT=tcp://…`
  et `PAYMENT_PORT=tcp://…`, lus par le code comme port d'écoute (crash au démarrage).
- Passerelle : `TRUST_PROXY` = nombre de proxys devant elle (Ingress + nginx du front = 2).
  auth et payment : toujours `1`.
- Front : `API_UPSTREAM` en nom complet (`http://api.<ns>.svc.cluster.local:3000`),
  `NGINX_RESOLVER=kube-dns.kube-system.svc.cluster.local`.
- `TRUST_PROXY` doit être **exact** : une valeur trop haute laisse un attaquant forger son IP via
  `X-Forwarded-For`, une valeur trop basse fait voir à tous la même IP (celle d'un proxy).

## Dépannage

| Symptôme | Cause / solution |
|---|---|
| `ImagePullBackOff` | Secret `ghcr-pull` absent ou token sans `read:packages` ; vérifier avec `kubectl -n epsi-pay describe pod <pod>` |
| `exec format error` | Image publiée sans arm64 : vérifier que la CI multi-architecture est passée |
| `minikube start` échoue sur `nodes "minikube" not found` | Proxy Docker Desktop : ajouter `192.168.49.0/24,10.96.0.0/12,10.244.0.0/16,.svc,.cluster.local,control-plane.minikube.internal` au `noProxy` de `~/.docker/config.json`, puis `minikube delete && minikube start …` |
| `localhost:8080` affiche une autre application | Un autre programme écoute sur `127.0.0.1:8080` : utiliser l'adresse réseau affichée, ou `EDGE_PORT=8081` |
| Tous les visiteurs bloqués ensemble | L'exposition ne passe pas par `expose.sh` (tunnel direct) : l'IP réelle est perdue |
