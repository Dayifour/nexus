# Nexus AI — Architecture (for contributors)

This page describes the code as it is. The original design specification (`docs/SOURCES_ORIGINALES/`, `docs/ARCHITECTURE/`)
is kept for reference only; when they disagree, the code wins. Security rationale: [`threat-model/README.md`](threat-model/README.md).
Decisions: [`adr/`](adr/) and `.coordination/DECISIONS.md`.

**Principle.** Nexus never does the coding itself. The agent CLIs (Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode,
Hermes) edit files with their own tools. Nexus launches them, isolates them, orchestrates them, relays messages between
them, reviews and merges their results.

## 1. Repository map

```text
apps/desktop            Electron app: main process, preload, React renderer, E2E tests
packages/contracts      Zod schemas shared by everything (IPC channels, events, orchestra, deploy plans, policy)
packages/app-services   Pure-Node wiring: AppServices + IPC handlers (sessions, workspace, terminals, orchestra, team bus,
                        sandbox runs, deploy, voice, settings). Testable without Electron.
packages/core           Domain model: projects, missions/tasks with DAG scheduling, runs and crash recovery, policy
                        evaluation, project archive export/import, redaction
packages/event-store    Append-only event journal + projections (Prisma 7 + libSQL/SQLite), embedded migrations
packages/connectors     CLI connector registry, safe CLI probes, adapters (Claude stream-json, Codex, generic CLI) → AgentEvent
packages/connectors-api HTTPS adapters (OpenAI, Anthropic, Google AI Studio, OpenRouter), SSE → AgentEvent; chat only
packages/process-supervisor  Controlled process execution: absolute binary, shell:false, kill boundary, timeouts, redaction
packages/sandbox        Linux isolation: bubblewrap profile, seccomp BPF, cgroups v2, allow-list egress proxy
packages/git            Git broker: task worktrees, bounded diff, review, approved merge, secret scanner, push plan
packages/github         Push without force, PR creation through the official `gh` CLI
packages/deploy-planner Project analysis, hosting proposals (Vercel, Render, Railway, Hostinger VPS, MongoDB Atlas), guided runner
packages/secrets        Secret vault backed by the OS keychain (Electron safeStorage), per-use broker, redaction
packages/usage          Usage ledger with provenance (reported / estimated / unavailable), quotas, budgets, loop guard
packages/voice          Consent-gated dictation session; whisper.cpp locally or cloud on opt-in
```

Packages export TypeScript sources directly (Node type stripping; erasable syntax only, `.ts` relative imports).
`pnpm run generate` builds the Prisma client and embeds migrations. Legacy packages being removed (e.g. old Vercel broker,
diagrams) must not gain new dependents.

## 2. Process model

| Process | Trust | Role |
|---|---|---|
| Renderer (React 19, Zustand, dockview, Monaco, xterm) | **untrusted** | UI only; no Node, `contextIsolation`, sandboxed, strict CSP in production |
| Preload (`apps/desktop/src/preload.ts`) | bridge | exposes a frozen `window.nexus` with `invoke` / `on`; validates requests with Zod |
| Main (`apps/desktop/src/main.ts`) | trusted | builds `AppServices`, dispatches IPC, window hardening (`main/security.ts`), menu, localized messages (`main/i18n.ts`), native confirmation dialogs, notifications |
| Agent CLIs | untrusted | spawned by `process-supervisor`, optionally inside the sandbox; one per session/task |
| PTY terminals | user | `node-pty` via `TerminalManager`; output batched (16 ms / 256 KB) |
| MCP team-bus server | per agent | small Node script (`ELECTRON_RUN_AS_NODE`) started by the agent CLI, talks to main over a private socket |

**Kill boundary** (`packages/process-supervisor/src/run.ts`): every agent runs inside a boundary so that Stop kills the whole
tree. Linux: dedicated PID namespace (`unshare --pid --fork --kill-child`), launched through `setpriv --pdeathsig KILL` so
the agents die if Nexus crashes; without user namespaces the run is **refused**, never degraded. macOS: process group.
Windows: `taskkill /T /F` on the tree. macOS and Windows paths are written but unverified on real machines.

## 3. IPC boundary

- Channels and their request/response schemas live in `packages/contracts/src/ipc.ts` (`ipcChannels`). One invoke channel and
  one push-event channel (`IPC_INVOKE_CHANNEL`, `IPC_EVENT_CHANNEL`).
- Validation happens **twice**: in preload (before sending) and in `main/ipc-dispatch.ts` (envelope, channel, request and
  response). Errors returned to the renderer carry a code and a controlled message, never a stack.
- Handlers are in `packages/app-services/src/handlers.ts`, `workspace-handlers.ts`, `deploy-handlers.ts`.
- Sensitive actions (merge, push, PR, deploy steps, closing an active agent terminal) are confirmed by a **native dialog
  in main**, not by the renderer.
- Adding a channel: schema in `contracts`, handler in `app-services`, typed client in `renderer/api.ts`, strings in both
  `i18n/fr.ts` and `i18n/en.ts`.

## 4. Event store and state

- `packages/event-store`: an append-only `Event` table (protected by SQL triggers) plus projection tables, written in one
  transaction; optimistic concurrency per aggregate (`aggregateId` + `aggregateVersion`); WAL + `synchronous=FULL`.
- The event is recorded before any UI signal. On startup, runs left "running" are repaired to `interrupted`; sessions can
  be resumed natively (`--resume`) or from reconstructed context.
- Settings (`app-services/src/settings.ts`) are a JSON file in the user data directory; default session mode `supervised`.
- Orchestra state is kept per mission in `<userData>/orchestra/<missionId>.json` plus an append-only `<id>.feed.jsonl`, which
  is what makes **resume after restart** possible.
- Secrets never enter the event store: the vault stores them encrypted via the OS keychain and the broker hands them out per use.

## 5. Sessions and modes

`workspace-handlers.ts` maps UI modes to permission modes:

| UI mode | Permission | Workspace |
|---|---|---|
| Supervised (default) | `manual` | Git worktree `nexus/task-<id>` under the user data dir; diff reviewed, then merged |
| Autonomous | `autonomous` | the project folder itself |
| Sandboxed (opt-in) | `sandbox-auto` | Git worktree, run through `sandbox-run.ts` |

Broadcast (`sessions.startMany`) starts the same prompt on 2–6 agents, each in its own worktree. CLI adapters normalize
output to `AgentEvent`; Claude gets a fresh session id per run; Claude hook events drive the working/idle status;
Hermes gets the same through shell hooks (`pre_llm_call`/`post_tool_call` → working, `pre_approval_request` → needs input,
`on_session_end` → idle) declared in a per-session managed scope (`HERMES_MANAGED_DIR`), auto-accepted only when the user's
config declares no hooks of its own; other CLIs fall back to terminal activity.

## 6. Orchestra and team bus

`packages/app-services/src/orchestra.ts`:

1. **Plan** — the lead (conductor) runs **read-only**: Claude/Codex natively, Gemini/Qwen with `--approval-mode plan`,
   OpenCode with `--agent plan`, Hermes with read-only toolsets (`-t file,web,vision,todo,session_search`: no terminal,
   code execution, delegation, browser, memory or skills) and `HERMES_WRITE_SAFE_ROOT=/dev/null`, which makes Hermes'
   file tools refuse every write/patch/delete. A CLI without a read-only mode is refused as lead (`supportsReadOnly`).
2. **Graph** — the plan becomes tasks with dependencies (DAG in `core`); optional plan approval (`orchestra.approvePlan`).
3. **Run** — independent tasks run in parallel in **one shared isolated worktree** per mission; each task receives the reports
   and changes of its dependencies.
4. **Review** — the lead reviews each result (diff + acceptance criteria): accept or return with corrections. A failing agent's
   tasks are reassigned with the reason shown.
5. **Summarize and merge** — `orchestra.merge` merges the mission branch into the project after confirmation.
6. **Stop / resume** — `orchestra.stop` stops one mission; `orchestra.resume` re-queues its unfinished tasks after a restart.

**Team bus** (`team-bus.ts`): an MCP server named `nexus` is injected into each supported agent with the tools
`team_status`, `send_message`, `read_messages`, `ask_lead`. Transport: Unix socket in a private `0700` directory, or a
Windows named pipe `\\.\pipe\nexus-<random>`; each task has its own token, so an agent cannot impersonate another. The bus is
not available to sandboxed agents (the socket is not mounted); they only get hand-offs through their prompt. The token never
appears in argv: Claude, Gemini, Qwen and OpenCode read a `0600` temporary settings file; Codex gets
`-c mcp_servers.nexus.{command,args,env_vars,...}` (no secret) while the socket and token travel in its process environment
(`env_vars` forwards them to the MCP server; the user's `CODEX_HOME` and login are untouched); Hermes gets a per-run
`HERMES_HOME` (`<userData>/agent-runtime/hermes-*/profiles/nexus`, `0700`) made of symlinks to every entry of the user's
Hermes home except `config.yaml`, which is a `0600` copy with the `nexus` server added (Hermes only starts MCP discovery
when the raw config declares servers). Sessions, login, memory and history stay in the real home; new top-level entries
created during the run are moved back, then the directory is deleted.

## 7. Sandbox (Linux)

`packages/sandbox` + `app-services/src/sandbox-run.ts`:

- **Files**: nothing is visible unless mounted. The workspace is bind-mounted read-write; system directories read-only; the
  CLI binary read-only; HOME is a fresh `/home/agent`. Credential names (`.ssh`, `.npmrc`, `.git-credentials`, private keys…)
  are masked. **Exception**: the CLI's own login folder (e.g. `~/.claude`, `~/.codex`) is mounted read-write so it works
  (owner decision, D-1 lifted). `.env` files are visible by default (D-4).
- **Git**: `.git` metadata (and a worktree's gitdir/commondir) is mounted **read-only**. Git runs on the host through the Git
  broker, which refuses repository configs that define commands (filters, diff/merge drivers, `core.sshCommand`, `include`…);
  push refuses local command-bearing config as well (threat model M24).
- **Syscalls**: seccomp BPF denies namespace creation, `mount`, `bpf`, `ptrace`, `keyctl`, etc.
- **Network**: no direct network; a host egress proxy allows only the provider's domains (`PROVIDER_PROFILES`) plus
  user-added ones, refuses private IPs and DNS rebinding; `socat` bridges it into the sandbox. Refusals surface in the UI as
  `sandbox-denied` with an "Allow this domain" action.
- **Resources**: cgroups v2 limits when `systemd --user` is available.
- Windows/macOS: no backend; sandboxed mode is refused server-side (`sandboxUsable`).

## 8. Testing

- Unit/integration: `node --test` over `packages/*/test/**/*.test.ts` and `apps/desktop/tests` (`pnpm test`). Sandbox and
  PID-namespace suites fail rather than skip when isolation is missing (unless `NEXUS_ALLOW_NO_USERNS=1`).
- E2E on the packaged app (Playwright + Electron, under `xvfb-run`): `e2e/security.e2e.ts`, `e2e/ui.e2e.ts`; opt-in real
  agents: `NEXUS_REAL_AGENTS=1` with `e2e/real-agents.e2e.ts`. CI: `.github/workflows/ci.yml`.
