# Clarity CRM v1.0 — matrice de traçabilité

Cette matrice suit les fonctions réellement implémentées et validées pendant la construction de `clarity-crm_v1.0`.

Statuts : `VALIDÉ`, `PARTIEL`, `À FAIRE`.

| ID | Fonction | Livrable | Modèle / stockage | API / service | Permission | Audit | Tests | Statut |
|---|---|---|---|---|---|---|---|---|
| AUTH-01 | Authentification obligatoire | L1 | `users` | `resolveAuthContext` | serveur | n/a | CI + authz + HTTP | VALIDÉ |
| TEN-01 | Isolation par tenant | L1 | `tenant_id` | `resolveAuthContext` + routes | serveur | oui | policy + HTTP/D1 | VALIDÉ |
| TEN-02 | Sélection explicite si plusieurs tenants | L1 | `memberships` | header/cookie validé serveur | serveur | n/a | access-resolution + HTTP/D1 | VALIDÉ |
| TEN-03 | Refus d'un tenant arbitraire | L1 | `memberships` / `invitations` | `resolveAuthContext` | serveur | n/a | access-resolution + HTTP/D1 | VALIDÉ |
| TEN-04 | Création/lifecycle administratif complet d'organisations | L1 | `organizations` | provisioning à définir | admin | à compléter | à compléter | PARTIEL |
| TEN-05 | Liste des organisations autorisées | L1 | `memberships` / `invitations` / `organizations` | `/api/tenants` | identité authentifiée | n/a | HTTP/D1 | VALIDÉ |
| TEN-06 | Changement d'organisation avec cookie HttpOnly | L1 | cookie `clarity_tenant` | `/api/session/tenant` | validation serveur | n/a | policy + HTTP/D1 | VALIDÉ |
| INV-01 | Invitation obligatoire après bootstrap | L1 | `invitations` | `resolveAuthContext` | serveur | oui | access-resolution + HTTP/D1 | VALIDÉ |
| INV-02 | Bootstrap premier administrateur | L1 | `organizations`, `memberships` | `resolveAuthContext` | serveur | indirect | access-resolution + HTTP/D1 | VALIDÉ |
| RBAC-01 | Profils admin / user | L1 | `memberships.role` | authz | serveur | oui | authz/admin + HTTP/D1 | VALIDÉ |
| RBAC-02 | Scopes personal / team / tenant | L1 | `role_permissions` | `requirePermission` | serveur | oui | shared policy + HTTP/D1 | VALIDÉ |
| RBAC-03 | Scope opportunités | L1 | `opportunities` | `/api/opportunities` | serveur | oui | policy + HTTP/D1 | VALIDÉ |
| RBAC-04 | Scope audit | L1 | `audit_events.team_id`, `actor_id` | `/api/audit` | serveur | oui | policy + migration + HTTP/D1 | VALIDÉ |
| ADMIN-01 | Administration membres/équipes/invitations | L1 | tables dédiées | `/api/admin/access` | admin | oui | admin access + HTTP/D1 | VALIDÉ |
| USER-01 | Compte actif / désactivé | L1 | `memberships.status` | `resolveAuthContext` | serveur | oui | access-resolution + HTTP/D1 | VALIDÉ |
| AUD-01 | Audit tenant-aware | L1 | `audit_events` | `audit()` | serveur | n/a | migration + HTTP/D1 | VALIDÉ |
| DB-01 | Migrations 0000→0006 reproductibles | L1 | Drizzle + SQLite/D1 | migration chain | n/a | n/a | SQLite mémoire + D1 local | VALIDÉ |
| DB-02 | Journal Drizzle 0000→0006 | L1 | `meta/_journal.json` | n/a | n/a | n/a | migration integrity | VALIDÉ |
| DB-03 | Snapshots Drizzle post-0004 | L1 | `drizzle/meta` | n/a | n/a | n/a | à régulariser | PARTIEL |
| CI-01 | Installation CI | L1 | n/a | GitHub Actions | n/a | n/a | `npm ci` | VALIDÉ |
| CI-02 | Lint | L1 | n/a | GitHub Actions | n/a | n/a | ESLint | VALIDÉ |
| CI-03 | Tests | L1 | n/a | GitHub Actions | n/a | n/a | `npm test` | VALIDÉ |
| CI-04 | Typecheck | L1 | n/a | GitHub Actions | n/a | n/a | `tsc --noEmit` | VALIDÉ |
| CI-05 | Build | L1 | n/a | GitHub Actions | n/a | n/a | Vinext build | VALIDÉ |
| E2E-01 | API réelle sur D1 local | L1 | D1 local | routes HTTP | serveur | oui | `ci-e2e-foundations.sh` | VALIDÉ |
| UI-01 | Sélecteur de tenant utilisateur | L1 | memberships/invitations | `TenantSwitcher` + session tenant | serveur | n/a | build + HTTP backend | VALIDÉ |

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
13. La CI doit rester verte sur installation, lint, tests, typecheck, build et recette HTTP/D1 avant validation d'un livrable.
14. Le cookie de sélection du tenant n'est qu'un sélecteur : sa valeur est revalidée contre les memberships/invitations côté serveur à chaque résolution de contexte.
15. Un utilisateur membre de plusieurs tenants doit sélectionner explicitement son tenant actif.

## État de fermeture du Livrable 1

La baseline de sécurité `clarity-crm_v0.3-foundations` est validée pour servir de point de départ au cœur CRM de `clarity-crm_v1.0` : authentification, bootstrap contrôlé, invitation obligatoire après bootstrap, multi-tenant, sélection explicite, RBAC, scopes d'audit, comptes désactivés, migrations, CI et recette HTTP/D1 réelle sont couverts.

Deux éléments restent documentés comme dette non bloquante pour le démarrage du Livrable 2 :

- le workflow administratif de création/renommage/archivage d'organisations doit être spécifié avant d'être exposé afin de ne pas introduire un provisioning tenant permissif ;
- les snapshots Drizzle postérieurs à `0004_snapshot.json` restent à régulariser, tandis que le journal, les migrations SQL, le schéma et leur application SQLite/D1 sont testés et cohérents.
