# Clarity CRM v1.0 - gouvernance GitHub

Ce document fixe les actions de gouvernance attendues pour stabiliser la baseline PostgreSQL.

## État observé

- Branche de référence : `main`.
- Commit baseline observé : `5fab02b4f663f3e6355de7dfaadeafab74d746ec`.
- CI observée sur `main` : `verify-posix` en succès.
- Branches derrière `main` : `feat/posix-production-foundations`, `fix/legacy-d1-postgres-migration`.
- Branche identique à `main` : `fix/legacy-preflight-offline`.
- Branche divergée : `fix/posix-runtime-and-lint`, à analyser commit par commit avant suppression ou cherry-pick.

## Actions de nettoyage

1. Garder `main` comme seule branche longue durée.
2. Supprimer après vérification les branches déjà intégrées ou obsolètes :
   - `feat/posix-production-foundations`
   - `fix/legacy-d1-postgres-migration`
   - `fix/legacy-preflight-offline`
3. Analyser `fix/posix-runtime-and-lint` avec `git log main..fix/posix-runtime-and-lint --oneline` puis cherry-pick uniquement les commits utiles.
4. Créer le tag baseline après merge de la présente PR :
   `clarity-crm_v1.0-postgres-foundation`.

## Protection attendue de main

Paramètres GitHub recommandés :

- Require a pull request before merging.
- Require status checks to pass before merging.
- Required check : `verify-posix`.
- Block force pushes.
- Block branch deletion.
- Require linear history ou squash merge propre.
- Option recommandé : require signed commits si le flux local le supporte.

## Commandes de référence

Contexte attendu : poste mainteneur avec `git` et droits push sur le dépôt.

```bash
git fetch origin --prune

git branch -r --contains origin/main

git push origin --delete feat/posix-production-foundations
git push origin --delete fix/legacy-d1-postgres-migration
git push origin --delete fix/legacy-preflight-offline

git log --oneline --decorate origin/main..origin/fix/posix-runtime-and-lint
```

Création du tag baseline après merge :

```bash
git checkout main
git pull --ff-only origin main
git tag -a clarity-crm_v1.0-postgres-foundation -m "Baseline Clarity CRM v1.0 PostgreSQL foundation"
git push origin clarity-crm_v1.0-postgres-foundation
```
