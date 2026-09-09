# Clarity CRM v1.0 — matrice de traçabilité

Cette matrice suit les fonctions réellement implémentées et validées pendant la construction de `clarity-crm_v1.0`.

Statuts : `VALIDÉ`, `PARTIEL`, `À FAIRE`.

| ID | Fonction | Livrable | Modèle / stockage | API / service | Permission | Audit | Tests | Statut |
|---|---|---|---|---|---|---|---|---|
| AUTH-01 | Authentification obligatoire | L1 | `users` | `resolveAuthContext` | serveur | n/a | CI + authz | VALIDÉ |
| TEN-01 | Isolation par tenant | L1 | `tenant_id` | `resolveAuthContext` + routes | serveur | oui | policy cross-tenant | VALIDÉ |
| TEN-02 | Sélection explicite si plusieurs tenants | L1 | `memberships` | `x-clarity-tenant-id` validé serveur | serveur | n/a | access-resolution | VALIDÉ |
| TEN-03 | Refus d'un tenant arbitraire | L1 | `memberships` / `invitations` | `resolveAuthContext` | serveur | n/a | access-resolution | VALIDÉ |
| TEN-04 | Création/lifecycle complet d'organisations | L1 | `organizations` | à compléter | admin | à compléter | à compléter | PARTIEL |
| INV-01 | Invitation obligatoire après bootstrap | L1 | `invitations` | `resolveAuthContext` | serveur | oui | access-resolution | VALIDÉ |
| INV-02 | Bootstrap premier administrateur | L1 | `organizations`, `memberships` | `resolveAuthContext` | serveur | indirect | access-resolution | VALIDÉ |
| RBAC-01 | Profils admin / user | L1 | `memberships.role` | authz | serveur | oui | authz/admin | VALIDÉ |
| RBAC-02 | Scopes personal / team / tenant | L1 | `role_permissions` | `requirePermission` | serveur | oui | shared policy | VALIDÉ |
| RBAC-03 | Scope opportunités | L1 | `opportunities` | `/api/opportunities` | serveur | oui | policy | VALIDÉ |
| RBAC-04 | Scope audit | L1 | `audit_events.team_id`, `actor_id` | `/api/audit` | serveur | oui | policy + migration | VALIDÉ |
| ADMIN-01 | Administration membres/équipes/invitations | L1 | tables dédiées | `/api/admin/access` | admin | oui | admin access | VALIDÉ |
| USER-01 | Compte actif / désactivé | L1 | `memberships.status` | `resolveAuthContext` | serveur | oui | access-resolution | VALIDÉ |
| AUD-01 | Audit tenant-aware | L1 | `audit_events` | `audit()` | serveur | n/a | migration + CI | VALIDÉ |
| DB-01 | Migrations 0000→0006 reproductibles | L1 | Drizzle + SQLite | migration chain | n/a | n/a | SQLite mémoire | VALIDÉ |
| DB-02 | Journal Drizzle 0000→0006 | L1 | `meta/_journal.json` | n/a | n/a | n/a | migration integrity | VALIDÉ |
| CI-01 | Installation CI | L1 | n/a | GitHub Actions | n/a | n/a | `npm ci` | VALIDÉ |
| CI-02 | Lint | L1 | n/a | GitHub Actions | n/a | n/a | ESLint | VALIDÉ |
| CI-03 | Tests | L1 | n/a | GitHub Actions | n/a | n/a | `npm test` | VALIDÉ |
| CI-04 | Typecheck | L1 | n/a | GitHub Actions | n/a | n/a | `tsc --noEmit` | VALIDÉ |
| CI-05 | Build | L1 | n/a | GitHub Actions | n/a | n/a | Vinext build | VALIDÉ |
| E2E-01 | API réelle sur D1 local | L1 | D1 local | routes HTTP | serveur | oui | à créer | À FAIRE |
| UI-01 | Sélecteur de tenant utilisateur | L1 | memberships | UI session | serveur | n/a | à créer | À FAIRE |

## Invariants du Livrable 1

1. Une identité non authentifiée ne peut pas obtenir de contexte CRM.
2. Un identifiant de tenant fourni par le client n'accorde jamais un droit par lui-même.
3. Un tenant sélectionné doit correspondre à une membership ou une invitation serveur de l'identité authentifiée.
4. Après le bootstrap initial, un utilisateur sans membership ni invitation est refusé.
5. Une membership désactivée interdit l'accès au tenant correspondant.
6. Une équipe référencée doit appartenir au même tenant.
7. Les ressources métier ne peuvent être visibles que dans le tenant de l'acteur.
8. Les scopes `personal`, `team` et `tenant` sont appliqués côté serveur.
9. Un scope `personal` sur l'audit ne retourne que les événements de l'acteur.
10. Un scope `team` sur l'audit ne retourne que les événements attribués à son équipe.
11. Les migrations doivent être applicables séquentiellement depuis une base vide.
12. Toute nouvelle migration SQL doit être enregistrée dans le journal Drizzle et passer le test d'intégrité des migrations.
13. La CI doit rester verte sur installation, lint, tests, typecheck et build avant validation d'un livrable.

## Critère de fermeture L1

Le Livrable 1 pourra être déclaré totalement fermé après ajout d'une recette HTTP/D1 locale réelle couvrant au minimum : bootstrap, invitation, session, refus sans invitation, utilisateur désactivé, opportunité cross-tenant refusée, scope audit personal/team/tenant et administration refusée au profil utilisateur.
