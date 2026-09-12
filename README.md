# Clarity CRM — fermeture `clarity-crm_v0.3`

CRM professionnel modulaire conçu pour piloter les ventes, configurer les objets métier, automatiser les tâches et gouverner les accès sans complexité excessive.

Ce lot consolide exclusivement `clarity-crm_v0.3`. Le runtime POSIX de référence est PostgreSQL ; D1/Wrangler est conservé uniquement comme legacy d'import. La [matrice de traçabilité](docs/traceability-v1.0.md) relie chaque exigence à son code, son test et sa preuve.

## Runtime cible

Le runtime de référence est une application Next.js/Vinext sous Node.js 22+ avec PostgreSQL comme base de données applicative. Cloudflare D1 n'est plus le socle runtime POSIX : il est conservé uniquement comme héritage de versions précédentes et comme source d'import contrôlée vers PostgreSQL.

## Base de données

- Production/POSIX : `db/schema.ts` décrit le modèle applicatif et `postgres/migrations/*.sql` est la chaîne de migrations utilisée en exploitation.
- Application des migrations PostgreSQL : `npm run db:migrate`.
- Bootstrap initial contrôlé : `npm run bootstrap:admin`.
- Déploiement Debian/POSIX complet : `sudo ./scripts/deploy-posix-vm.sh install`.
- Migration legacy D1 : `npm run db:migrate:legacy -- --source-root <chemin_d1>` importe une ancienne base D1 vers PostgreSQL. Ce script ne sert pas à initialiser une base neuve.
- Migrations D1 historiques : `legacy/d1/drizzle/` garde l'historique SQLite/D1 pour vérification et import. Ce répertoire n'est pas la source de vérité du runtime PostgreSQL.
- `drizzle.config.ts` sert à générer les artefacts PostgreSQL depuis `db/schema.ts` vers `postgres/generated`. Les migrations réellement appliquées en production restent celles de `postgres/migrations`.

## Baseline technique de départ

Le commit `1a5d73ccdecc9789b653fbf294d1fd6d52bf0b6b`, tagué `baseline-technique-depart-v0.3-20260913`, est le point de départ reproductible de cette fermeture. Ce tag ne désigne pas une version v0.3 fermée.

Fonctions réellement validées :

- authentification obligatoire via session native ;
- bootstrap initial contrôlé du premier administrateur ;
- invitation obligatoire pour tout nouvel accès après bootstrap ;
- plusieurs organisations/tenants avec memberships et invitations séparées ;
- sélection explicite du tenant lorsqu'un utilisateur possède plusieurs accès ;
- endpoint de liste limité aux organisations accessibles par l'identité ;
- sélection persistée par cookie HttpOnly, revalidée côté serveur à chaque résolution de contexte ;
- refus d'un tenant arbitraire fourni par le client ;
- équipes et validation de cohérence équipe/tenant ;
- profils `admin` et `user` ;
- RBAC serveur par objet, action et scope ;
- scopes `personal`, `team`, `tenant` ;
- opportunités et records CRM filtrés par tenant et scope ;
- audit tenant-aware avec scopes personnel, équipe et tenant appliqués côté SQL ;
- utilisateurs actifs/désactivés ;
- administration protégée des membres, équipes, invitations et permissions ;
- migrations PostgreSQL POSIX appliquées séquentiellement avec checksum ;
- import legacy D1 vers PostgreSQL transactionnel et fail-closed ;
- CI Node 22 avec installation, lint, tests, typecheck, build, migrations PostgreSQL, recette POSIX et recette d'import D1.

La matrice détaillée est maintenue dans `docs/traceability-v1.0.md`.

La baseline de départ est documentée dans [`docs/baseline-v03-20260913.md`](docs/baseline-v03-20260913.md). Le moteur configurable fermé est décrit dans [`docs/configuration-engine-v0.3.md`](docs/configuration-engine-v0.3.md).

Dette connue non bloquante pour le cœur CRM :

- le provisioning administratif complet des organisations (création/renommage/archivage) n'est pas encore exposé tant que sa politique n'est pas spécifiée.

## État fonctionnel actuel

Le moteur CRM universel, les objets et champs personnalisés, les formulaires, pipelines multiples, relations configurables, automatisations, modules, templates et webhooks utilisent les mêmes API persistantes PostgreSQL. La racine `/` expose la console branchée aux API réelles ; l'ancien cockpit UX de démonstration n'est plus la route principale.

Les documents binaires POSIX, les notifications internes, l'import CSV contrôlé, les exports CSV/XLSX et le dashboard calculé depuis les données accessibles sont validés par les recettes CI PostgreSQL.

Les webhooks sortants sont soumis à une politique anti-SSRF avec HTTPS public, allowlist optionnelle, résolution DNS juste avant envoi, blocage des adresses privées/réservées et lecture bornée des réponses.

## Installation POSIX courte

Contexte attendu : Debian 13 ou compatible, utilisateur avec `sudo/root`, PostgreSQL local géré par le script.

```bash
git clone https://github.com/isi0s8101/clarity-crm.git
cd clarity-crm
sudo ./scripts/deploy-posix-vm.sh install
```

Commandes applicatives utiles :

```bash
npm run install:ci
npm run db:migrate
npm run bootstrap:admin
npm test
npm run build
```

Migration d'une ancienne base D1 vers PostgreSQL :

```bash
npm run db:migrate
npm run db:migrate:legacy -- --source-root .wrangler/state --apply
```

## Historique conservé

### clarity-crm_v0.1

Fondations ajoutées :

- authentification obligatoire via identité transmise par la plateforme ;
- organisations, utilisateurs, équipes, appartenances, rôles et permissions persistants ;
- isolation tenant côté serveur sur les opportunités ;
- profils `admin` et `user` avec permissions par objet, action et périmètre ;
- audit enrichi : acteur, tenant, action, ressource, résultat, avant/après ;
- export CSV servi par API protégée.

### clarity-crm_v0.2

Administration réelle ajoutée :

- API admin protégée pour membres, équipes, invitations et permissions ;
- écran Droits & équipes branché sur les données persistantes ;
- création d'équipe et invitation utilisateur auditables ;
- modification de rôle/équipe avec garde-fou contre l'auto-rétrogradation admin ;
- modification de périmètre de permission avec refus d'administration pour le profil utilisateur ;
- migration legacy D1 additive pour les invitations.

### clarity-crm_v0.3

Fermeture du moteur configurable :

- objets et champs personnalisés validés côté serveur ;
- formulaires ordonnés écrivant dans le moteur CRM générique ;
- plusieurs pipelines par objet et validation des étapes ;
- relations configurables source/cible/cardinalité dans le moteur existant ;
- versionnement atomique et restauration créant une nouvelle version ;
- intégrité cross-tenant PostgreSQL renforcée par contraintes composites ;
- recette E2E PostgreSQL de fermeture et matrice de traçabilité actualisée.
