# Clarity CRM v1.2 — matrice de traçabilité

## Périmètre

La v1.2 étend le socle PostgreSQL/POSIX existant sans reconstruire le CRM et sans créer de moteur parallèle. Elle réutilise `crm_records`, `crm_configurations`, `crm_configuration_versions`, RBAC/scopes, audit, timeline, relations, documents, automatisations, queue PostgreSQL et worker existants.

Hors périmètre volontaire : connecteurs Gmail/Outlook, OAuth Microsoft/Google, Graph API, Google Calendar/Drive, n8n, LDAP/Active Directory, v2/v3.

## Invariants techniques

- PostgreSQL reste la base de vérité POSIX.
- Les rendez-vous restent des `crm_records(type=appointment)` ; `planning_reservations` ne porte que l'invariant de réservation concurrente.
- La contrainte PostgreSQL `ex_planning_reservation_no_overlap` interdit deux réservations actives qui se chevauchent pour une même ressource et un même tenant.
- Les règles v1.2 sont versionnées dans `crm_configurations` / `crm_configuration_versions`.
- Une publication publique doit être explicitement active ; son identifiant public est opaque et ne révèle pas tenant, équipe ou ressource interne.
- La fusion est uniquement manuelle, transactionnelle, auditée et journalisée dans `crm_merge_ledger`.
- Le scoring, l'inactivité et le Next Best Action sont déterministes et expliquent les règles déclenchantes ; aucune recommandation destructive n'est exécutée automatiquement.
- Les recalculs proactifs réutilisent `automation_jobs` et le worker d'automatisation existant.

## Traçabilité fonctionnelle

| ID | Exigence | Implémentation | Preuve automatisée |
| --- | --- | --- | --- |
| V12-PLAN-01 | Planning jour/semaine/mois et réservation unifiée | `app/api/planning/route.ts`, `lib/v12-planning.ts`, `app/v1/v12-workspace.tsx` | `scripts/ci-e2e-v12-postgres.sh` |
| V12-PLAN-02 | Disponibilités par utilisateur/équipe, horaires, exceptions, durée, pas, tampons | `lib/v12-config.ts`, `lib/v12-planning.ts` | disponibilité configurée puis réservation réelle |
| V12-PLAN-03 | Revalidation serveur et anti-chevauchement concurrent | `planning_reservations`, contrainte `ex_planning_reservation_no_overlap` | deux requêtes concurrentes : exactement une 201 et une 409 |
| V12-PUB-01 | Publication explicite d'un formulaire | `crm_publications`, `/api/publications`, `/api/public/forms/[publicId]` | création, lecture publique, soumission et révocation |
| V12-PUB-02 | Réservation publique sans fuite interne | `/api/public/booking/[publicId]`, pages `/public/booking/[publicId]` | métadonnées publiques + réservation + idempotence |
| V12-PUB-03 | Idempotence et anti-abus | `crm_public_submission_receipts`, `crm_public_rate_limits` | même clé de soumission relue sans doublon |
| V12-INBOX-01 | Inbox interne | `crm_inbox_conversations`, `crm_inbox_messages`, `/api/inbox` | conversation, messages, lecture et rattachement CRM |
| V12-DUP-01 | Doublons explicables | `lib/v12-duplicates.ts`, règles `duplicate_rule` | candidat trouvé avec score et raisons |
| V12-MERGE-01 | Prévisualisation et confirmation explicite | `lib/v12-merge.ts`, `/api/merge` | preview puis refus sans confirmation puis fusion confirmée |
| V12-MERGE-02 | Conservation relations/timeline/documents/références/Inbox | transaction de fusion | assertions SQL après fusion |
| V12-MERGE-03 | Traçabilité et archive secondaire | `crm_merge_ledger`, timeline, audit | ledger présent, secondaire `archived`, `mergedIntoId` |
| V12-ACT-01 | Inactivité configurable | règle `inactivity_rule`, `evaluateInactivity()` | activité vieillie et signal `inactive=true` |
| V12-SCORE-01 | Scoring lead/opportunité versionné et explicable | règle `scoring_rule`, `calculateScore()` | score attendu + facteur/règle/version |
| V12-NBA-01 | Next Best Action non destructif | règle `next_action_rule`, `getNextActions()` | recommandation lisible, confirmation obligatoire |
| V12-NBA-02 | Acceptation crée une action CRM traçable | `acceptNextAction()` | tâche liée créée après POST explicite |
| V12-WORKER-01 | Réutilisation queue/worker existants | `lib/automation-queue.ts`, `/api/internal/automation-worker` | jobs `system.proactive_*` traités par le worker existant |
| V12-SEC-01 | Isolation tenant / anti-IDOR | filtres tenant du CRM et services v1.2 | tentative de fusion cross-tenant => 404 |
| V12-UPG-01 | Upgrade v1.1→v1.2 sans perte | `0009_v12_proactive_crm.sql` | `scripts/ci-upgrade-v11-to-v12-postgres.sh` |
| V12-HELP-01 | Centre d'aide v1.2 | `lib/help/catalog-v12.js` + `catalog-all.js` | `npm test` / `lib/help.test.mjs` |

## Migrations

La seule migration v1.2 est `postgres/migrations/0009_v12_proactive_crm.sql`. Elle est additive et crée les tables de réservation, publication publique, reçus/idempotence, rate limiting public, Inbox et ledger de fusion. La recette `ci-upgrade-v11-to-v12-postgres.sh` reconstruit une base v1.1 à partir de `0001…0008`, insère des données et une configuration v1.1, exécute le migrateur normal, puis vérifie que les données sont strictement conservées et que `0009` est idempotente.

## Recettes de fermeture

La fermeture requiert simultanément :

1. workflow historique `CI` vert : lint, tests, TypeScript, build, upgrade v0.3→v1.1, migrations, POSIX, v0.3, queue/webhooks, modules v1.1, recette v1.1, SLA, legacy D1, backup/restore ;
2. workflow `CI v1.2` vert : lint, tests, TypeScript, build, upgrade v1.1→v1.2, migration/bootstrapping et recette `ci-e2e-v12-postgres.sh` ;
3. exécution des mêmes workflows sur `main` après intégration finale.

Tant qu'un de ces points n'est pas vert, le statut de fermeture reste **NO-GO**.
