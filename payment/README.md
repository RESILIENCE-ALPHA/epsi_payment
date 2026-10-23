# 💳 Service Paiement — `@epsi-pay/payment`

Service responsable des portefeuilles, de l'exécution des paiements et du **paiement de validation post-incident** (*« ça remarche ? »*) dans le scénario **RESILIENCE-ALPHA**.

---

## 🏗️ Architecture

```
payment/
├── src/
│   ├── index.ts              # Exports publics du package
│   ├── routes.ts             # Routeur Express & annotations OpenAPI
│   ├── controller.ts         # Contrôleurs HTTP (extraction IP, Idempotency-Key, sérialisation)
│   ├── service.ts            # Logique métier : transfert transactionnel, idempotence, preuve de remédiation
│   ├── validation.ts         # Validation des entrées (montants en Decimal exact, UUID, clé d'idempotence)
│   ├── middleware.ts         # Jeton interne, refus des comptes suspendus
│   ├── errors.ts             # PaymentError (statut HTTP + code stable)
│   ├── swagger.ts            # Spécification OpenAPI du service
│   ├── server.ts             # Serveur HTTP autonome (port 3002) : /health, /docs.json, gestion d'erreurs
│   └── __tests__/
│       ├── payment.test.ts               # Tests HTTP (mocks Prisma)
│       └── payment.integration.test.ts   # Tests sur vrai PostgreSQL (concurrence, idempotence)
├── Dockerfile
├── vitest.config.ts
└── package.json
```

**Authentification** : payment réutilise le module `@epsi-pay/auth` comme bibliothèque (`requireAuth`, `checkIpBlocked`) et valide les sessions **directement en base**, sans appel HTTP au service auth. Si auth tombe sous une attaque brute force, les utilisateurs déjà connectés continuent de payer.

---

## 📡 Endpoints

Exposés via la passerelle API (`http://localhost:3000`) :

| Méthode | Route | Description | Statuts |
| :--- | :--- | :--- | :--- |
| `GET` | `/wallets` | Portefeuilles de l'utilisateur connecté | `200`, `401` |
| `GET` | `/wallets/:id?limit=20` | Solde et dernières transactions (propriétaire uniquement), avec `direction` (`DEBIT`/`CREDIT`) et `counterparty` (`{name, email}` de l'autre partie) | `200`, `401`, `404` |
| `POST` | `/payments` | Paiement (en-tête `Idempotency-Key` obligatoire). Destinataire : `receiverWalletId` **ou** `recipientEmail` | `201`, `200` (rejeu), `400`, `401`, `403`, `404`, `409`, `422` |
| `GET` | `/payments/:id` | Détail d'un paiement (émetteur ou destinataire) | `200`, `401`, `404` |

```bash
# Paiement depuis l'interface : le destinataire est désigné par son e-mail
curl -X POST http://localhost:3000/payments \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{"senderWalletId":"<uuid>","recipientEmail":"bob@epsi.fr","amount":"12.50","description":"Remboursement"}'
# 201 {"payment":{...}}  |  404 {"error":"RECEIVER_NOT_FOUND"}  |  422 {"error":"INSUFFICIENT_FUNDS"}
```

Par e-mail, c'est le portefeuille actif du destinataire **dans la devise de l'émetteur** qui est crédité. E-mail inconnu, sans portefeuille compatible ou égal à l'émetteur : même `404 RECEIVER_NOT_FOUND`, audité. La résolution n'a lieu qu'après le contrôle d'IP : une IP bloquée ne peut pas sonder les comptes.

**Route interne** (réseau Docker / cluster uniquement, refusée par la passerelle) :

| Méthode | Route | Description |
| :--- | :--- | :--- |
| `POST` | `/payments/test-validation` | Paiement `VALIDATION_TEST` de 0,01 ; avec `{"incidentId": "..."}`, preuve inscrite dans `remediation_logs` (`TEST_PAYMENT_VERIFIED`, durée en ms). En-tête `X-Internal-Token` = `PAYMENT_INTERNAL_TOKEN`. |

```bash
# Depuis le moteur de remédiation (même réseau que payment)
curl -X POST http://payment:3002/payments/test-validation \
  -H "X-Internal-Token: $PAYMENT_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' -d '{"incidentId":"<uuid>"}'
# 200 {"status":"SUCCESS","durationMs":46,"payment":{...}}  |  503 {"status":"FAILED",...}
```

---

## 🛡️ Garanties

1. **Idempotence** : une même `Idempotency-Key` (cloisonnée par utilisateur) ne débite qu'une fois. Un retry renvoie le paiement initial (`200` + `Idempotent-Replayed: true`) ; la même clé avec un autre montant ou d'autres portefeuilles → `409 IDEMPOTENCY_KEY_REUSED`. Tient aussi sous requêtes simultanées (contrainte unique en base).
2. **Pas de découvert, pas de paiement perdu** : débit et crédit dans une transaction SQL unique, verrou `SELECT … FOR UPDATE` sur les deux portefeuilles par ordre d'id. Les paiements concurrents sur un même portefeuille sont sérialisés (aucun faux échec), sans deadlock entre virements croisés.
3. **Montants exacts** : `Decimal` de bout en bout, montants renvoyés en chaîne à 2 décimales, plafond de 10 000,00 par paiement.
4. **Cloisonnement** : on ne débite que ses propres portefeuilles ; un portefeuille ou paiement d'autrui répond `404` (pas de confirmation d'existence).
5. **Couplage avec la remédiation** : paiement refusé (`403 IP_BLOCKED`) depuis une IP présente dans `blocked_ips`. Comptes `SUSPENDED` refusés ; un compte `LOCKED` par la protection brute force garde ses sessions (sinon un attaquant bloquerait les paiements d'une victime).
6. **Audit (SIEM)** : `PAYMENT_SUCCESS`, `VALIDATION_PAYMENT_SUCCESS` et `PAYMENT_REJECTED` (avec la raison, sévérité `CRITICAL` si IP bloquée) dans `audit_logs`.

---

## ⚙️ Configuration

| Variable | Défaut | Rôle |
| :--- | :--- | :--- |
| `PORT` / `PAYMENT_PORT` | `3002` | Port d'écoute |
| `TRUST_PROXY` | `1` | Proxys de confiance devant le service : la passerelle seule, en Compose comme en Kubernetes |
| `PAYMENT_INTERNAL_TOKEN` | *(vide)* | Jeton de la route interne ; vide = route désactivée (`503`) |
| `VALIDATION_SENDER_EMAIL` | `system-bot@epsi-pay.internal` | Compte débité par le paiement de validation |
| `VALIDATION_RECEIVER_EMAIL` | `store@merchant.com` | Compte crédité par le paiement de validation |

---

## 🧪 Tests

```bash
npm run test:payment                       # Tests HTTP (sans base)

# Tests d'intégration sur le PostgreSQL de Docker Compose
DATABASE_URL="postgresql://epsi_pay:<mdp>@localhost:5432/epsi_pay_db?schema=public" \
  npm run test:integration --workspace=payment
```
