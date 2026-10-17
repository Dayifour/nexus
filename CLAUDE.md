# Guide for coding agents working on Nexus AI

Nexus AI is an Electron desktop app that orchestrates agent CLIs (Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode,
Hermes). The CLIs do the coding; Nexus isolates, orchestrates, relays, reviews and merges. Read `docs/ARCHITECTURE.md`
before changing structure; `docs/threat-model/README.md` before touching anything security-relevant.

## Rules

- **Do not commit, push or open PRs unless the owner explicitly asks.** Never add `Co-Authored-By` lines.
- **pnpm only — never npm** (or `npx` for repo tasks). Node 24.18, pnpm 11.

## Commands

```bash
pnpm install --frozen-lockfile && pnpm run generate   # deps + Prisma client + embedded migrations
pnpm run check                                        # lint + format check + typecheck + all tests (must pass)
pnpm run lint:fix                                     # oxlint --fix + oxfmt --write
pnpm start                                            # app in development
# E2E on the packaged app (as in .github/workflows/ci.yml):
cd apps/desktop && pnpm exec electron-forge package && \
  xvfb-run -a node --test --test-concurrency=1 e2e/security.e2e.ts e2e/ui.e2e.ts
```

Sandbox and PID-namespace tests need `bwrap`, `socat` and unprivileged user namespaces
(`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` on Ubuntu 24.04+). They fail instead of skipping.

## Conventions

- Code comments and user/log messages are written **in French**.
- Every UI string goes through i18n: add the key to **both** `apps/desktop/src/renderer/i18n/fr.ts` and `en.ts`. Main-process
  messages: `apps/desktop/src/main/i18n.ts`.
- **Zod at the IPC boundary**: every channel is declared in `packages/contracts/src/ipc.ts`; the renderer is untrusted.
- **No `shell: true`, no concatenated command strings.** Spawn through `@nexus/process-supervisor` (absolute binary,
  argument array, built environment). Git through `@nexus/git`, GitHub through `@nexus/github`.
- Sensitive actions (merge, push, PR, deploy) need a native confirmation dialog in main.
- Erasable TypeScript only (no `enum`, `namespace`, parameter properties); relative imports end in `.ts`.
- Lint/format: oxlint + oxfmt (`pnpm run lint`). Pinned dependency versions; record the licence of any new dependency.
- No secrets in the repo, tests or logs; fixtures use obviously fake values. Say when a result comes from fixtures, not real CLIs.

## Where things live

| What | Where |
|---|---|
| Electron main, preload, security, menu | `apps/desktop/src/main.ts`, `src/preload.ts`, `src/main/` |
| React UI (panels, sidebar, stores, commands/shortcuts) | `apps/desktop/src/renderer/` (`lib/commands.ts` for keybindings) |
| IPC handlers, sessions, terminals, orchestra, team bus, sandbox runs | `packages/app-services/src/` |
| Shared schemas | `packages/contracts/src/` |
| CLI adapters and detection | `packages/connectors/src/` |
| Sandbox (bwrap, seccomp, egress proxy) | `packages/sandbox/src/` |
| Event store, Prisma schema | `packages/event-store/` |
| E2E tests | `apps/desktop/e2e/` |
| Status and decisions | `.coordination/STATUS.md`, `.coordination/DECISIONS.md`, `docs/adr/` |
