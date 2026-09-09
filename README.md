# Clarity CRM — clarity-crm_v0.3

CRM professionnel modulaire conçu pour piloter les ventes, configurer les objets métier, automatiser les tâches et gouverner les accès sans complexité excessive.

## Capacités

- dashboard commercial et prévisionnel ;
- pipeline personnalisable avec opportunités persistantes ;
- objets métier et règles de gouvernance ;
- automatisations no-code guidées ;
- rôles, droits fins et contrôles sensibles ;
- catalogue de modules maîtrisé ;
- import CSV contrôlé, export et API ;
- journal d’audit attribué et horodaté.

## Socle

Application Vinext/React avec stockage Cloudflare D1, migrations Drizzle et déploiement Cloudflare Workers via Sites.

## clarity-crm_v0.1

Fondations ajoutées :

- authentification obligatoire via identité transmise par la plateforme ;
- organisations, utilisateurs, équipes, appartenances, rôles et permissions persistants ;
- isolation tenant côté serveur sur les opportunités ;
- profils `admin` et `user` avec permissions par objet, action et périmètre ;
- audit enrichi : acteur, tenant, action, ressource, résultat, avant/après ;
- export CSV servi par API protégée.

Sauvegarde/restauration : avant publication en production, conserver l’archive source Git et l’état D1 courant. Les migrations Drizzle sont additives pour préserver les opportunités et audits existants.

## clarity-crm_v0.2

Administration réelle ajoutée :

- API admin protégée pour membres, équipes, invitations et permissions ;
- écran Droits & équipes branché sur les données persistantes ;
- création d’équipe et invitation utilisateur auditables ;
- modification de rôle/équipe avec garde-fou contre l’auto-rétrogradation admin ;
- modification de périmètre de permission avec refus d’administration pour le profil utilisateur ;
- migration D1 additive pour les invitations.

## clarity-crm_v0.3

Cycle d’accès renforcé :

- acceptation automatique d’une invitation persistante au premier login ;
- statut de membre `active` / `disabled` appliqué côté serveur ;
- désactivation/réactivation contrôlée depuis l’administration ;
- garde-fou contre l’auto-désactivation d’un administrateur ;
- API `/api/audit` protégée et filtrable par résultat ou type de ressource ;
- journal d’audit admin branché sur les événements serveur.
