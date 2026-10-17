# Coordination Hermes ↔ Claude

> **Historique.** Cette boîte aux lettres Hermes ↔ Claude n'est plus utilisée depuis le 11/10/2026 (Hermes ne participe
> plus au développement). L'état courant est dans `STATUS.md`, les décisions dans `DECISIONS.md`, les conventions dans
> `CLAUDE.md` à la racine.

Boîte aux lettres fichier entre les deux agents du projet. Approuvée par le propriétaire le 10/10/2026.
Elle ne remplace ni les règles de `docs/00_START_HERE.md`, ni le plan `.hermes/plans/`, ni les ADR.

## Rôles

- **Hermes** : architecte et intégrateur. Il ouvre les tickets, relit, accepte les ADR et possède
  `packages/contracts/**`. Il est **le seul à commiter**, et seulement après relecture.
- **Claude** : exécute un ticket à la fois dans un worktree dédié `feat/<lot>-T-xxx`. Il ne commite
  **jamais**, ne pousse jamais, n'installe rien et ne s'authentifie à rien.
- **Propriétaire** : tranche toutes les décisions listées dans `DECISIONS.md`.

## Structure

```
.coordination/
  README.md        ce protocole
  STATUS.md        tableau des tickets (mis à jour par l'auteur de chaque changement d'état)
  DECISIONS.md     file des décisions en attente du propriétaire
  inbox/hermes/    messages destinés à Hermes   (traités → inbox/hermes/done/)
  inbox/claude/    messages destinés à Claude   (traités → inbox/claude/done/)
```

## Format d'un message

Nom de fichier : `AAAAMMJJTHHMMSS-<de>-<sujet-court>.md` (heure UTC). Un message = un fichier,
jamais modifié après dépôt. Pour répondre, déposer un nouveau message avec `reply_to`.

```markdown
---
id: 20261010T231500-claude-t001-handoff
from: claude            # claude | hermes
to: hermes
type: handoff           # handoff | request | review | answer | blocker | ack
ticket: T-001
reply_to:               # id du message auquel on répond (facultatif)
needs_owner: false      # true = le destinataire ne peut pas agir sans décision du propriétaire
---

Corps libre : résumé, fichiers, commandes exécutées et résultats, demandes précises.
```

Le destinataire déplace le message dans `done/` une fois traité.

## Points d'arrêt obligatoires (aucune boucle ne les franchit)

La boucle d'un agent se met **en pause** et l'agent prévient le propriétaire dès qu'une action demande :
- une décision listée dans `DECISIONS.md` ;
- un commit, un push, une PR ou un déploiement (commit : Hermes seulement ; le reste exige l'accord du propriétaire) ;
- l'installation d'un outil ou d'un paquet, une authentification, l'accès à un secret ;
- un changement de périmètre, de contrat public ou de permission.

Un agent n'approuve jamais son propre travail, et les deux agents ne peuvent pas lever ensemble une
décision qui revient au propriétaire.

## Garde-fous de boucle

- Côté Claude : relecture de `inbox/claude/` toutes les 10 à 30 minutes ; arrêt après 8 relectures
  consécutives sans nouveau message ; aucune relance automatique d'un ticket en échec plus de 2 fois.
- Aucun secret, jeton ni chemin d'authentification dans les messages.

## Décisions du propriétaire

Le propriétaire répond directement dans `DECISIONS.md`, sur la ligne `Réponse :` de chaque décision.
L'agent concerné la reprend à sa relecture suivante.
