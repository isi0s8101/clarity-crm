# Clarity CRM — construction de clarity-crm_v1.0

CRM professionnel modulaire conçu pour piloter les ventes, configurer les objets métier, automatiser les tâches et gouverner les accès sans complexité excessive.

`clarity-crm_v1.0` est construit de manière incrémentale à partir de l'historique existant. Les versions historiques `clarity-crm_v0.1`, `clarity-crm_v0.2` et `clarity-crm_v0.3` restent inchangées dans Git.

## Baseline technique — clarity-crm_v0.3-foundations

L'état consolidé des fondations est désormais la baseline technique de référence pour la construction de `clarity-crm_v1.0`.

Fonctions réellement validées :

- authentification obligatoire via l'identité transmise par la plateforme ;
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
- opportunités filtrées par tenant et scope ;
- audit tenant-aware avec scopes personnel, équipe et tenant appliqués côté SQL ;
- utilisateurs actifs/désactivés ;
- administration protégée des membres, équipes, invitations et permissions ;
- migrations `0000` à `0006` appliquées séquentiellement et testées sur SQLite et D1 local ;
- CI Node 22 avec installation, lint, tests, typecheck, build et recette HTTP/D1 réelle.

La matrice détaillée est maintenue dans `docs/traceability-v1.0.md`.

Dettes connues non bloquantes pour le cœur CRM :

- le provisioning administratif complet des organisations (création/renommage/archivage) n'est pas encore exposé tant que sa politique n'est pas spécifiée ;
- les snapshots Drizzle sont présents jusqu'à `0004_snapshot.json` ; le journal et les migrations `0005/0006` sont enregistrés et testés, mais les snapshots correspondants restent à régulariser.

## Prochaine étape de clarity-crm_v1.0

Le prochain livrable est le cœur CRM universel : Sociétés, Contacts, Leads, Opportunités enrichies, Rendez-vous, Tâches, Notes, Documents, Produits/Services, Devis, Factures, Contrats, Timeline, recherche, notifications, dashboards et reporting basés sur les données persistantes réelles.

Les objets configurables, pipelines dynamiques, formulaires, automatisations, modules, templates, API générique et webhooks seront construits ensuite sur ce même socle avant la finalisation de `clarity-crm_v1.0`.

## Socle technique

Application Vinext/React avec stockage Cloudflare D1, migrations Drizzle et déploiement Cloudflare Workers via Sites.

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
- migration D1 additive pour les invitations.

### clarity-crm_v0.3

Cycle d'accès renforcé :

- acceptation automatique d'une invitation persistante au premier login ;
- statut de membre `active` / `disabled` appliqué côté serveur ;
- désactivation/réactivation contrôlée depuis l'administration ;
- garde-fou contre l'auto-désactivation d'un administrateur ;
- API `/api/audit` protégée et filtrable par résultat ou type de ressource ;
- journal d'audit admin branché sur les événements serveur.
