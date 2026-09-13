# Clarity CRM — fermeture `clarity-crm_v1.1`

CRM professionnel modulaire sous PostgreSQL, conçu pour réutiliser un moteur CRM générique, une résolution tenant côté serveur, un RBAC par objet/action/scope, un audit unifié et un moteur d'automatisation persistant.

`clarity-crm_v1.1` étend strictement le `main` v0.3 validé. Aucun moteur CRM, calendrier, système d'authentification, queue ou stockage documentaire parallèle n'est introduit. La matrice de fermeture v1.1 est dans [`docs/traceability-v1.1.md`](docs/traceability-v1.1.md) ; la traçabilité historique v0.3 reste dans [`docs/traceability-v1.0.md`](docs/traceability-v1.0.md).

## Runtime cible

Le runtime de référence est Next.js sous Node.js 22+ avec PostgreSQL 17 comme base applicative. D1/Wrangler est conservé uniquement pour l'import legacy contrôlé.

- schéma applicatif : `db/schema.ts` ;
- migrations de production : `postgres/migrations/*.sql` ;
- migrations : `npm run db:migrate` ;
- bootstrap initial : `npm run bootstrap:admin` ;
- déploiement Debian/POSIX : `sudo ./scripts/deploy-posix-vm.sh install` ;
- import legacy D1 : `npm run db:migrate:legacy -- --source-root <chemin_d1>`.

Les migrations PostgreSQL sont appliquées séquentiellement avec checksum. La migration v1.1 `0008_v11_operations.sql` est additive et une recette CI reproduit explicitement un upgrade d'une base arrêtée à `0007` vers `0008` en contrôlant la conservation des données existantes.

## Fondations conservées

La v1.1 réutilise sans reconstruction :

- authentification native et sessions ;
- organisations/tenants, memberships, invitations et sélection tenant côté serveur ;
- équipes ;
- profils `admin`, `user` et, pour le portail, `client` à moindre privilège ;
- RBAC serveur par objet, action et scope `personal`, `team`, `tenant` ;
- moteur CRM générique `crm_records`, relations et timeline ;
- configurations versionnées, modules et templates ;
- automatisations, queue PostgreSQL et worker existant ;
- notifications et audit ;
- stockage documentaire POSIX ;
- webhooks et protections SSRF existantes.

## Fonctionnalités v1.1

### Modules et templates

Le catalogue intégré conserve `services`, `appointments` et `field-service` et ajoute les lots v1.1. L'installation vérifie les prérequis et conflits, est idempotente et auditée. Le rollback est non destructif : il refuse de désactiver une configuration encore utilisée et restaure l'état antérieur d'une configuration préexistante inactive.

### Tickets, SAV et SLA

Les tickets restent des enregistrements CRM configurés. Les workflows support et SAV sont distincts. Les échéances SLA, rappels avant échéance et escalades après dépassement sont traités par le worker automation existant ; les événements utilisent notifications, timeline, audit et queue existants.

### Portail client

Le rôle `client` réutilise authentification, memberships et RBAC. Il n'accède pas au CRM générique. Le portail expose uniquement les tickets dont l'utilisateur est demandeur et les documents explicitement marqués comme visibles. Les recettes testent les tentatives IDOR/BOLA entre deux clients du même tenant.

### Projets, chantiers, interventions et planning

`project` et `intervention` sont étendus via les configurations existantes ; `worksite` est ajouté comme objet configuré. Les relations projet → chantier → intervention utilisent `crm_relations`. La vue planning agrège les objets existants ; aucun second calendrier n'est créé.

### Stock

Les produits restent des records CRM. Les soldes et mouvements nécessitant des invariants transactionnels utilisent les tables v1.1 dédiées. Les mouvements sont historisés et idempotents ; les sorties utilisent un verrou PostgreSQL et refusent un stock négatif. Une recette de concurrence prouve qu'une seule des deux sorties concurrentes sur la dernière unité peut réussir.

### Abonnements, CPQ et fidélité

Les abonnements restent des objets CRM génériques et peuvent déclencher les automatisations existantes. Le CPQ relit les prix produits/services côté serveur avant de créer un devis et ignore les prix arbitraires transmis par le client. La fidélité utilise un ledger transactionnel et idempotent pour protéger le solde.

### Centre d'aide

Le centre d'aide existant est étendu avec les procédures v1.1 pour utilisateurs, administrateurs et clients du portail. Son filtrage continue de dépendre du rôle et des permissions réelles du tenant courant.

## Validation CI

`verify-posix` exige :

- lint, tests unitaires, TypeScript et build ;
- migration réelle PostgreSQL `0007 → 0008` ;
- migrations/bootstrap courants ;
- recettes POSIX et v0.3 historiques ;
- queue automation et webhooks PostgreSQL ;
- restauration d'état des templates v1.1 ;
- recette E2E PostgreSQL v1.1 ;
- rappel SLA avant échéance et escalade après dépassement ;
- import legacy D1 ;
- backup/restore PostgreSQL.

Une v1.1 n'est considérée fermée que si cette chaîne est verte sur la PR puis sur le commit de fusion de `main`.

## Installation POSIX courte

Contexte attendu : Debian 13 ou compatible, utilisateur avec `sudo/root`, PostgreSQL local géré par le script.

```bash
git clone https://github.com/isi0s8101/clarity-crm.git
cd clarity-crm
sudo ./scripts/deploy-posix-vm.sh install
```

Commandes utiles :

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

Fondations d'authentification, tenants, memberships, équipes, RBAC, audit et opportunités tenant-aware.

### clarity-crm_v0.2

Administration des membres, équipes, invitations et permissions persistantes.

### clarity-crm_v0.3

Fermeture du moteur configurable : objets/champs personnalisés, formulaires, pipelines multiples, relations configurables, versionnement/restauration, intégrité cross-tenant PostgreSQL, automatisations et exploitation API/webhooks.

### clarity-crm_v1.1

Fermeture des briques métier réutilisables : cycle modules/templates, tickets/SAV/SLA, portail client, projets/chantiers/interventions/planning, stock, abonnements, CPQ simple et fidélité. Aucune fonctionnalité v1.2+ n'est incluse dans ce lot.