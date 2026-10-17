# Nexus AI

> **A local workshop for your AI coding agents.** Run Claude Code, Codex, OpenCode, Hermes (and soon Gemini CLI, Qwen
> Code) in a real IDE, one at a time or as a team: a conductor agent plans the work, the others build it in parallel in
> an isolated copy, talk to each other while they code, get reviewed, and you merge the result.

**Status: preview 0.2.0 — Linux is the verified platform.** Windows and macOS builds are produced but experimental:
no sandbox, and process/terminal behaviour has not been verified on real machines. Details:
[`.coordination/STATUS.md`](.coordination/STATUS.md) · [release notes](docs/RELEASE_NOTES.md) ·
[user guide (FR)](docs/USER_GUIDE.md) · [architecture](docs/ARCHITECTURE.md).

## The key principle

**The agent CLIs do the coding — Nexus never replaces them.** Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode and
Hermes keep their own models, tools, logins and subscriptions; they read and edit files with their own tools. Nexus
launches them, **isolates** them (worktree copy, optional sandbox), **orchestrates** them (plan, task graph, hand-offs),
**relays messages** between them, **reviews** their results and **merges** them into your project when you confirm.

## Download

Builds are attached to the [**Releases**](https://github.com/Dayifour/nexus/releases) page:

| System | File | Install | Status |
|---|---|---|---|
| Ubuntu / Debian | `nexus-ai_<version>_amd64.deb` | `sudo apt install ./nexus-ai_<version>_amd64.deb` | verified |
| Any Linux | `Nexus AI-linux-x64-<version>.zip` | unzip, then run `nexus-ai` | verified |
| Fedora / openSUSE | `nexus-ai-<version>.x86_64.rpm` | `sudo dnf install ./nexus-ai-<version>.x86_64.rpm` | built by the release workflow, not tested |
| Windows | `Nexus AI-<version> Setup.exe` (or the `.zip`) | run the installer | **experimental, unverified** — no sandbox |
| macOS | `Nexus AI-darwin-arm64-<version>.zip` | unzip, then right-click → Open (unsigned) | **experimental, unverified** — no sandbox |

`SHA256SUMS.txt` lists the checksum of every file. Install and sign in to at least one agent CLI first; Nexus detects it
automatically (the onboarding screen shows the install command of each one).

## Agents

| Agent CLI | Status |
|---|---|
| Claude Code (`claude`) | verified with real runs (sessions, terminal, Orchestra conductor, team bus) |
| Codex CLI (`codex`) | verified with real runs (sessions, terminal, Orchestra conductor and member, team bus) |
| OpenCode (`opencode`) | verified with real runs (sessions, team bus) |
| Hermes (`hermes`) | verified with real runs (sessions, native resume, read-only Orchestra conductor, team bus); terminal status from its hooks |
| Gemini CLI (`gemini`) | adapter ready, **never run for real yet** |
| Qwen Code (`qwen`) | adapter ready, **never run for real yet** |
| API models (OpenAI, Anthropic, Google, OpenRouter) | chat only (no tool use), tested on fixtures, unverified with real keys |

## Features

- **Sessions** — one agent on one task, in its real terminal (interactive TUI) or as a conversation. Three modes:
  - **Supervised** (default): the agent works in an isolated Git worktree; you review the diff and accept or ask for changes.
  - **Autonomous**: the agent works directly in your project folder.
  - **Sandboxed** (opt-in, Linux): isolated copy + bubblewrap, seccomp, no direct network (proxy limited to the agent's
    provider). The CLI's own login folder (e.g. `~/.claude`) is mounted read-write so it can work; `.env` files are
    visible to the agent (per-project protection exists in the engine but has no switch in the UI yet).
- **Broadcast** — send the same instruction to several agents at once, each in its own copy, and compare.
- **Orchestra** — a conductor agent (read-only) plans the goal as a dependency graph; tasks run in parallel in a shared
  isolated copy; agents talk through the `nexus` MCP team bus (`team_status`, `send_message`, `read_messages`,
  `ask_lead`); the conductor reviews each result; you merge in one confirmed click. Survives an app restart (resume),
  can be stopped per mission, reassigns tasks of a failing agent.
- **IDE workspace** — file explorer, Monaco editor, PTY terminals, command palette, VS Code-like shortcuts, Git
  (source control, diff), pull requests via `gh`.
- **Deployment planner** — proposes hosting setups (Vercel, Render, Railway, Hostinger VPS, MongoDB Atlas) and runs them
  step by step, each step confirmed.
- **Usage view** — quotas and usage per agent, never invented (shown as unavailable when unknown).
- Light / dark / system themes; French and English (first-run language follows the OS).

What is verified only against fakes: GitHub PR creation, deployment providers. Voice dictation needs whisper.cpp or
explicit cloud consent and has never been run for real.

## Security in short

Untrusted renderer (no Node, strict CSP in production), Zod-validated IPC on both sides, no `shell: true`, OS keychain for
secrets, append-only local SQLite event log. Each agent runs inside a process boundary (Linux: PID namespace + parent-death
kill; macOS: process group; Windows: `taskkill` tree — the last two unverified). Git metadata is read-only inside the
sandbox and host Git refuses repository configs that define commands. See the [threat model](docs/threat-model/README.md).


The desktop workspace also includes a project explorer, Monaco editor, terminals, Git workflows, pull-request support, deployment planning, local event storage, secret handling through the OS keychain, and French/English UI and logs.

Requirements: Node 24.18, pnpm 11 (never npm), Linux with `bwrap`, `socat` and unprivileged user namespaces for the
sandbox tests.

```bash
pnpm install --frozen-lockfile && pnpm run generate
pnpm run check                          # lint, format, typecheck, tests
pnpm start                              # run the app in development
pnpm --filter @nexus/desktop run make   # build packages into apps/desktop/out/make
```

Reproducible Linux build in Docker: `docker build -f Dockerfile.release --target export -o dist .`

Publishing: [`docs/RELEASING.md`](docs/RELEASING.md) · contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md) ·
guide for coding agents: [`CLAUDE.md`](CLAUDE.md) · security: [`SECURITY.md`](SECURITY.md).

## License and notices

Nexus AI is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for project and third-party notices. Copyright 2026 Dayifour.
