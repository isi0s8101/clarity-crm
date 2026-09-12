# Centre d'aide Clarity CRM

## Architecture

Le centre d'aide est déterministe et consomme les fondations existantes :

- `/help`, `/help/user`, `/help/admin`, `/help/procedure/[procedureId]`, `/help/troubleshooting`, `/help/glossary`
- `components/help/*` pour la recherche, les cartes, le drawer, les prérequis et le wizard
- `lib/help/catalog.js` pour le catalogue initial
- `lib/help/resolver.js` pour le filtrage rôle/permission/contexte
- `lib/help/search.js` pour la recherche instantanée
- `lib/help/progress.js` pour la progression locale
- `/api/help/context` pour lire le rôle, le tenant et les permissions réelles côté serveur

Le système ne crée pas de second moteur d'authentification, de tenant, de RBAC ou de recherche CRM.

## Format d'une procédure

Le type de référence est `HelpProcedure` dans `lib/help/types.ts`.

Champs obligatoires :

- `id` : identifiant stable
- `version` : entier positif
- `title`, `description`
- `roles` : `user`, `admin`
- `contexts` : vues ou domaines applicatifs
- `permissions` : permissions existantes à consommer, jamais à accorder
- `recordTypes` : types CRM concernés si applicable
- `prerequisites` : autres procédures référencées
- `tags`
- `steps` : étapes clic par clic
- `result`
- `troubleshooting`

## Convention des IDs

Préfixes utilisés :

- `COM-*` : procédures communes non dupliquées
- `USR-*` : procédures utilisateur
- `ADM-*` : procédures administrateur
- `HELP-ERR-*` : dépannage

Un ID reste stable même si le contenu évolue. En cas de changement significatif, incrémenter `version`.

## Ajouter une procédure

1. Ajouter l'entrée dans `lib/help/catalog.js`.
2. Réutiliser un prérequis commun au lieu de recopier ses étapes.
3. Vérifier que les libellés correspondent à l'interface réelle.
4. Ajouter `permissions` lorsque l'action dépend du RBAC.
5. Marquer explicitement une fonction partielle avec une étape du type `Interface non disponible dans cette version`.
6. Lancer `npm test`.

## Ajouter un contexte

1. Ajouter ou mapper la vue dans `lib/help/contexts.js`.
2. Transmettre ce contexte depuis le shell ou depuis la page concernée.
3. Vérifier que `recommendProcedures()` retourne au maximum quatre procédures pertinentes.

## Référencer un prérequis

Utiliser l'ID dans `prerequisites`.

Exemple :

```js
prerequisites: ["COM-CNX-001", "COM-REC-001"]
```

Ne recopier les étapes de connexion, recherche, ouverture de fiche ou consultation d'audit dans aucune procédure métier.

## Tests

Le test `lib/help.test.mjs` vérifie :

- unicité des IDs ;
- prérequis existants ;
- absence de cycles évidents ;
- versions et rôles valides ;
- filtrage user/admin ;
- filtrage permissions ;
- recherche ;
- recommandations contextuelles limitées à quatre ;
- clé et invalidation de progression locale.

Commandes :

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

## Sécurité

- Les permissions existantes restent la source de vérité.
- L'aide ne doit jamais masquer ou contourner un refus RBAC.
- La progression locale stocke uniquement `version`, `step`, `completed`.
- Ne jamais stocker en `localStorage` : noms de clients, emails CRM, IDs sensibles, tokens, secrets, cookies ou clés API.
- Ne jamais documenter une méthode de contournement SSRF.
- Les procédures administrateur ne sont proposées que si le rôle serveur est `admin`.

## Anti-redondance

Les opérations communes doivent être factorisées :

- connexion : `COM-CNX-001`
- déconnexion : `COM-CNX-002`
- changement d'organisation : `COM-TEN-001`
- recherche globale : `COM-SRCH-001`
- ouverture d'une fiche : `COM-REC-001`
- consultation audit : `COM-AUD-001`

Toute procédure qui dépend de ces actions doit les référencer dans `prerequisites`.