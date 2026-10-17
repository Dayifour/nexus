# Systeme

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 7, 10 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 7 — Architecture cible, frontières de confiance

```text
Renderer React (UNTRUSTED UI)
    ⇅ IPC strictement typé via preload/contextBridge
Electron Main (fenêtres, dialogues, permissions, cycle de vie)
    ⇅ contrôleur local / service isolable
Core orchestrator (état, planificateur, politiques, budgets)
    ├── Event Store SQLite + snapshots + migrations
    ├── Registry connecteurs et inventaire CLI
    ├── Task DAG + scheduler + message bus
    ├── Sandbox Broker + Secret Broker + Process Supervisor
    ├── Git/Worktree Broker + GitHub Broker
    ├── Vercel Deploy Broker
    ├── Usage Meter / Voice transcription adapter
    └── CLI adapters (PTY/JSONL) ou API adapters (HTTPS)
             ⇅ exécution contrôlée et filtrée
        Agents et modèles externes / Git / environnement isolé
```

**Règles :** renderer sans accès Node direct ; `contextIsolation=true`, `nodeIntegration=false`, `sandbox=true` côté renderer compatible ; CSP restrictive ; aucune clé API envoyée au renderer ; toutes entrées IPC validées via schéma ; aucun `exec('commande concaténée')` ; préférer `spawn(binary, args, {shell:false})`. Sandboxing d'Electron **n'isole pas** les processus CLI ; ceux-ci passent par un runner séparé soumis à contrôles OS.

**Local-first :** aucun serveur central requis pour usage de base. Le CLI ou l'API choisi peut contacter un fournisseur externe selon ses propres règles. Le service runner peut être un processus enfant local distinct et, plus tard, un daemon ; journal SQLite garantit l'état durable, pas la survie magique d'une tâche quand l'app est fermée.

## Chapitre 10 — Gouvernance, protocole inter-agents et mémoire commune

**Modes :** `MANUAL` (l'humain attribue) ; `AI_SUPERVISED` (l'IA propose/attribue selon politique) ; `ASSISTED` (IA propose, humain valide le plan). Choix au niveau équipe et modifiable avec journalisation. Sélection du cerveau principal parmi les agents disponibles et compétents. Bascule superviseur : pause -> snapshot -> nouvelle attribution explicite.

**Scheduler :** découper mission en DAG ; exécuter seulement tâches dont dépendances satisfaites, budget disponible, permissions valides et conflits de chemin maîtrisés. États : `draft -> ready -> queued -> running -> waiting_input|waiting_review -> completed|failed|cancelled|interrupted` ; transitions transactionnelles et idempotentes.

**Communication :** enveloppe versionnée `messageId, missionId, taskId, senderAgentId, recipientAgentId, type, payloadRef, timestamp, correlationId`. Types `task_assigned`, `question`, `answer`, `artifact_published`, `review_requested`, `review_result`, `decision_proposed`, `human_approval_requested`, `error`. Le pair-à-pair ne donne jamais automatiquement de nouvelles permissions ni d'accès fichiers. Tout agent peut proposer une escalade ; seul le policy engine accorde.

**Mémoire :** couches (a) événements immuables, (b) état matérialisé, (c) faits et décisions de projet versionnés avec source/portée/confiance, (d) résumés compacts générés, (e) index de recherche optionnel ultérieur. Aucune mémoire « tout le texte de tous les agents à chaque prompt ». Chaque tâche reçoit un contexte déterministe : objectif, ADR pertinents, contrats, fichiers autorisés, derniers artefacts validés, décisions.

**Exemple :** `Architect -> ADR-012 accepté -> API contract v3 publié -> Backend adopte v3 -> QA exécute tests v3 -> Reviewer signale incompatibilité -> ticket correction -> revalidation`. Les agents voient références et versions, pas seulement un long chat fragile.
