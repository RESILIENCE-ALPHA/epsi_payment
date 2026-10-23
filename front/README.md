# 🖥️ Front — `@epsi-pay/front`

Interface web d'EPSI Pay : React 18, React Router, Tailwind CSS, servie en production par nginx non-root.

---

## 🎨 Charte

- **Thème sombre** d'inspiration plateforme d'échange crypto : fonds quasi noirs bleutés (`ink`), cartes en léger relief, accent violet (`brand`), crédits en vert (`gain`), débits et erreurs en rouge (`loss`), incidents en ambre (`warn`). Tokens dans `tailwind.config.js`.
- **Typographie** : Inter Variable embarquée (`@fontsource-variable/inter`), aucune ressource externe (fonctionne hors ligne, compatible avec une CSP stricte).
- **Logo** : mosaïque et lettrage « epsi » repris du logo officiel de l'école ([epsi.fr](https://www.epsi.fr)), lettrage passé en blanc pour le thème sombre, suivi de « pay » (`src/components/Logo.tsx`, `public/favicon.svg`).

---

## 🧭 Écrans

| Route | Écran | Points clés |
| :--- | :--- | :--- |
| `/connexion` | Connexion | Messages distincts : identifiants invalides (tentatives restantes), compte verrouillé (heure de fin), **IP bloquée par la remédiation**, service indisponible |
| `/` | Tableau de bord | Solde, portefeuilles, activité (sens, contrepartie, tests de validation), **état de la plateforme** en direct |
| `/payer` | Paiement | Destinataire par e-mail, saisie du montant sans flottant, récapitulatif puis confirmation, écran de succès |

---

## 🛡️ Résilience côté navigateur

- **Bandeau d'incident** : affiché dès qu'un service répond `502/503/504` ou ne répond plus, retiré seul à la première réponse normale. L'état est déduit du trafic réel, sans appel dédié.
- **Rafraîchissement** : toutes les 30 s, toutes les 5 s pendant une panne pour constater le rétablissement au plus vite. Les dernières données restent affichées.
- **Paiement sans double débit** : une `Idempotency-Key` est générée par paiement et **réutilisée** à chaque nouvel essai après une panne ou un délai dépassé.
- **Session** : jeton et profil en `sessionStorage`. Un rechargement pendant une panne d'auth ne déconnecte pas (payment valide le jeton seul) ; seul un `401` met fin à la session.

---

## 🚀 Développement

```bash
npm run dev:front        # http://localhost:5173, /api relayé vers http://localhost:3000
npm run test:front       # Vitest + Testing Library (jsdom)
npm run build --workspace=front
```

`VITE_API_TARGET` change la cible du proxy de dev. Les comptes du seed sont rappelés sur l'écran de connexion en développement uniquement.

---

## 🐳 Image Docker

```bash
docker build -f front/Dockerfile -t epsi-pay-front .
```

nginx (port **8080**, utilisateur non-root) sert le build Vite et relaie `/api/*` vers la passerelle en retirant le préfixe. Il pose les en-têtes de sécurité (CSP `'self'`, `X-Frame-Options`, `nosniff`) et un cache long sur les fichiers versionnés. Il répond `503` JSON si la passerelle est absente, et la sonde est `GET /healthz`.

| Variable | Défaut | Rôle |
| :--- | :--- | :--- |
| `API_UPSTREAM` | `http://api:3000` | Adresse de la passerelle |
| `NGINX_RESOLVER` | `127.0.0.11` (DNS Docker) | Résolveur DNS : la passerelle est résolue à la volée (toutes les 10 s), un redémarrage ne casse pas le front |

**Kubernetes** : `API_UPSTREAM=http://<service-api>.<namespace>.svc.cluster.local:3000` (nom complet, nginx n'utilise pas les domaines de recherche) et `NGINX_RESOLVER=kube-dns.kube-system.svc.cluster.local`. Côté passerelle, `TRUST_PROXY=2` si l'Ingress est devant le front (Ingress + nginx), `1` sinon.
