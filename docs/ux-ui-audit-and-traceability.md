# Clarity CRM — archive d’audit UX/UI

> Ce document est une archive du merge UX/UI `85c9fe1`. Il ne constitue pas une matrice de traçabilité ni une déclaration de fonctionnement actuel. La référence unique est [`docs/traceability-v1.0.md`](traceability-v1.0.md).

## Baseline auditée

- Référence : `867ff1c169851916d954caf8c8c64cfd28260656` (`main`).
- Frontend : Next.js 16, React 19, TypeScript strict, Tailwind 4 et composants Shadcn.
- Écrans : shell CRM principal, console CRM universelle `/v1`, activation et authentification.
- État : session native, contexte tenant résolu côté serveur, RBAC par objet/action/scope, APIs CRM, timeline, configurations, formulaires, automatisations, webhooks et audit déjà présents.
- Responsive : `Sidebar` Shadcn, grilles Tailwind et styles mobiles existent ; il n'y avait pas de stratégie unifiée de densité ni de palette de commandes réelle.
- Tests existants : sécurité d'authentification, RBAC, administration, politiques CRM, SSRF webhooks et migrations. Aucun test de composant UI n'était présent.

| Élément existant | Décision | Justification |
| --- | --- | --- |
| Routes API, `lib/authz*`, politiques CRM, schéma et migrations | CONSERVER | Source de vérité pour les permissions, le tenant et les contrats. |
| `components/ui/*` (Shadcn, Sonner, Command, Sidebar) | CONSERVER | Primitives accessibles déjà installées et compatibles. |
| `app/crm-shell.tsx` | RETIRÉ DE LA ROUTE PRINCIPALE | Contient des données de démonstration ; `/` utilise désormais `V1Console` reliée aux API persistantes. |
| `app/v1/v1-console.tsx` | COMPLÉTER | Fonctionnalités réelles CRM/configuration déjà reliées aux API, mais UX technique à intégrer progressivement. |
| `app/globals.css` | COMPLÉTER | Tokens existants ; consolidation nécessaire pour la direction visuelle officielle. |
| Backend et modèle de données | CONSERVER | Une refonte visuelle ne justifie aucune modification métier. |
| API `/api/crm/search` | RÉUTILISER | Recherche serveur déjà authentifiée, tenant-aware et bornée. |

## Historique des décisions UX du merge

| Exigence | Composant / page | Implémentation | Test | Statut |
| --- | --- | --- | --- | --- |
| Tokens de design officiels | `app/globals.css` | Couleurs, espacements, ombre overlay, transition, rayons | Typecheck + lint | OK UX-1 |
| Sidebar stable / accueil explicite | `CRMShell` | Libellé `Accueil`, shell existant conservé | Lint | OK UX-1 |
| Ctrl/Cmd+K et `/` | `CRMShell`, `CommandPalette` | Raccourcis clavier, Escape et dialogue accessible | Typecheck + lint | OK UX-1 |
| Recherche globale tenant-aware | `CommandPalette` | Réutilise `/api/crm/search`, résultats groupés par type | Tests RBAC existants + typecheck | OK UX-1 |
| Actions rapides contextualisées | `CommandPalette` | Accueil, pipeline, création d'opportunité, administration conditionnelle | Typecheck + lint | OK UX-1 |
| Compact / Confort | `CRMShell`, `globals.css` | Préférence locale persistée et styles communs | Typecheck + lint | OK UX-1 |
| Accueil orienté décisions | `DashboardView` | KPI actionnables et montants calculés à partir du pipeline chargé | Typecheck + lint | OK UX-2 |
| Action Center | `DashboardView` | Centre d'actions dérivé des opportunités ouvertes et de leur stade ; aucune tâche fictive créée | Typecheck + lint | Partiel UX-2 |
| Kanban, déplacement, undo | `PipelineView` | Drag-and-drop HTML, sélecteur d'étape clavier/tactile, PATCH serveur, rollback d'erreur et toast Annuler après succès | Typecheck + lint | OK UX-3 |
| Fiche 360° | `V1Console` / détail Record | Identité, informations prioritaires, timeline réelle, contexte et données avancées repliables | Typecheck + lint | OK UX-4 |
| Objets, formulaires, pipelines | Console `/v1` | Studio versionné, progressive disclosure JSON, historique/restauration, formulaires générés depuis les champs configurés | Typecheck + lint + tests API existants | Partiel UX-5 (vues configurables dédiées à compléter) |
| Workflow builder | Automatisations | Cartes Déclencheur → Conditions → Actions, flux JSON repliable, activation/désactivation via PATCH RBAC | Typecheck + lint + tests RBAC existants | Partiel UX-6 (simulation non ajoutée : endpoint actuel exécute réellement) |
| Compact / Confort et raccourcis | `CRMShell`, `CommandPalette` | Densité persistée, Ctrl/Cmd+K, `/`, Escape et actions rapides | Typecheck + lint | OK UX-7 |
| Navigation mobile | `CRMShell` | Barre d’accès Accueil, Pipeline, Créer et Rechercher avec zones tactiles | Typecheck + lint | OK UX-8 |
| Accessibilité de base | Shell et composants UI | Focus visible global, alternative clavier au drag/drop, labels et reduced-motion | Typecheck + lint | Partiel UX-8 |
| Responsive et performance perçue | `globals.css`, shell | Layout mobile/tablette existant consolidé, débordement horizontal limité, pas de nouveau bundle lourd | Typecheck + lint | Partiel UX-8 |

## Limites connues après UX-6

- Les vues configurables dédiées (colonnes, filtres persistants) n'ont pas de contrat backend distinct dans l'état audité ; aucune API n'a été inventée.
- Les actions de tâches, de priorisation à l'échéance et de score ne disposent pas encore d'un contrat backend explicitement exploitable dans le shell.
- Le build Next local est bloqué par l'environnement de conteneur (`uv_resident_set_memory` absent), avant la compilation applicative. Lint, typecheck et tests unitaires restent exécutables.
