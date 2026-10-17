# Boilerplate Et Depots

> Nexus AI — spécification d'origine (version documentaire 1.1, 10 octobre 2026). Document de conception, conservé pour référence : l'état réel est décrit dans `docs/ARCHITECTURE.md`, `docs/USER_GUIDE.md` et `.coordination/STATUS.md` ; en cas d'écart, le code fait foi.

**Source :** chapitres 6, 8 de `SOURCES_ORIGINALES/Nexus_AI_SPEC_MASTER_v1.md`. Ce fichier est une extraction documentaire, sans remplacement du maître.

## Chapitre 6 — Boilerplate, dépôts et stratégie de démarrage — décision précise

**Boilerplate principal recommandé :** Electron Forge officiel, template Vite + TypeScript : https://github.com/electron/forge ; guide : https://github.com/electron/forge/blob/main/docs/templates/vite-%2B-typescript.md . Commande de création à valider sur l'environnement de développement :

```bash
node --version
npm --version
npx create-electron-app@latest nexus-ai --template=vite-typescript
cd nexus-ai
npm start
```

Ce template ne fournit **pas automatiquement React** : ajouter React, ReactDOM et `@vitejs/plugin-react` selon la configuration Forge générée, puis construire les composants UI ; conserver les versions compatibles telles que figées dans le lockfile. Préférer `npm` pour la toute première exécution du template officiel, puis migrer explicitement à `pnpm` seulement quand les scripts Forge, builds et CI sont vérifiés. **Ne pas mélanger lockfiles.** Un pipeline CI teste le bootstrap sur Ubuntu.

**Alternative évaluée, non retenue comme base initiale :** https://github.com/electron-vite/electron-vite-react (React, Vite, Tailwind, Vitest/Playwright déjà assemblés). Atout : vitesse de démarrage ; risque : vérifier attentivement les réglages renderer/Node et reprendre le contrôle du packaging et des permissions. Peut être choisi à la place de Forge lors d'une ADR avant le premier commit, mais **pas combiné par copier-coller**.

**Dépôts de référence à lire et non à cloner comme fondation :** Hydra pour PTY ; Runner pour mission/feed ; Codey pour rôles/mémoire ; Emdash pour worktrees ; Pivio pour UX. **Dépôts d'intégration à étudier :** `https://github.com/cli/cli`, `https://github.com/vercel/vercel`, `https://github.com/microsoft/monaco-editor`, `https://github.com/xtermjs/xterm.js` ; utiliser leurs packages officiels ou CLI plutôt que copier le code.

**Bibliothèques proposées (vérifier versions/maintenance avant installation) :** React, TypeScript, Vite, Tailwind, Monaco, xterm.js, node-pty, zod, better-sqlite3 ou sqlite native robuste, vitest, Playwright, electron-log/pino, Mermaid, Git CLI, Electron Forge. **Ne jamais installer automatiquement tous ces modules le même jour :** ajouter par jalon selon besoin, pin et audit.

## Chapitre 8 — Arborescence cible du monorepo

```text
nexus-ai/
  README.md  LICENSE  NOTICE  CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
  package.json  package-lock.json  tsconfig.base.json  .gitignore
  docs/
    MASTER_SPEC.md  adr/  architecture/  api-contracts/  threat-model/
    runbooks/  user-stories/  agent-tasks/  testing/
  apps/
    desktop/
      electron/  src/  preload/  assets/  forge.config.ts
    runner/               # processus séparé pour orchestration et opérations risquées
  packages/
    contracts/            # schémas Zod + types + versionnement
    core/                 # modèle domaine, DAG, state machine, policy engine
    event-store/          # SQLite, migrations, snapshots, projections
    connectors/           # registry et interface commune
    connector-claude-cli/
    connector-codex-cli/
    connector-gemini-cli/
    connector-hermes-cli/
    connector-openai-api/
    connector-anthropic-api/
    connector-google-api/
    connector-openrouter-api/
    process-supervisor/   # spawn, PTY, backpressure, timeouts
    sandbox/              # backend Linux / macOS / Windows
    secrets/              # vault, brokers, masking
    git/                  # branches, worktrees, review, conflict
    github/               # gh ou API, auth, PR, push
    deploy-planner/       # plan d’hébergement, déploiement pas à pas confirmé
    voice/                # capture, STT adapter, consentements
    usage/                # mesures sources / estimations
    observability/        # traces corrélées, redaction
  tests/
    fixtures/  integration/  e2e/  security/  performance/
  scripts/               # bootstrap, lint, packaging, diagnostic
  .github/workflows/     # lint, test, package sur trois OS
```

Le générateur Forge produit initialement une arborescence mono-app : **étape T-002** déplace progressivement ses fichiers dans `apps/desktop` et configure les workspaces sans casser `npm start`. Aucun agent ne renomme des chemins partagés sans ADR et migration.
