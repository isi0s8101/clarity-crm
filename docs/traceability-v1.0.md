# Matrice de traçabilité — `clarity-crm_v1.0-closed`

Cette matrice est la référence unique de fermeture. Elle décrit le HEAD courant, pas une intention historique. `clarity-crm_v1.0-closed` reste un objectif de fermeture : il ne doit pas être annoncé comme livré tant que toutes les lignes critiques ne sont pas `VALIDÉ`.

Statuts autorisés : `VALIDÉ`, `IMPLÉMENTÉ_NON_TESTÉ`, `BACKEND_SEUL`, `UI_SEULE`, `SIMULÉ`, `PARTIEL`, `À_FAIRE`, `HORS_PÉRIMÈTRE`.

| ID | Version / phase | Fonctionnalité | Stockage | API / backend | UI | RBAC | Tenant-aware | Audit | Tests / recette | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| AUTH-01 | v0.1 | Session native obligatoire | `auth_credentials`, `auth_sessions` | `resolveAuthContext` | login | oui | n/a | session/login | unitaires ; recette POSIX à rejouer | IMPLÉMENTÉ_NON_TESTÉ |
| TEN-01 | v0.1 | Tenant résolu serveur et sélection explicite | memberships/invitations | session, tenants | sélecteur tenant | oui | oui | accès sensibles | unitaires ; recette POSIX à rejouer | IMPLÉMENTÉ_NON_TESTÉ |
| RBAC-01 | v0.1 | Rôles admin/user, actions et scopes | `role_permissions` | `requirePermission` | partiel | oui | oui | mutations | tests `authz` ; recette POSIX à rejouer | IMPLÉMENTÉ_NON_TESTÉ |
| AUD-01 | v0.1 | Journal d'audit tenant-aware | `audit_events` | `audit()` | audit admin existant | oui | oui | n/a | tests de politique ; recette POSIX à rejouer | IMPLÉMENTÉ_NON_TESTÉ |
| SEC-01 | v0.1 | Same-origin des mutations à cookie | n/a | `assertSameOriginMutation` sur routes métier | n/a | n/a | n/a | n/a | CI PostgreSQL : mutation cross-site refusée | VALIDÉ |
| CRM-01 | v0.2 | Moteur universel des 13 objets coeur | `crm_records` | `/api/crm` | console principale | oui | oui | create/update/archive | E2E legacy D1 obsolète ; recette PostgreSQL à rejouer | PARTIEL |
| CRM-02 | v0.2 | Liste, recherche, consultation, création | `crm_records` | `/api/crm`, `/api/crm/search` | console principale | oui | oui | création | lint/typecheck ; sans recette PostgreSQL courante | PARTIEL |
| CRM-03 | v0.2 | Modification depuis fiche métier | `crm_records` | PATCH existant réutilisé | fiche active : édition persistante | oui | oui | oui | recette POSIX étendue, CI PostgreSQL à exécuter | IMPLÉMENTÉ_NON_TESTÉ |
| CRM-04 | v0.2 | Fiches Société, Contact, Lead, Opportunité | `crm_records` | API générique | fiche générique : consultation, modification, activités, documents et relations | oui | oui | oui | recette POSIX étendue, CI PostgreSQL à exécuter | IMPLÉMENTÉ_NON_TESTÉ |
| CRM-05 | v0.2 | Archivage logique | `crm_records.status` | DELETE `/api/crm` | console principale | oui | oui | oui | tests de politique ; recette PostgreSQL à rejouer | IMPLÉMENTÉ_NON_TESTÉ |
| REL-01 | v0.2 | Relations entre objets | `crm_relations` | `/api/crm/relations` | fiche active : lecture, création, suppression et navigation | oui | oui | création/suppression | recette POSIX étendue, CI PostgreSQL à exécuter | IMPLÉMENTÉ_NON_TESTÉ |
| TIME-01 | v0.2 | Timeline métier | `crm_timeline_events` | `/api/crm/timeline` | affichage fiche | oui | oui | écritures manuelles/métier | lint/typecheck ; recette PostgreSQL à rejouer | PARTIEL |
| DOC-01 | v0.2 | Stockage documentaire binaire POSIX | `crm_documents` + répertoire POSIX isolé | `/api/documents`, téléchargement protégé | fiche CRM : upload, téléchargement, archivage | oui | oui | upload/download/archive | CI PostgreSQL : upload, stockage, téléchargement | VALIDÉ |
| SRCH-01 | v0.2 | Recherche globale navigable | `crm_records` | `/api/crm/search` | recherche globale et ouverture de fiche | oui | oui | n/a | tests de politique ; CI PostgreSQL à exécuter | IMPLÉMENTÉ_NON_TESTÉ |
| NOTIF-01 | v0.2 | Notifications internes persistantes | `crm_notifications` | `/api/notifications`, action d'automatisation | consultation, marquage lu et ouverture de la ressource CRM liée | destinataire serveur | oui | lecture | recette POSIX existante, CI PostgreSQL à exécuter | IMPLÉMENTÉ_NON_TESTÉ |
| DASH-01 | v0.2 | KPI calculés depuis données réelles | opportunités, tâches, timeline | `/api/dashboard` | console principale | oui | oui | n/a | tests unitaires, lint, typecheck et build Edge ; recette PostgreSQL à rejouer | IMPLÉMENTÉ_NON_TESTÉ |
| CFG-01 | v0.3 | Configurations versionnées | `crm_configurations`, versions | `/api/configurations` | console configuration | admin | oui | oui | tests source ; recette PostgreSQL à rejouer | PARTIEL |
| CFG-02 | v0.3 | Objets/pipelines/formulaires configurables | configurations | validation runtime | formulaires branchés ; objets/pipelines en JSON avancé | oui | oui | oui | E2E legacy D1 seulement | PARTIEL |
| CFG-03 | v0.3 | Historique et restauration | versions de configuration | PATCH restore | UI présente | admin | oui | oui | E2E legacy D1 seulement | PARTIEL |
| MOD-01 | v0.3 | Modules persistants et dépendances | configuration `module` | backend de dépendances | pas d'écran modules réel | admin | oui | oui | E2E legacy D1 seulement | BACKEND_SEUL |
| AUTO-01 | v0.3 | Automatisations persistantes | configuration + `automation_runs` | moteur existant enrichi | liste/activation et journal UI | oui | oui | replay/audit | tests de politique ; recette PostgreSQL d'automatisation reste à ajouter | PARTIEL |
| AUTO-02 | v0.3 | Limites, corrélation, boucles, retry borné | `automation_runs` | 10 actions, corrélation, profondeur, prévention par corrélation, timeout webhook ; pas de worker/retry asynchrone | journal UI | oui | oui | oui | lint/typecheck/tests ; recette PostgreSQL complète à ajouter | PARTIEL |
| WEB-01 | v0.3 | Webhooks sortants et anti-SSRF | configs + deliveries | dispatcher sécurisé | journal UI | admin | oui | oui | `webhook-security.test.mjs` ; recette E2E PostgreSQL à rejouer | IMPLÉMENTÉ_NON_TESTÉ |
| IMP-01 | v0.3 | Import CSV contrôlé | `crm_import_jobs`, `crm_records` | `/api/crm/import` : UTF-8, preview, mapping, doublons, validation, lots contrôlés | console CRM : fichier, aperçu, confirmation, rapport | oui | oui | oui | test parser ; CI PostgreSQL : preview + import persistant | VALIDÉ |
| EXP-01 | v0.3 | Export CSV protégé | `crm_records` | `/api/crm/export`, scope export et neutralisation formule | console CRM | oui | oui | non | CI PostgreSQL : export CSV | VALIDÉ |
| EXP-02 | v0.3 | Export XLSX protégé | `crm_records` | `/api/crm/export?format=xlsx`, XLSX minimal sans formule | console CRM | oui | oui | non | CI PostgreSQL : fichier XLSX valide (signature ZIP) | VALIDÉ |
| D1-01 | legacy | D1 comme import vers PostgreSQL uniquement | `legacy/d1` | `migrate-legacy-d1.mjs` | n/a | opérateur | séparé | import | CI legacy à rejouer avec PostgreSQL | IMPLÉMENTÉ_NON_TESTÉ |
| D1-02 | legacy | Runtime/recettes D1 anciennes | D1 local | anciens scripts `ci-e2e-*` | n/a | n/a | n/a | n/a | incompatibles avec session native PostgreSQL | HORS_PÉRIMÈTRE |
| BUILD-01 | qualité | Installation, lint, tests, typecheck | n/a | npm | n/a | n/a | n/a | n/a | passés localement ; CI Node 22/PostgreSQL à exécuter | IMPLÉMENTÉ_NON_TESTÉ |
| BUILD-02 | qualité | Build POSIX Next | n/a | `npm run build` | n/a | n/a | n/a | n/a | CI Node 22/PostgreSQL à exécuter ; conteneur local sans `uv_resident_set_memory` | IMPLÉMENTÉ_NON_TESTÉ |
| BUILD-03 | qualité | Build Edge | n/a | `npm run build:edge` | n/a | n/a | n/a | n/a | passé sur HEAD `4b343ab` | VALIDÉ |

## Décision de fermeture

Le statut actuel de `clarity-crm_v1.0-closed` est **NON FERMÉ**. Les fiches, relations, recherche et navigation de notification sont désormais raccordées, mais la validation Node 22/PostgreSQL du HEAD final reste obligatoire ; les lignes `PARTIEL` de configuration/automatisation/webhooks doivent conserver une preuve runtime POSIX avant fermeture.

La prochaine étape produit demeure `clarity-crm_v1.1`, mais elle ne doit pas commencer avant la résolution explicite des lignes de fermeture ci-dessus ou une décision de réduction de périmètre documentée.
