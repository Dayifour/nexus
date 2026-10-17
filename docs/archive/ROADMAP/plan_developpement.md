# Plan Developpement

> Nexus AI — version documentaire 1.1, 10 octobre 2026. Statut : spécification, pas implémentation.

**Source :** chapitres 20, 22, 23 de `ID/idee.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 20 — Séquencement impératif du développement (sans ambiguïté)

**Phase 0 — Validation de faisabilité / ADR (T-000, T-001) :** vérifier Ubuntu, Node, Git, CLI présents, compatibilité licence et versions ; tester POC `spawn` + stream JSON Claude/Codex sur dépôt factice ; POC sandbox Linux de lecture/écriture/réseau et stockage secrets. **Gate :** notes de test et décision technique écrites.

**Phase 1 — Socle (T-002 à T-006) :** initialiser Forge Vite TypeScript, ajouter React + IPC sécurisé, créer monorepo packages/contracts, SQLite migrations, CI lint/unit tests, diagnostics CLI. **Gate :** `npm start` affiche inventaire et projet enregistré ; redémarrage conserve état.

**Phase 2 — Agents et mémoire (T-007 à T-011) :** connecteurs Claude/Codex, exécution isolée, streaming, event store, conversation persistante, messages inter-agents, DAG manuel. **Gate :** deux agents réels ou un simulateur contrôlé échangent un artefact et reprennent après crash.

**Phase 3 — Superviseur et sécurité (T-012 à T-016) :** policy engine, rôles, routeur IA, budgets, secrets, sandbox linux puis backends OS, worktrees, audit. **Gate :** AC-02 à AC-07 et injection adversariale passent ; aucune exécution autonome hors confinement.

**Phase 4 — Produit MVP (T-017 à T-022) :** Monaco, terminal, GitHub, Vercel preview/prod, dictée, usage monitor, architecture diagrams, tests UI. **Gate :** scénario bout-en-bout app stock -> code -> tests -> review -> GitHub -> preview.

**Phase 5 — Release cross-platform (T-023 à T-026) :** backend sandbox Windows et macOS, packaging/signature, tests machines réelles, contrôle dépendances, documentation installation FR/EN, release GitHub. **Gate :** AC-01 à AC-14 et SEC testés sur trois OS ; sinon annoncer préversion Linux limitée.

**Important :** stages peuvent être construits parallèlement si contrats stabilisés ; ne pas lancer en parallèle deux équipes qui modifient les mêmes API sans coordination. Chaque T contient sortie vérifiable et PR.

## Chapitre 22 — Backlog d'implémentation en tickets copiables

| Ticket | Entrées | Travail | Résultat attendu |
|---|---|---|---|
| T-000 | Ubuntu | probe Node, Git, versions/SDK, matrice licences | `docs/runbooks/environment.md` |
| T-001 | contrats CLI | POC streams + permissions + sandbox spike | `docs/adr/001-runtime.md` et tests |
| T-002 | template Forge | bootstrap initial et verrouillage versions | desktop minimal lancé |
| T-003 | sécurité Electron | preload API limitée, CSP, no nodeIntegration | E2E IPC refus invalides |
| T-004 | structure | packages TS + build/test/CI | `npm test` vert |
| T-005 | SQLite | migrations et event store | test de crash/replay |
| T-006 | CLI discovery | registry + probes timeout | liste agent fiable |
| T-007 | CLI adapters | Claude/Codex stream + lifecycle | traces normalisées |
| T-008 | API adapters | OpenAI/Anthropic/Google/OpenRouter | erreurs/budgets normalisés |
| T-009 | sessions | conversations/events + resume | reprise sans perte confirmée |
| T-010 | teams | équipes, rôles, méthodes manuelle | 2 équipes configurées |
| T-011 | bus | question/answer/artifact event | dialogue inter-agent journalisé |
| T-012 | scheduler | DAG, retries, deadlocks | tests dépendances |
| T-013 | AI routing | plan JSON validé + policy | décision explicable |
| T-014 | sandbox | Linux puis Windows/macOS | tests chemins/réseau |
| T-015 | secrets | vault + redaction + broker | test fuite rouge/vert |
| T-016 | worktrees | création, diff, review, merge | conflits détectés |
| T-017 | UX code | Monaco, xterm, navigation | E2E utilisateur |
| T-018 | GitHub | gh auth, status, push/PR | push test repo confirmé |
| T-019 | Vercel | preview, prod approval, logs | preview URL vérifiée |
| T-020 | voice | micro, STT, transcription review | dictée FR/EN |
| T-021 | usage | snapshots et provenance | indicateur non trompeur |
| T-022 | diagrams | Mermaid, exports | architecture projet générée |
| T-023 | QA total | unit/integration/e2e/security | matrice AC signée |
| T-024 | packaging | Linux Windows macOS | installateurs smoke-testés |
| T-025 | licence | Apache 2, NOTICE, marques | audit licences passé |
| T-026 | release | docs install, release notes, support | version MVP publique |

## Chapitre 23 — Règles de contribution et de définition de « terminé »

Chaque PR comprend : ticket ID ; objectif ; chemins modifiés ; tests exécutés et résultats ; impact sécurité ; éventuel changement de contrat ; instructions de rollback ; captures lorsque interface ; nouvelle doc ADR si décision. Statut DONE uniquement si compile, lint, tests, revue de sécurité et acceptation passent. Toute dépendance ajoutée doit mentionner licence et raison. Pas de nouvelles commandes externes sans permission broker. Pas de secret dans PR. Déployements réels hors CI de test soumis au propriétaire humain.
