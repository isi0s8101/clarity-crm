# Clarity CRM — Corpus documentaire client 00→10

Ce répertoire contient le corpus documentaire de remise client complet, versionné avec le dépôt Clarity CRM.

## Baseline

- Dépôt : `isi0s8101/clarity-crm`
- Branche source : `main`
- Commit de référence : `14431424d2b8b981e5eda24937e12727098b2520`
- Corpus : `clarity-crm_corpus-valide_00-10_v1.zip`

## Contenu du corpus

- `00_GOUVERNANCE/`
- `01_INSTALLATION/`
- `02_EXPLOITATION/`
- `03_ADMINISTRATION_FONCTIONNELLE/`
- `04_METIER/`
- `05_GARANTIES_TECHNIQUES/`
- `06_ARCHITECTURE/`
- `07_RECETTE_ACCEPTATION/`
- `08_PRA_CONTINUITE/`
- `09_ROADMAP_LIMITES/`
- `10_ANNEXES/`

## Convention

- `PROC-<DOMAINE>-000` : procédure chapeau.
- `PROC-<DOMAINE>-001...NNN` : procédures élémentaires.
- `I-*` : installation/déploiement.
- `O-*` : exploitation technique.
- `A-*` : administration fonctionnelle.
- `M-*` : métier.
- `T-*` : garanties techniques/invariants.
- `R-*` : roadmap/limites.
- `ARC-*` : architecture.
- `REC-*` : recette/acceptation.
- `PRA-*` : continuité/reprise.

## Utilisation

Extraire l’archive dans un espace documentaire contrôlé :

```bash
unzip clarity-crm_corpus-valide_00-10_v1.zip
```

Ne jamais ajouter de secret réel dans ces documents. Les fonctions v1.3 non fermées de bout en bout restent explicitement marquées PARTIEL / NON PRÉSENT dans le corpus.
