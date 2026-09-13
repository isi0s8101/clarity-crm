# Clarity CRM v1.3 — traçabilité Integration Manager

## Périmètre

La v1.3 ajoute une couche d'intégration gouvernée au-dessus du CRM existant. Elle ne remplace ni `crm_records`, ni Inbox, ni Planning, ni Documents, ni les configurations, ni la queue PostgreSQL, ni le worker automation. Les fournisseurs restent des adaptateurs externes.

Fournisseurs couverts : Google Workspace, Microsoft 365, n8n et LDAP / Active Directory en lecture seule.

Migration additive unique : `postgres/migrations/0010_v13_integrations.sql`. Les migrations `0001` à `0009` restent inchangées.

## Invariants

- résolution du tenant côté serveur et filtres `tenant_id` sur toutes les lectures/écritures d'intégration ;
- permissions dédiées `integration`, `integration_authorization`, `integration_sync`, `integration_revoke`, `integration_logs` ;
- secrets uniquement dans `integration_credentials`, chiffrés AES-256-GCM avec AAD tenant/connexion/type de secret ;
- aucun secret dans `configuration`, `sync_policy`, mappings, audit, Health Center ou réponses API ;
- OAuth2 avec state, nonce et PKCE pour Google/Microsoft ;
- synchronisations via `automation_jobs` et le worker existant, sans queue ni scheduler parallèle ;
- curseurs fournisseurs durables séparés des curseurs de pagination ;
- liens externes idempotents via `integration_resource_links` ;
- suppression externe non destructive par défaut ;
- mappings explicites avec direction et politique de conflit ;
- n8n réutilise la validation SSRF/DNS/IP et le transport HTTPS épinglé du moteur webhook existant ;
- LDAP/AD impose `ldaps://`, TLS >= 1.2, validation du certificat et aucun write-back ;
- les groupes LDAP/AD ne créent aucun objet CRM sans mapping explicite.

## Modèle PostgreSQL v1.3

`0010_v13_integrations.sql` crée :

- `integration_connections` ;
- `integration_credentials` ;
- `integration_oauth_transactions` ;
- `integration_mappings` ;
- `integration_sync_cursors` ;
- `integration_sync_runs` ;
- `integration_resource_links` ;
- `integration_health_events` ;
- `integration_rate_limits`.

Les FK tenant + connexion empêchent de rattacher credentials, mappings, curseurs, runs, liens, événements Health ou quotas à une connexion d'un autre tenant.

## Normalisation métier

| Ressource externe | Cible Clarity par défaut | Comportement |
| --- | --- | --- |
| Gmail / Outlook mail | Inbox | conversation + message idempotent par identifiant fournisseur |
| Google / Microsoft contacts | `crm_records/contact` | création / mise à jour selon mapping et politique de conflit |
| Google / Microsoft calendar | `crm_records/appointment` + Planning | synchronisation de la réservation quand la cible reste `appointment` |
| Drive / OneDrive files | `crm_records/document` | lien externe, sans duplication du moteur documentaire |
| LDAP `directory.users` | `crm_records/contact` | lecture seule, mapping configurable |
| LDAP `directory.groups` | aucune | mapping explicite obligatoire |

Politiques : `external_wins`, `clarity_wins`, `manual`. Un conflit `manual` produit un résultat partiel explicite au lieu d'écraser silencieusement une fiche.

## Integration Manager / Health Center

L'interface administrateur `app/v1/v13-integrations-manager.tsx` permet :

- lister le catalogue et les connexions du tenant ;
- créer une connexion et sa politique de synchronisation ;
- lancer OAuth pour Google/Microsoft ;
- définir `client_secret`, `webhook_secret` ou `bind_password` sans réaffichage ;
- tester une connexion ;
- déclencher une synchronisation manuelle ;
- créer les mappings ;
- réinitialiser un checkpoint d'une ressource ;
- consulter credentials sous forme de métadonnées, événements Health et runs récents ;
- désactiver ou révoquer une connexion.

L'UI n'est montée que pour `actor.role === "admin"`.

## Help Center

`lib/help/catalog-v13.js` fournit les procédures :

- `ADM-V13-INTEGRATION-001` — création et sécurisation d'une connexion ;
- `ADM-V13-OAUTH-001` — OAuth Google/Microsoft ;
- `ADM-V13-SYNC-001` — mappings et synchronisations ;
- `HELP-V13-CHECKPOINT-001` — reprise après token/checkpoint invalide ;
- `ADM-V13-N8N-001` — webhook n8n signé ;
- `ADM-V13-LDAP-001` — LDAP / Active Directory lecture seule.

Le catalogue est enregistré dans `lib/help/catalog-all.js`.

## Recettes automatisées

### `scripts/ci-upgrade-v12-to-v13-postgres.sh`

- reconstruit une base v1.2 avec migrations `0001` à `0009` ;
- injecte des sentinelles CRM et Planning v1.2 ;
- exécute le migrateur courant ;
- exige `0010_v13_integrations.sql` exactement une fois ;
- vérifie toutes les tables v1.3 et contraintes principales ;
- vérifie la conservation des données v1.2 ;
- rejoue le migrateur pour tester l'idempotence ;
- succès attendu : `V12_TO_V13_UPGRADE=OK`.

### `scripts/ci-e2e-v13-postgres.sh`

- authentification admin réelle ;
- catalogue Google/Microsoft/n8n/LDAP ;
- création d'une connexion Google ;
- secret chiffré et absent des réponses/configurations ;
- Health Center limité aux métadonnées de credentials ;
- mapping valide ;
- rejet d'un mapping contenant une clé sensible ;
- reset de checkpoint ;
- isolation tenant / BOLA ;
- audit de création et de reprise ;
- succès attendu : `V13_POSTGRES_E2E=OK`.

### `scripts/ci-backup-restore-v13-postgres.sh`

- injecte une connexion, credential chiffré sentinelle, mapping, curseur, run, lien, événement Health et état de quota ;
- produit un `pg_dump` custom ;
- restaure dans une base neuve ;
- vérifie `0010` et chaque donnée sentinelle ;
- succès attendu : `V13_BACKUP_RESTORE=OK`.

## CI

`.github/workflows/ci-v13.yml` exécute sur PostgreSQL 17 :

1. validation syntaxique des scripts ;
2. `npm ci` ;
3. `npm run lint` ;
4. `npm test` ;
5. `npx tsc --noEmit` ;
6. `npm run build` ;
7. upgrade v1.2 → v1.3 ;
8. migration courante ;
9. bootstrap admin ;
10. E2E Integration Manager ;
11. backup / restore v1.3.

La CI historique et `CI v1.2` restent actives et doivent également rester vertes.

## Smoke-tests fournisseurs réels

Les appels externes ne sont jamais exécutés automatiquement sur un push/PR. Le script `scripts/smoke-v13-providers-real.sh` exige `CLARITY_REAL_PROVIDER_SMOKE=1` et travaille contre une instance Clarity déjà configurée.

Le workflow manuel `.github/workflows/smoke-v13-providers.yml` utilise l'environnement GitHub `v13-provider-smoke`. Les secrets attendus sont :

- `CLARITY_SMOKE_BASE_URL` ;
- `CLARITY_SMOKE_ADMIN_EMAIL` ;
- `CLARITY_SMOKE_ADMIN_PASSWORD`.

Les IDs de connexions sont fournis à `workflow_dispatch`. Le mode `run_sync=true` exécute aussi un pull réel et exige que le worker de l'instance soit actif.

Résultat attendu : `V13_REAL_PROVIDERS_SMOKE=OK`.

Un smoke fournisseur réel ne peut être déclaré validé qu'après exécution avec de vrais comptes/credentials sur un environnement autorisé. La présence du script et du workflow ne vaut pas validation fournisseur.

## Critères GO / NO-GO

GO v1.3 uniquement si :

- `CI`, `CI v1.2` et `CI v1.3` sont vertes sur le même HEAD final ;
- upgrade, E2E et backup/restore v1.3 sont verts ;
- aucun secret n'apparaît dans les logs/artefacts de validation ;
- l'isolation tenant/BOLA est verte ;
- les smoke-tests réels requis par le déploiement ont été exécutés et documentés, ou sont explicitement déclarés hors prérequis de merge mais obligatoires avant activation des fournisseurs en production.

Tout échec de migration, build, isolation tenant, chiffrement/secret, backup/restore ou fournisseur requis entraîne NO-GO.
