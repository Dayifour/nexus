# Contexte de mission : securite

> Nexus AI — version documentaire 1.1, 10 octobre 2026. Statut : spécification, pas implémentation.

## Mission
Sandbox OS, permissions, coffre secrets, modélisation menaces.

## Fichiers de contexte obligatoires
- `00_START_HERE.md`, `ID/idee.md`, `GOUVERNANCE/decisions_et_priorites.md`.
- SECURITE/politique.md
-  SECURITE/matrice_permissions.md.

## Propriété des chemins
`packages/sandbox/**; packages/secrets/**; docs/threat-model/**`. **Interdit de modifier les contrats partagés hors lot sans ADR approuvée.**

## Tickets ciblés
T-014,T-015 (voir `TICKETS/`).

## Livrables
Tests reproductibles, documentation utilisateur/développeur, changements versionnés, journal des décisions, rapport de preuve. Le sandbox n'est jamais remplacé par une simple règle de prompt.

## Format réponse attendue
1. Ce qui a été implémenté ; 2. chemins modifiés ; 3. tests réellement exécutés et résultats ; 4. risques ; 5. dépendances ; 6. ambiguïtés à escalader ; 7. suite exacte.
