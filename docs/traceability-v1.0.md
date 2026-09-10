# Clarity CRM v1.0 - matrice de traçabilité

Cette matrice suit les fonctions réellement implémentées et validées pendant la construction de `clarity-crm_v1.0`.

Statuts : `VALIDÉ`, `PARTIEL`, `À FAIRE`.

| ID | Fonction | Livrable | Modèle / stockage | API / service | Permission | Audit | Tests | Statut |
|---|---|---|---|---|---|---|---|---|
| AUTH-01 | Authentification obligatoire | L1 | `users`, `auth_sessions` | `resolveAuthContext` | serveur | n/a | CI + authz + HTTP | VALIDÉ |
| TEN-01 | Isolation par tenant | L1 | `tenant_id` | `resolveAuthContext` + routes | serveur | oui | policy + HTTP/POSIX | VALIDÉ |
| TEN-02 | Sélection explicite si plusieurs tenants | L1 | `memberships` | header/cookie validé serveur | serveur | n/a | access-resolution + HTTP/POSIX | VALIDÉ |
| TEN-03 | Refus d'un tenant arbitraire | L1 | `memberships` / `invitations` | `resolveAuthContext` | serveur | n/a | access-resolution + HTTP/POSIX | VALIDÉ |
| TEN-04 | Création/lifecycle administratif complet d'organisations | L1 | `organizations` | provisioning à définir | admin | à compléter | à compléter | PARTIEL |
| TEN-05 | Liste des organisations autorisées | L1 | `memberships` / `invitations` / `organizations` | `/api/tenants` | identité authentifiée | n/a | HTTP/POSIX | VALIDÉ |
| TEN-06 | Changement d'organisation avec cookie HttpOnly | L1 | cookie `clarity_tenant` | `/api/session/tenant` | validation serveur | n/a | policy + HTTP/POSIX | VALIDÉ |
| INV-01 | Invitation obligatoire après bootstrap | L1 | `invitations` | `resolveAuthContext` | serveur | oui | access-resolution + HTTP/POSIX | VALIDÉ |
| INV-02 | Bootstrap premier administrateur | L1 | `organizations`, `memberships`, `auth_credentials` | `bootstrap:admin` | serveur | indirect | POSIX + CI | VALIDÉ |
| RBAC-01 | Profils admin / user | L1 | `memberships.role` | authz | serveur | oui | authz/admin + HTTP/POSIX | VALIDÉ |
| RBAC-02 | Scopes personal / team / tenant | L1 | `role_permissions` | `requirePermission` | serveur | oui | shared policy + HTTP/POSIX | VALIDÉ |
| RBAC-03 | Scope opportunités | L1 | `opportunities` | `/api/opportunities` | serveur | oui | policy + HTTP/POSIX | VALIDÉ |
| RBAC-04 | Scope audit | L1 | `audit_events.team_id`, `actor_id` | `/api/audit` | serveur | oui | policy + migration + HTTP/POSIX | VALIDÉ |
| ADMIN-01 | Administration membres/équipes/invitations | L1 | tables dédiées | `/api/admin/access` | admin | oui | admin access + HTTP/POSIX | VALIDÉ |
| USER-01 | Compte actif / désactivé | L1 | `memberships.status` | `resolveAuthContext` | serveur | oui | access-resolution + HTTP/POSIX | VALIDÉ |
| AUD-01 | Audit tenant-aware | L1 | `audit_events` | `audit()` | serveur | n/a | migration + HTTP/POSIX | VALIDÉ |
| DB-01 | Migrations PostgreSQL reproductibles | L1 | `postgres/migrations` | `npm run db:migrate` | n/a | n/a | PostgreSQL CI + checksum | VALIDÉ |
| DB-02 | Drizzle D1 classé en legacy | L1 | `legacy/d1/drizzle` | tests legacy uniquement | n/a | n/a | `drizzle-legacy.test.mjs` | VALIDÉ |
| DB-03 | Import D1 vers PostgreSQL | L1 | `_clarity_legacy_imports` | `scripts/migrate-legacy-d1.mjs` | opérateur | n/a | `ci-legacy-d1-migration.sh` | VALIDÉ |
| CI-01 | Installation CI | L1 | n/a | GitHub Actions | n/a | n/a | `npm ci` | VALIDÉ |
| CI-02 | Lint | L1 | n/a | GitHub Actions | n/a | n/a | ESLint | VALIDÉ |
| CI-03 | Tests | L1 | n/a | GitHub Actions | n/a | n/a | `npm test` | VALIDÉ |
| CI-04 | Typecheck | L1 | n/a | GitHub Actions | n/a | n/a | `tsc --noEmit` | VALIDÉ |
| CI-05 | Build | L1 | n/a | GitHub Actions | n/a | n/a | Next build | VALIDÉ |
| E2E-01 | API réelle POSIX | L1 | PostgreSQL | routes HTTP | serveur | oui | `ci-e2e-posix.sh` | VALIDÉ |
| WEBHOOK-01 | Politique anti-SSRF webhook sortant | L3 | configuration webhook | `dispatchOutboundWebhooks` | admin webhook | oui | `webhook-security.test.mjs` | VALIDÉ |
| WEBHOOK-02 | Lecture bornée réponse webhook | L3 | `webhook_deliveries` | `readLimitedResponseText` | admin webhook | oui | réponse volumineuse testée | VALIDÉ |
| GOV-01 | Gouvernance GitHub cible | L0 | dépôt GitHub | PR + checks + protection | mainteneur | n/a | documentation | PARTIEL |

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
11. Les migrations runtime doivent être applicables séquentiellement depuis une base PostgreSQL vide.
12. Toute nouvelle migration PostgreSQL doit passer le test d'intégrité, conserver son checksum après application et être ajoutée sous `postgres/migrations`.
13. Les migrations SQLite/D1 historiques doivent rester sous `legacy/d1/drizzle` et ne doivent pas redevenir une chaîne runtime ambiguë à la racine `drizzle/`.
14. La CI doit rester verte sur installation, lint, tests, typecheck, build, migrations PostgreSQL, recette POSIX et import legacy D1 avant validation d'un livrable.
15. Le cookie de sélection du tenant n'est qu'un sélecteur : sa valeur est revalidée contre les memberships/invitations côté serveur à chaque résolution de contexte.
16. Un utilisateur membre de plusieurs tenants doit sélectionner explicitement son tenant actif.
17. Un webhook sortant doit être revalidé juste avant envoi, y compris résolution DNS, blocage des IP privées/réservées et allowlist optionnelle.
18. Une réponse webhook sortante ne doit jamais être chargée sans limite stricte.

## État de fermeture du Livrable 1

La baseline de sécurité `clarity-crm_v0.3-foundations` est validée pour servir de point de départ au cœur CRM de `clarity-crm_v1.0` : authentification, bootstrap contrôlé, invitation obligatoire après bootstrap, multi-tenant, sélection explicite, RBAC, scopes d'audit, comptes désactivés, migrations PostgreSQL, import D1 contrôlé, CI et recette POSIX réelle sont couverts.

Élément restant volontairement ouvert :

- le workflow administratif de création/renommage/archivage d'organisations doit être spécifié avant d'être exposé afin de ne pas introduire un provisioning tenant permissif.
