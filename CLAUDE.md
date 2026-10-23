# Objectif du projet

J'aimerai réaliser une application de paiement dans le cadre du projet workshop (tu trouveras le sujet dans le dossier informations à la racine du projet). Le but est centré autour de la résilience des SI.

## Architecture souhaitée

Je souhaite mettre en place un monolithe modulaire avec 5 services distincts:

- Database
- API
- Auth
- Payment
- Front

Chacun de ces services embarque un build docker qui sera publié sur GHCR. (Mon collègue côté infra utilise terraform et Kubernetes).

## Stack technique

- Node.js 22
- Typescript
- React (service front)
- Postgrès version 15
- Prisma
- Docker Compose

## Bonus pour plus tard

Mettre en place une CI pour Github (Build, tests, publications des images, )
