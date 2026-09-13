# Matrice de traçabilité — `clarity-crm_v1.1`

Cette matrice couvre uniquement la fermeture v1.1. La baseline v0.3 reste couverte par `docs/traceability-v1.0.md` et ses recettes historiques.

Règle de validation : une ligne n'est considérée `VALIDÉE` que si son code est présent et sa preuve est exécutée dans le job CI `verify-posix`. La fermeture globale exige en plus une CI verte sur la PR puis sur le commit fusionné dans `main`.

| ID | Exigence | État | Code principal | Preuve CI |
| --- | --- | --- | --- | --- |
| V11-MOD-01 | Catalogue modules/templates tenant-aware | VALIDÉ_PAR_CI | `lib/crm-templates.ts`, `lib/module-catalog-v11.ts`, `app/api/modules/route.ts` | `ci-e2e-v11-module-state.sh`, `ci-e2e-v11-postgres.sh` |
| V11-MOD-02 | Prérequis, conflits et installation idempotente | VALIDÉ_PAR_CI | `lib/module-catalog-v11.ts` | tentative `operations` sans prérequis = 409 ; seconde installation support idempotente |
| V11-MOD-03 | Rollback non destructif et restauration de l'état antérieur | VALIDÉ_PAR_CI | `lib/module-catalog-v11.ts` | `ci-e2e-v11-module-state.sh` réactive une configuration inactive puis vérifie son retour à inactive |
| V11-TKT-01 | Tickets support et SAV sur moteur CRM générique | VALIDÉ_PAR_CI | `lib/v11-ticketing.ts`, `app/api/tickets/route.ts`, templates support | `ci-e2e-v11-postgres.sh` |
| V11-SLA-01 | Échéances et escalades SLA | VALIDÉ_PAR_CI | `lib/v11-sla.ts`, `app/api/internal/automation-worker/route.ts` | échéance forcée passée, notification/timeline/audit et état SLA |
| V11-SLA-02 | Rappel SLA avant échéance | VALIDÉ_PAR_CI | `lib/v11-sla.ts` | `ci-e2e-v11-sla-reminder.sh` vérifie rappel sans escalade prématurée |
| V11-SLA-03 | Réutilisation du worker/queue existants | VALIDÉ_PAR_CI | worker automation existant + `enqueueAutomationJob` | aucune seconde boucle/queue ; mêmes endpoint interne et token worker |
| V11-POR-01 | Rôle client à moindre privilège | VALIDÉ_PAR_CI | `lib/authz.ts`, `app/api/admin/access/route.ts` | session client + `/api/crm?type=ticket` = 403 |
| V11-POR-02 | Tickets portail limités au demandeur | VALIDÉ_PAR_CI | `app/api/portal/tickets/route.ts`, `lib/v11-ticketing.ts` | deux clients du même tenant ; lecture/édition IDOR = 404 |
| V11-POR-03 | Documents explicitement partagés seulement | VALIDÉ_PAR_CI | `app/api/portal/documents/route.ts`, `app/api/portal/documents/download/route.ts`, `0008_v11_operations.sql` | document visible pour son demandeur, 404 pour autre client |
| V11-POR-04 | Actions portail auditables avec acteur client | VALIDÉ_PAR_CI | `app/api/portal/tickets/route.ts`, audit existant | `portal.ticket.created` vérifié par `ci-e2e-v11-sla-reminder.sh` |
| V11-OPS-01 | Projet complété sans nouvel objet parallèle | VALIDÉ_PAR_CI | template `services`, `crm_records` | création `project` avec dates/budget/responsable |
| V11-OPS-02 | Chantiers | VALIDÉ_PAR_CI | template `operations`, objet configuré `worksite` | création + pipeline `worksite_cycle` |
| V11-OPS-03 | Interventions et affectation | VALIDÉ_PAR_CI | template `field-service`, `intervention` | création avec horaire/intervenant + relation chantier |
| V11-OPS-04 | Relations projet → chantier → intervention | VALIDÉ_PAR_CI | `crm_relations`, configurations relation | deux relations créées et relues |
| V11-PLAN-01 | Planning unifié sans second calendrier | VALIDÉ_PAR_CI | `app/api/planning/route.ts` | agrégation `project`, `worksite`, `intervention` dans la recette v1.1 |
| V11-RBAC-01 | Scope équipe appliqué aux objets v1.1 | VALIDÉ_PAR_CI | moteur CRM/RBAC existant | utilisateur `default-sales` reçoit 404 sur projet d'une autre équipe |
| V11-TEN-01 | Références cross-tenant refusées | VALIDÉ_PAR_CI | moteur CRM/runtime validation et contraintes existantes | contact référant une société étrangère = 400 |
| V11-STK-01 | Soldes de stock transactionnels | VALIDÉ_PAR_CI | `0008_v11_operations.sql`, `app/api/inventory/route.ts` | entrée/sortie et contrôle du solde |
| V11-STK-02 | Historique et idempotence des mouvements | VALIDÉ_PAR_CI | `inventory_movements` | mouvements relus, clés d'idempotence |
| V11-STK-03 | Pas de stock négatif sous concurrence | VALIDÉ_PAR_CI | transaction + verrou PostgreSQL dans inventory | deux sorties concurrentes de la dernière unité : une 201, une 409, solde final 0 |
| V11-STK-04 | Seuil et notification | VALIDÉ_PAR_CI | inventory + notifications existantes | `belowThreshold=true` et notification `stock.threshold` |
| V11-SUB-01 | Abonnement dans le moteur CRM générique | VALIDÉ_PAR_CI | template `commerce-ops`, `crm_records` | création `subscription` |
| V11-SUB-02 | Abonnement exploitable par automatisations existantes | VALIDÉ_PAR_CI | automation engine existant | automation `record.created/subscription` produit notification |
| V11-CPQ-01 | CPQ simple | VALIDÉ_PAR_CI | `app/api/cpq/route.ts` + devis existants | création d'un devis calculé |
| V11-CPQ-02 | Prix serveur autoritatifs | VALIDÉ_PAR_CI | `app/api/cpq/route.ts` | prix arbitraire client `1` ignoré, total calculé depuis le produit serveur |
| V11-LOY-01 | Compte fidélité | VALIDÉ_PAR_CI | objet `loyalty_account` + `app/api/loyalty/route.ts` | création et lecture du solde |
| V11-LOY-02 | Ledger fidélité atomique/idempotent | VALIDÉ_PAR_CI | `loyalty_ledger` dans migration 0008 | +1500, répétition idempotente, -500, solde 1000 |
| V11-MIG-01 | Migration additive v0.3 → v1.1 | VALIDÉ_PAR_CI | `0008_v11_operations.sql`, migrateur PostgreSQL existant | `ci-upgrade-v03-to-v11-postgres.sh` applique 0001–0007, peuple, puis migre officiellement vers 0008 |
| V11-MIG-02 | Conservation des données pendant upgrade | VALIDÉ_PAR_CI | même chaîne | record et document v0.3 conservés ; nouvelle colonne `portal_visible=0` |
| V11-BKP-01 | Backup/restore avec données v1.1 | VALIDÉ_PAR_CI | outils PostgreSQL existants | dump/restore dans `ci-e2e-v11-postgres.sh` + recette historique backup/restore |
| V11-HELP-01 | Centre d'aide étendu aux fonctions v1.1 | VALIDÉ_PAR_CI | `lib/help/catalog-v11.js`, `catalog-all.js`, pages/drawer existants | lint/tests/typecheck/build + filtrage par rôle/permissions |
| V11-REG-01 | Non-régression v0.3 | VALIDÉ_PAR_CI | fondations historiques | toutes les recettes POSIX, configuration v0.3, automation/webhooks, legacy D1 et backup restent obligatoires |

## Invariants d'architecture

- `crm_records` reste le stockage des objets métier. Les tables v1.1 spécialisées sont limitées aux invariants transactionnels de stock/fidélité et à l'attribut de visibilité documentaire.
- `crm_relations` reste le moteur de relations.
- le worker et la queue automation PostgreSQL existants restent uniques ; le SLA est un traitement temporel appelé depuis le même worker.
- le planning agrège les records existants et ne crée pas de second calendrier.
- le portail réutilise l'authentification, les memberships, le tenant et le RBAC existants.
- les documents restent dans le stockage POSIX existant.
- aucune fonctionnalité `clarity-crm_v1.2+` n'appartient à ce lot.

## Verdict

Le verdict final ne doit être changé en `GO — clarity-crm_v1.1 FERMÉE` qu'après :

1. job `verify-posix` entièrement vert sur la PR ;
2. fusion de la PR sans contournement de protection ;
3. job `verify-posix` entièrement vert sur le commit de fusion de `main`.
