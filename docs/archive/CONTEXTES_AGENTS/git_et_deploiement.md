# Contexte de mission : git_et_deploiement

> Nexus AI — version documentaire 1.1, 10 octobre 2026. Statut : spécification, pas implémentation.

## Mission
Git worktrees, GitHub, revue, Vercel preview/prod.

## Fichiers de contexte obligatoires
- `00_START_HERE.md`, `ID/idee.md`, `GOUVERNANCE/decisions_et_priorites.md`.
- INTEGRATIONS/github_git.md
-  INTEGRATIONS/vercel_hebergement.md.

## Propriété des chemins
`packages/git/**; packages/github/**; packages/deploy-vercel/**`. **Interdit de modifier les contrats partagés hors lot sans ADR approuvée.**

## Tickets ciblés
T-016,T-018,T-019 (voir `TICKETS/`).

## Livrables
Tests reproductibles, documentation utilisateur/développeur, changements versionnés, journal des décisions, rapport de preuve. Le sandbox n'est jamais remplacé par une simple règle de prompt.

## Format réponse attendue
1. Ce qui a été implémenté ; 2. chemins modifiés ; 3. tests réellement exécutés et résultats ; 4. risques ; 5. dépendances ; 6. ambiguïtés à escalader ; 7. suite exacte.
