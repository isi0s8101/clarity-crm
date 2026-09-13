# Clarity CRM v0.3 — administration et exploitation

## Périmètre

Ce document décrit la fermeture opérationnelle v0.3. Il ne crée aucun moteur métier supplémentaire : les configurations restent dans `crm_configurations`, les automatisations utilisent `automation_jobs` et le worker PostgreSQL existant, et les webhooks réutilisent le même moteur de configuration et la même queue.

## Configurations

L'administration passe par `/api/configurations` et exige `crm_configuration:administer` pour les mutations. La clé technique est immuable après création. Chaque modification et chaque restauration crée une nouvelle version dans `crm_configuration_versions` et produit un événement d'audit.

L'éditeur couvre les objets, champs personnalisés, formulaires, pipelines, relations, modules et templates. Les contrôles de références, de compatibilité avec les données existantes, de cardinalité, de transitions, de tenant et de RBAC restent autoritatifs côté serveur.

Historique : `GET /api/configurations?historyId=<id>`. Restauration : `PATCH /api/configurations` avec `{ "id": "...", "restoreVersion": 2 }`.

## Automatisations

`GET /api/automations` accepte `status`, `limit` et `offset`. `GET /api/automations?jobId=<id>` retourne le job et les runs partageant sa corrélation. Les états exposés sont `pending`, `running`, `retrying`, `success`, `failed`.

Une relance administrative d'un job `failed` utilise `PATCH /api/automations` avec `{ "jobId": "...", "action": "retry" }`. Une annulation est volontairement limitée aux jobs `pending` ou `retrying`; un job déjà `running` n'est pas interrompu de force. Les deux actions exigent `automation:administer`, sont tenant-aware et auditées.

## Webhooks

`GET /api/webhooks` accepte `status`, `direction`, `webhookId`, `limit` et `offset`. Les livraisons sortantes persistantes enregistrent `correlationId` et `jobId` après la migration `0007_webhook_delivery_operations.sql`.

Une livraison sortante `failure` peut être remise en file avec `PATCH /api/webhooks` et `{ "deliveryId": "...", "action": "retry" }`. La relance est ciblée sur le webhook concerné et utilise un job `webhook_only` dans la queue PostgreSQL existante; elle ne rejoue ni les autres webhooks ni les automatisations.

`GET /api/webhooks/secret?key=<key>` ne renvoie jamais le secret réel. La réponse contient uniquement une valeur masquée, l'algorithme et une empreinte courte permettant d'identifier la clé opérationnelle sans la divulguer.

Les protections SSRF, résolution DNS, blocage des réseaux privés/réservés, limites de taille, HMAC, timeouts, journalisation, idempotence, tenant et RBAC restent dans les composants existants.

## Erreurs et pagination

Les routes d'exploitation normalisées conservent le champ historique `error` pour compatibilité UI et ajoutent un champ `code`. Les paramètres de pagination invalides répondent en HTTP 400. Les listes restent strictement limitées au tenant résolu côté serveur; aucun filtre de tenant arbitraire n'est exposé.

## Limites volontaires

La v0.3 n'introduit pas de vue cross-tenant globale, de dead-letter queue séparée, de purge automatique destructive ni de rotation de secret avec période de grâce. Ces fonctions nécessiteraient une politique de gouvernance supplémentaire et ne sont pas nécessaires à la fermeture sûre de la baseline v0.3.
