# Contexte de mission : interface

> Nexus AI — version documentaire 1.1, 10 octobre 2026. Statut : spécification, pas implémentation.

## Mission
Interface React, Monaco, xterm, panneaux, IPC preload.

## Fichiers de contexte obligatoires
- `00_START_HERE.md`, `ID/idee.md`, `GOUVERNANCE/decisions_et_priorites.md`.
- INTERFACE/experience_utilisateur.md
-  ARCHITECTURE/contrats_ipc_evenements.md.

## Propriété des chemins
`apps/desktop/src/**; apps/desktop/preload/**`. **Interdit de modifier les contrats partagés hors lot sans ADR approuvée.**

## Tickets ciblés
T-002,T-003,T-017 (voir `TICKETS/`).

## Livrables
Tests reproductibles, documentation utilisateur/développeur, changements versionnés, journal des décisions, rapport de preuve. Le sandbox n'est jamais remplacé par une simple règle de prompt.

## Format réponse attendue
1. Ce qui a été implémenté ; 2. chemins modifiés ; 3. tests réellement exécutés et résultats ; 4. risques ; 5. dépendances ; 6. ambiguïtés à escalader ; 7. suite exacte.
