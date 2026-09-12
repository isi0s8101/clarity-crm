# Moteur de configuration v0.3

## Architecture

Le moteur unique persiste toutes les définitions dans `crm_configurations` et chaque instantané dans `crm_configuration_versions`. Le runtime PostgreSQL est la source de vérité. Les objets personnalisés utilisent `crm_records`, les relations utilisent `crm_relations` et les formulaires appellent le même service `createCrmRecord` que l'API générique.

Les mutations passent par `/api/configurations`, l'authentification native, le tenant serveur et la permission `crm_configuration:administer`. La création ou la mise à jour de la configuration et de son snapshot est atomique. Chaque restauration copie un ancien snapshot dans une nouvelle version ; aucune version existante n'est écrasée.

## Définitions supportées

- `object` : `key`, `label`, `fields[]` ; la clé ne peut pas remplacer un objet natif.
- `pipeline` : `key`, `objectType`, `stages[]` ordonnées et `transitions[]` facultatives ; plusieurs pipelines peuvent cibler le même objet.
- `form` : `key`, `objectType`, `fields[]` ordonnés ; les champs d'un objet personnalisé doivent exister.
- `relation` : `key`, `sourceType`, `targetType`, `cardinality` parmi `one_to_one`, `one_to_many`, `many_to_one`, `many_to_many`.
- les types historiques `automation`, `module`, `template` et `webhook` restent dans ce même moteur.

Types de champs : `text`, `textarea`, `number`, `currency`, `boolean`, `date`, `datetime`, `select`, `email`, `phone`, `relation`. Les règles disponibles sont `required`, `min`, `max`, `minLength`, `maxLength`, `pattern`, `options` et, pour un champ relation, `targetType`.

## Invariants

- validation serveur obligatoire lors de la configuration et lors de chaque écriture métier ;
- clé stable et unique par tenant/type de configuration ;
- objets référencés actifs et dans le même tenant ;
- étape appartenant au pipeline et pipeline ciblant le bon objet ;
- relation configurable appliquée par le moteur `crm_relations` existant, sans second stockage ;
- cardinalité contrôlée avant insertion ;
- références cross-tenant refusées par l'API et PostgreSQL ;
- modification incompatible avec des données existantes refusée ;
- restauration créant une nouvelle version auditée, sans écraser l'historique.

Les relations historiques sans configuration restent acceptées pour compatibilité. Dès qu'une clé de relation est configurée, ses types, son état et sa cardinalité sont appliqués.

## Validation

La recette `scripts/ci-e2e-v03-configuration-postgres.sh` couvre login admin, tenant, champs, formulaire, pipelines multiples, relation configurable, versionnement/restauration, audit, refus cross-tenant, refus sans permission et compatibilité des données existantes.
