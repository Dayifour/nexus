# Notes de version — Nexus AI 0.2.1 (préversion)

_English version below._

## Nouveautés de la 0.2.1

- Installeur Windows : identifiant de paquet Squirrel valide (la construction Windows échouait depuis la 0.1.0).
- La Release est publiée même si une plateforme expérimentale échoue.

## Nouveautés de la 0.2.0

- **Hermes branché comme les autres agents** : bus de l'équipe, chef d'orchestre ou relecteur en lecture seule
  (outils limités, écriture refusée), reprise native de session, état en direct par ses hooks. La configuration Hermes de
  l'utilisateur n'est jamais modifiée : chaque exécution utilise une configuration superposée temporaire.
- **Codex sur le bus de l'équipe** (serveur MCP `nexus` passé en `-c`, jeton dans l'environnement, jamais dans la ligne de
  commande). Les six CLI peuvent désormais se parler dans l'orchestre.
- Bus de l'équipe annoncé aux agents seulement s'il a réellement démarré ; erreur de démarrage journalisée.
- Interface : nettoyage de l'ancien modèle Missions/Équipes, thèmes clair/sombre conformes WCAG AA, protection des `.env`
  réglable par projet, robustesse des runs (échecs non relançables, reprise des tâches interrompues).
- Tests E2E de la palette fiabilisés sur les machines lentes (CI).

**Statut : préversion, Linux vérifié.** Les versions Windows et macOS sont construites par le workflow de publication mais
restent expérimentales. Licence Apache-2.0 appliquée (`LICENSE`, `NOTICE`, « Copyright 2026 Dayifour »).

## Principe

Les CLI des agents (Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode, Hermes) codent avec leurs propres outils. Nexus
ne les remplace pas : il les lance, les isole, les orchestre, relaie leurs messages, relit et intègre leurs résultats.

## Contenu

- **Sessions** : un agent, une consigne, dans son vrai terminal (PTY interactif) ou en conversation. Trois modes : _Avec
  validation_ (défaut, copie Git puis relecture du diff), _Autonome_ (directement dans le projet), _Autonome en sandbox_
  (opt-in, Linux). Composer : Entrée envoie, messages mis en file pendant que l'agent travaille.
- **Diffusion** d'une même consigne à 2–6 agents, chacun dans sa copie.
- **Orchestre** : un chef d'orchestre en lecture seule planifie un DAG ; tâches parallèles dans une copie commune isolée ;
  bus MCP `nexus` (`team_status`, `send_message`, `read_messages`, `ask_lead`) ; revue par le chef ; intégration confirmée ;
  arrêt par orchestre ; **reprise après redémarrage**.
- **Espace de travail IDE** : explorateur, Monaco, terminaux PTY, palette, raccourcis façon VS Code, Git, PR via `gh`.
- **Plan de déploiement** : Vercel, Render, Railway, VPS Hostinger, MongoDB Atlas, étape par étape avec confirmation.
- **Consommation**, thèmes clair/sombre/système, interface et processus principal en français et en anglais (langue du
  système au premier lancement), écran d'accueil avec les commandes d'installation des agents.

## Agents

- Vérifiés en réel (hors sandbox et dans la sandbox) : **Claude Code, Codex CLI, OpenCode, Hermes**. Bus de l'équipe vérifié
  avec Claude, Codex, OpenCode et Hermes.
- **Gemini CLI et Qwen Code** : adaptateurs prêts, jamais lancés en réel.
- Lecture seule imposée par CLI pour le chef d'orchestre : Gemini/Qwen `--approval-mode plan`, OpenCode `--agent plan` ;
  Hermes : outils en lecture seule et racine d'écriture neutralisée. Claude : nouvel identifiant de session à chaque exécution.
- API OpenAI / Anthropic / Google / OpenRouter : conversation seulement (aucun outil), non vérifiées avec de vraies clés.

## Sécurité

- Renderer sans Node, CSP stricte en production, IPC validé par Zod dans le preload et le main, pas de `shell: true`.
- Frontière de processus par plateforme : Linux PID namespace + mort du parent (`setpriv --pdeathsig`) ; macOS groupe de
  processus ; Windows arbre `taskkill` (ces deux derniers non testés sur de vraies machines).
- Sandbox Linux : bwrap, seccomp, cgroups v2, proxy réseau limité au fournisseur ; métadonnées Git en lecture seule ; Git hôte
  et push refusent une configuration de dépôt qui définit des commandes (M24). D-1 levée : la connexion du CLI est montée en
  lecture-écriture dans sa sandbox (M19). D-4 : `.env` visibles par défaut.
- Bus de l'équipe : socket Unix privée / tube nommé Windows, jeton par tâche.
- Barrières d'erreur dans l'interface, garde des modifications non enregistrées, confirmation avant de fermer le terminal
  d'un agent actif.
- Paquet allégé : archive asar de 146 Mo à 18 Mo.

## Limites connues

- Windows / macOS : pas de sandbox (mode refusé), processus et terminaux non vérifiés en réel, macOS non signé.
- `.rpm` construit par le workflow de publication, non testé.
- PR GitHub et hébergeurs de déploiement : vérifiés uniquement contre des faux (`gh` simulé, API simulées).
- Dictée : exige whisper.cpp ou un consentement cloud explicite ; jamais exécutée en réel.
- Messagerie entre agents indisponible pour les agents en sandbox.
- Chemins réservés aux tâches de l'orchestre : conflits empêchés à la planification, mais une écriture hors zone n'est pas
  encore bloquée.
- Hermes : état en direct vérifié en mode non interactif, pas encore dans son terminal interactif.

---

# Release notes — Nexus AI 0.2.1 (preview)

**New in 0.2.1.** Valid Squirrel package id for the Windows installer (the Windows build had failed since 0.1.0); the
Release is published even if an experimental platform fails.

**New in 0.2.0.** Hermes is wired like the other agents: team bus, read-only Orchestra conductor or reviewer, native
session resume, live status from its hooks, without ever modifying the user's Hermes configuration (per-run overlay).
Codex joins the team bus (token passed in the environment, never in argv), so all six CLIs can talk to each other. The bus
is advertised only when it actually started. Old Missions/Teams model removed, WCAG AA light/dark themes, per-project
`.env` protection switch, more robust runs, palette E2E tests hardened for slow CI machines.

**Status: preview, Linux verified.** Windows and macOS builds are produced by the release workflow but are experimental.
Apache-2.0 licence applied.

**Principle.** The agent CLIs do the coding with their own tools; Nexus launches, isolates, orchestrates, relays, reviews
and merges.

**What's in it.** Sessions in three modes (Supervised by default, Autonomous, Sandboxed opt-in on Linux), real PTY
terminals, composer with Enter-to-send and queued messages; broadcast to 2–6 agents; Orchestra (read-only conductor, DAG,
parallel tasks in a shared isolated copy, MCP team bus, reviews, confirmed merge, per-mission stop, resume after
restart); IDE workspace (explorer, Monaco, terminals, Git, PRs via `gh`); deployment planner (Vercel, Render, Railway,
Hostinger VPS, MongoDB Atlas, step by step with confirmation); usage view; light/dark/system themes; French/English with
first-run language from the OS; onboarding with install commands.

**Agents.** Verified for real: Claude Code, Codex CLI, OpenCode, Hermes (team bus verified with all four). Pending: Gemini CLI, Qwen Code (never run for
real). API connectors are chat-only and unverified with real keys.

**Security.** Strict production CSP, Zod-validated IPC, no shell; per-platform kill boundary (Linux verified; macOS process
group and Windows `taskkill` tree unverified); Linux sandbox with read-only Git metadata and host Git refusing
command-defining repo configs (also on push); team bus over a private Unix socket / Windows named pipe; error boundaries,
unsaved-changes guard, agent-terminal close confirmation; asar reduced from 146 MB to 18 MB.

**Known limits.** No sandbox on Windows/macOS; `.rpm` built but untested; GitHub PR and deploy providers verified only
against fakes; voice dictation never run for real; no team bus for sandboxed agents; Orchestra task paths are checked at planning time
but out-of-path writes are not blocked yet; Hermes live status not yet verified in its interactive terminal.
