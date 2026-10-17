# Lots Developpement

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 21, 24 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 21 — Répartition de travaux aux IA : responsabilités de modules

| Lot | Propriétaire IA suggéré | Chemins exclusifs | Dépendances | Preuve de livraison |
|---|---|---|---|---|
| A | Architecte (cerveau) | docs/adr/, packages/contracts | aucune | ADR + schémas validés |
| B | Core | packages/core/, packages/event-store/ | A | tests machine états/migrations |
| C | Connecteurs | packages/connectors/, connector-* | A,B | fixtures, intégration simulée |
| D | Sécurité | packages/sandbox/, packages/secrets/ | A | tests sandbox + menace |
| E | Git/Deploy | packages/git/, github/, deploy-planner/ | A,D | tests sans production réelle |
| F | UI | apps/desktop/src/, preload/ | A,B | E2E accessibilité |
| G | Voice/Usage | packages/voice/, packages/usage/ | A,D | fixtures + consentement |
| H | QA/review | tests/, docs/testing/ | tous | matrice AC et rapport |

**Intégration :** les modifications de `packages/contracts` sont réservées à A ; tout autre lot propose une modification par issue/PR et attend approbation. Branches `feat/<lot>-<ticket>` ; travaux indépendants via worktrees. QA ne doit pas approuver son propre correctif sans vérification distincte.

## Chapitre 24 — Paquets de contexte pour chaque IA (copier-coller)

**Contexte global `docs/agent-tasks/00_GLOBAL.md` :** vision §1, décisions §2, exigences §5, architecture §7, règles sécurité §12, modèle événements §10-11, définition de DONE §23. Aucune IA ne modifie contrats sans approbation. Ne pas inventer APIs, flags, quotas ou garanties de sandbox. Toujours annoncer hypothèses et tests manquants.

**Template de ticket à fournir à une IA :**

```text
PROJET : Nexus AI. VERSION SOURCE : MASTER SPEC 1.0 (10-10-2026).
TICKET : T-___ ; LOT : ___ ; BRANCHE : feat/___ .
OBJECTIF : [une phrase vérifiable].
LECTURES OBLIGATOIRES : docs/agent-tasks/00_GLOBAL.md, docs/api-contracts/___,
  docs/adr/___, sections ___ de MASTER_SPEC.md.
CHEMINS AUTORISÉS : [...]. CHEMINS INTERDITS : [...].
CONTRATS ENTRÉE : [types + événements + versions].
SORTIES ATTENDUES : [fichiers, tests, docs].
TESTS OBLIGATOIRES : [commandes précises].
POLITIQUE : pas de réseau/deploy/push sans approbation ; ne jamais lire .env/secrets.
DÉFINITION DE TERMINÉ : compilation + tests + revue + rapport d'impact.
EN CAS D'AMBIGUÏTÉ : produire ADR/proposition, ne pas improviser contrat.
RETOUR : résumé, diff, tests, risques, décisions demandées.
```

**Exemple Backend/EventStore :** `T-005`, fichiers limités à `packages/event-store/**`, type `AgentEvent` fourni dans `packages/contracts`, migration `001_init`, test arrêt forcé au milieu d'une séquence et replay exact. **Exemple UI :** `T-017`, afficher liste tâches à partir d'IPC `missions:list` sans lire directement SQLite. **Exemple sécurité :** `T-014`, prouver que processus exécuté ne peut pas ouvrir `~/.ssh/id_*` ni écrire hors worktree ni contacter réseau non autorisé sur Ubuntu ; rapport d'échecs et contexte kernel.
