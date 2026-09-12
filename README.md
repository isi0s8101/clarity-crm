# Clarity CRM — cible de fermeture `clarity-crm_v1.0-closed`

CRM professionnel modulaire conçu pour piloter les ventes, configurer les objets métier, automatiser les tâches et gouverner les accès sans complexité excessive.

`clarity-crm_v1.0-closed` est la cible de consolidation des versions historiques `clarity-crm_v0.1`, `clarity-crm_v0.2` et `clarity-crm_v0.3`. Le runtime POSIX de référence est PostgreSQL. Cette fermeture n'est pas encore déclarée : la [matrice de traçabilité](docs/traceability-v1.0.md) indique précisément les fonctions livrées, partielles ou à faire.

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

## Baseline technique historique — `clarity-crm_v0.3-foundations`

L'état consolidé des fondations est la baseline technique de référence pour la construction de `clarity-crm_v1.0`.

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

Dette connue non bloquante pour le cœur CRM :

- le provisioning administratif complet des organisations (création/renommage/archivage) n'est pas encore exposé tant que sa politique n'est pas spécifiée.

## État fonctionnel actuel

Le moteur CRM universel, les configurations, formulaires, automatisations, modules, templates et webhooks existent à des niveaux différents de complétude. La racine `/` expose la console branchée aux API persistantes ; l'ancien cockpit UX de démonstration n'est plus la route principale.

Les documents binaires POSIX, les notifications internes, l'import CSV contrôlé (aperçu avant écriture) et les exports CSV/XLSX sont implémentés sur les API et la console, et validés par la recette CI PostgreSQL. Le dashboard actuel est calculé depuis les données CRM accessibles, mais attend encore une recette PostgreSQL complète.

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

Cycle d'accès renforcé :

- acceptation automatique d'une invitation persistante au premier login ;
- statut de membre `active` / `disabled` appliqué côté serveur ;
- désactivation/réactivation contrôlée depuis l'administration ;
- garde-fou contre l'auto-désactivation d'un administrateur ;
- API `/api/audit` protégée et filtrable par résultat ou type de ressource ;
- journal d'audit admin branché sur les événements serveur.
