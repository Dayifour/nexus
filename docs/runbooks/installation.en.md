# Installation and getting started (EN)

> **Linux-only** pre-release. Windows and macOS: no verified isolation backend; autonomous execution is refused there.

## Requirements

| Item | Tested version | Purpose |
|---|---|---|
| Ubuntu (or equivalent Linux) | 24.04, kernel 7.0, x86_64 | pre-release platform |
| Node.js | 24.18 | development and tests |
| git | 2.43 | projects, one isolated worktree per task |
| bubblewrap (`bwrap`) | 0.9 | agent isolation in `sandbox-auto` |
| unprivileged user namespaces | enabled | kill boundary and sandbox |
| systemd (user session) | 255 | resource limits (cgroups v2) |
| desktop keyring (GNOME Keyring / KWallet) | — | API key vault (refused if missing) |
| agent CLIs (optional) | Claude Code, Codex, Gemini CLI, Hermes, OpenCode | CLI connectors |
| `gh`, `vercel` (optional) | — | GitHub push/PR, Vercel deployments |

Nothing is installed or authenticated automatically: each CLI is installed and signed in through its official procedure.

## From source

```bash
pnpm install --frozen-lockfile                 # only allow-listed native modules (allowBuilds) run scripts
pnpm run generate       # Prisma client + embedded migrations
pnpm run check          # lint, typecheck, tests (isolation tests need bwrap and user namespaces)
pnpm start             # development app
```

Linux package: `pnpm --filter @nexus/desktop run make:linux` (outputs `.deb` and `.zip` in `apps/desktop/out/make`; `.rpm` needs `rpmbuild`).

## Getting started

1. **Diagnostics**: the home page lists detected CLIs (version, path) and the real state of isolation and of the vault.
   "Authentication not verified" means Nexus never reads CLI authentication folders.
2. **Project**: create a project on a local folder. For an agent to write, it must be a Git repository: each task works in its own
   worktree and `nexus/task-<id>` branch, never in the main repository.
3. **`.env` files**: visible by default (owner decision). Enable "Protect .env files" so agents can neither read nor print them.
   Credential files (`.npmrc`, SSH keys…) are always protected.
4. **Team**: add agents (connector, role, permission mode). Claude under a subscription runs in `manual` mode (decision D-1);
   `sandbox-auto` requires verified isolation and an API-key connection.
5. **Mission**: describe the goal, then propose a plan (JSON) or ask the AI supervisor. Review validation rules and routing, approve
   the plan, run it. Each finished task goes to **review** (diff) before being accepted.
6. **Sensitive actions**: a push, a PR or a deployment creates an **approval** (Approvals page) bound to the exact plan;
   Vercel production always needs a separate approval.
7. **Emergency stop**: the "Stop agents" button is always visible.

## API connectors (optional)

1. "Connections & secrets" page: store the key (encrypted by the OS keyring, never displayed again) with the purpose
   `connector:<id>` (e.g. `connector:openai-api`).
2. Create `connectors.json` in the application data folder:

```json
[{ "provider": "openai", "model": "<your model>", "secretRef": "openai:main" }]
```

No model is chosen for you. Providers: `openai`, `anthropic`, `google`, `openrouter`.

## Dictation (optional)

No engine is active by default. `voice.json` in the data folder: `{ "local": { "whisperPath": "...", "modelPath": "..." } }`, or, after
explicit consent to sending audio, `{ "cloud": { "optIn": true, "model": "<model>", "secretRef": "openai:main" } }` (secret purpose
`voice:transcription`). Audio is never kept; the transcript is always reviewed before sending.

## Local data

Application data folder: `nexus.db` (event log), `secrets.json` (encrypted, 0600), `worktrees/`, `artifacts/`. Project export/import
from the Projects page (archive with an integrity fingerprint, without secrets).
