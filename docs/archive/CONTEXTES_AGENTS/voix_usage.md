# Contexte de mission : voix_usage

> Nexus AI — version documentaire 1.1, 10 octobre 2026. Statut : spécification, pas implémentation.

## Mission
Saisie vocale, transcription, métriques et provenance.

## Fichiers de contexte obligatoires
- `00_START_HERE.md`, `ID/idee.md`, `GOUVERNANCE/decisions_et_priorites.md`.
- INTEGRATIONS/voix.md
-  INTEGRATIONS/quotas_et_comptes.md.

## Propriété des chemins
`packages/voice/**; packages/usage/**`. **Interdit de modifier les contrats partagés hors lot sans ADR approuvée.**

## Tickets ciblés
T-020,T-021 (voir `TICKETS/`).

## Livrables
Tests reproductibles, documentation utilisateur/développeur, changements versionnés, journal des décisions, rapport de preuve. Le sandbox n'est jamais remplacé par une simple règle de prompt.

## Format réponse attendue
1. Ce qui a été implémenté ; 2. chemins modifiés ; 3. tests réellement exécutés et résultats ; 4. risques ; 5. dépendances ; 6. ambiguïtés à escalader ; 7. suite exacte.
