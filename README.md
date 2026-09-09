# Clarity CRM — clarity-crm_v0.1

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
