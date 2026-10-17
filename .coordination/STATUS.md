# État des tickets

Responsable unique depuis le 11/10/2026 : Claude (Hermes ne participe plus). Rien n'est commité : le propriétaire commite.
Contrôle global : `pnpm run check` (lint + typecheck + tests) ; E2E Electron (comme en CI) : `cd apps/desktop && pnpm exec electron-forge package && xvfb-run -a node --test --test-concurrency=1 e2e/security.e2e.ts e2e/ui.e2e.ts`.

| Ticket | État | Preuves | Reste / bloqué par |
|---|---|---|---|
| T-000 | fait (Hermes) | `docs/runbooks/environment.md` | — |
| T-001 | fait | `docs/adr/001-runtime.md` rév. 2, 45 tests + 2 réels | — |
| T-002 | fait (Hermes, repris) | bootstrap Forge/Electron 44/Vite 8 | — |
| T-003 | fait | E2E Playwright : pas de Node dans le renderer, pont gelé, IPC invalide refusé, CSP, navigation/fenêtres/permissions bloquées, persistance après redémarrage | — (CSP de prod stricte depuis l'audit du 16/10) |
| T-004 | fait | workspaces pnpm, `tsconfig.base`, `pnpm run check`, CI GitHub (exécutée sur les pushs vers `dayif`), ADR-002 | — |
| T-005 | fait | Prisma 7.10 + libSQL, migrateur, journal append-only (triggers), 12 tests dont crash SIGKILL | — |
| T-006 | fait | registre + sondes sûres (PATH absolu, binaire modifiable par tous refusé, --version borné, auth jamais lue) | — |
| T-007 | fait | `@nexus/process-supervisor`, connecteurs Claude réel / Codex réel / générique | — |
| T-008 | fait | `@nexus/connectors-api` OpenAI/Anthropic/Google/OpenRouter, fetch natif, 48 tests (sous-agent, revu) | formats SSE non vérifiés sans clé réelle |
| T-009 | fait | runs, journalisation des événements d'agent, recovery UC-05, reprise native/reconstruite AC-05 | — |
| T-010 | fait puis simplifié | équipes et gouvernance remplacées dans l'interface par les sessions et l'Orchestre ; D-1 levée le 11/10 | — |
| T-011 | remplacé | ancien bus `core/bus.ts` supprimé ; la messagerie entre agents passe par le bus MCP de l'Orchestre | — |
| T-012 | fait | DAG, ordonnanceur (chemins, parallélisme, réessais, deadlock), 9 tests | — |
| T-013 | fait | moteur de politiques (matrice), approbations (empreinte, expiration, usage unique), plan IA validé + routage explicable, orchestrateur | — |
| T-014 | fait (Linux) | `@nexus/sandbox` bwrap + seccomp BPF + cgroups v2 + proxy egress anti-rebinding, 11 tests réels, ADR-003 | Windows/macOS : aucun backend (sandbox-auto refusé) |
| T-015 | fait | `@nexus/secrets` coffre safeStorage (backend non sûr refusé), broker par usage, test de fuite rouge/vert | — |
| T-016 | fait | `@nexus/git` worktrees, diff, merge approuvé, conflits sans écrasement (AC-03), scanner de secrets, 21 tests (sous-agent, revu) | push : T-018 |
| T-017 | fait puis refait | interface IDE (dockview, Monaco, xterm, terminaux PTY interactifs) ; voir la refonte du 11/10 | — |
| T-018 | fait (fixtures) | `@nexus/github` push approuvé sans force possible, PR via gh, 16 tests ; branché en IPC | essai réel bloqué : `gh` à installer/authentifier |
| T-019 | remplacé | ancien broker Vercel remplacé par `@nexus/deploy-planner` (voir la refonte) | essai réel : comptes des hébergeurs requis |
| T-020 | fait (logique) | `@nexus/voice` consentement, fenêtre micro armée, relecture obligatoire ; permission Electron audio seule | aucun moteur STT installé : dictée réelle indisponible |
| T-021 | fait | `@nexus/usage` provenance reported/estimated/indisponible, budgets, LoopGuard (sous-agent, revu) | persistance à brancher |
| T-022 | abandonné | diagrammes remplacés par le plan de déploiement (décision du 11/10) | — |
| T-023 | fait | matrice AC-01..AC-14 (`docs/testing/matrice-acceptation.md`), modèle de menace M1..M18, revue des packages des sous-agents | revue humaine avant publication |
| T-024 | fait (Linux) | `.deb` + `.zip` construits, smoke test du paquet réel ; `.rpm` construit par `release.yml` | Windows/macOS : machines réelles requises ; `.rpm` non testé |
| T-025 | fait | `pnpm run licenses` ; `docs/licences/` ; licence Apache-2.0 **appliquée** (Copyright 2026 Dayifour) | — |
| T-026 | fait (docs) | guides d'installation FR/EN, notes de version, README, CONTRIBUTING, SECURITY | publication publique : décision du propriétaire |
| FR-025 | fait | export/import d'archive avec intégrité, secrets exclus, dialogues natifs | — |

## Refonte du 11/10/2026 (décisions du propriétaire : simplicité, 3 modes, interface de niveau IDE)

| Élément | État | Preuves | Reste |
|---|---|---|---|
| Trois modes (Autonome / Autonome en sandbox / Avec validation) | fait | `workspace.test.ts` : autonome dans le projet, validation en worktree, sandbox réelle (réseau direct coupé) | — |
| Espace de travail IDE (projets par glisser-déposer, fichiers, PTY, surveillance, recherche, Git, réglages) | fait | `workspace.test.ts` 22/22 avec PTY réel | — |
| Interface dockview (explorateur, Monaco, terminaux xterm, palette, sessions, contrôle de source…) | fait | E2E interface 18/18 + sécurité 8/8 (sous-agent, revu) | — |
| Backlog P0 n°1 : TUI de l'agent dans un PTY, saisie directe, reprise | fait | test PTY réel + test **dans la sandbox réelle** | — |
| P0 n°2 : état de l'agent par hooks (UserPromptSubmit/PostToolUse → travaille, Notification → attend, Stop → tour fini) | fait | vérifié avec le **vrai Claude** (`working`, `idle`) | autres CLI : pas de hooks, état « démarré / terminé » seulement |
| P0 n°3 : notifications système cliquables (ouvrent la session) | fait | `main.ts` ; n'apparaissent que si la fenêtre n'a pas le focus | — |
| P0 n°5 : PR depuis l'app (`git.createPr`, confirmée par dialogue) | fait | refus explicite sans `gh` testé | essai réel : `gh` à installer et connecter |
| P1 n°6 : quotas Claude (`rate_limit_event` → événement `quota` + instantané persistant) | fait | test du connecteur | flux non interactifs seulement (la TUI n'émet pas de JSON) |
| P1 n°7 : diffusion d'une consigne à 2–6 agents (`sessions.startMany`), copies isolées | fait | test de diffusion | — |
| Refus réseau de la sandbox remontés à l'interface (`sandbox-denied`, « Autoriser ce domaine ») | fait | test sandbox réel (CONNECT refusé 403 + événement) | — |
| P0 n°4 : Codex / Gemini en réel | bloqué | — | CLI à installer et connecter (accord du propriétaire) |
| pnpm (migration depuis npm) | fait | `pnpm run check` 245 tests, E2E 28/28 sur le paquet | — |
| Agents réels via le lanceur Nexus | fait | Claude, Codex (après `/proc` propre au namespace + `approval_policy="never"`), Hermes (`chat -Q -q`), OpenCode (`run`) : fichier créé, hors sandbox ET dans la sandbox | Gemini, Qwen : connexion du propriétaire requise |
| Plan de déploiement (`@nexus/deploy-planner`, panneau Déploiement) | fait (API simulées) | 8 tests (serveurs factices au format des API Vercel/Render/Railway/Atlas, faux ssh) + intégration + E2E | essai réel : comptes et jetons des hébergeurs requis |
| **Orchestre (chef d'orchestre autonome)** | fait | plan par le chef, DAG parallèle en copie commune, transmission, revue avec corrections, synthèse, intégration ; 4 tests + **runs réels** : Claude chef + Codex (module + tests), Claude + Codex coopérant via le bus (question de Codex à Claude, réponse, confirmation du chef) | bus indisponible en sandbox |
| Bus MCP de l'équipe (`team_status`, `send_message`, `read_messages`, `ask_lead`) | fait | test protocole MCP réel ; vérifié en réel avec Claude, Codex, OpenCode | Gemini/Qwen : connexion requise ; Hermes : non branché |
| Déploiement durci (Atlas moindre privilège + CIDR, empreinte SSH vérifiée) | fait | 10 tests deploy-planner | essai réel : comptes requis |
| Messages et journaux dans la langue choisie | fait | test FR→EN | — |
| **Parcours réels dans l'application** (`apps/desktop/e2e/real-agents.e2e.ts`, `NEXUS_REAL_AGENTS=1`) | fait | conversation Claude + relance, terminal Codex, terminal Claude, orchestre Claude→Codex jusqu'à « Terminé » avec clic sur une tâche en cours : 4/4 | — |
| Orchestre résilient | fait | réattribution des tâches d'un agent défaillant (raison affichée), refus des agents non connectés | — |
| Publication | fait (non exécutée) | `.github/workflows/release.yml` (Linux/Windows/macOS → Release GitHub), `Dockerfile.release`, `docs/RELEASING.md` | premier tag à pousser par le propriétaire |
| CI GitHub | exécutée | user namespaces levés sur le runner, bwrap/socat installés, job E2E sur le paquet ; tourne à chaque push vers `dayif` | résultats : voir l'onglet Actions |

## Audit du 16/10/2026

Corrections vérifiées sous Linux (`pnpm run check` et E2E : voir la CI) :

| Domaine | Correction | Reste |
|---|---|---|
| Sandbox / Git | métadonnées git montées en lecture seule ; Git hôte refuse une configuration de dépôt qui définit des commandes (M24) ; le push refuse une configuration locale porteuse de commandes | — |
| Frontière de processus | Linux : PID namespace + mort du parent via `setpriv --pdeathsig` ; macOS : groupe de processus ; Windows : arbre `taskkill` | macOS/Windows **écrits, non testés** sur de vraies machines |
| Bus de l'équipe | socket Unix privée, tube nommé sous Windows | Windows non testé |
| Orchestre | reprise après redémarrage ; arrêt par orchestre | — |
| Connecteurs | Claude : nouvel identifiant de session à chaque exécution ; lecture seule par CLI (Gemini/Qwen `--approval-mode plan`, OpenCode `--agent plan`) ; Hermes refusé comme chef | Gemini, Qwen jamais lancés en réel |
| Paquet | asar de 146 Mo à 18 Mo ; CSP de production stricte | — |
| Interface | barrières d'erreur ; garde des modifications non enregistrées ; confirmation de fermeture du terminal d'un agent ; accueil avec commandes d'installation ; composer Entrée pour envoyer + messages en file | — |
| Langue | processus principal localisé ; langue du premier lancement tirée de l'OS | — |
| Nettoyage | suppression de l'ancienne interface Missions/Équipes/gouvernance, file d'approbations, diagrammes, ancien déploiement Vercel, tables Prisma mortes ; docs de passation archivées dans `docs/archive/` | — |

État honnête : Linux est la seule plateforme vérifiée. PR GitHub et hébergeurs vérifiés contre des faux uniquement. Dictée
jamais exécutée en réel (whisper.cpp ou consentement cloud requis). Connecteurs API : conversation seulement, sans outil,
non vérifiés avec de vraies clés.
