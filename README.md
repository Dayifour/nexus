<div align="center">

# Nexus AI

**A local workshop for your AI coding agents.**

Run Claude Code, Codex, OpenCode, Hermes (and soon Gemini CLI, Qwen Code) in a real IDE, one at a time or as a team:
a conductor agent plans the work, the others build it in parallel in an isolated copy, talk to each other while they
code, get reviewed, and you merge the result.

[![CI](https://github.com/Dayifour/nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/Dayifour/nexus/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Dayifour/nexus?include_prereleases&label=release)](https://github.com/Dayifour/nexus/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Good first issues](https://img.shields.io/github/issues/Dayifour/nexus/good%20first%20issue?label=good%20first%20issues&color=7057ff)](https://github.com/Dayifour/nexus/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)

[Download](#download) · [Features](#features) · [Build from source](#build-from-source) ·
[Contributing](#contributing) · [User guide (FR)](docs/USER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md)

<img src="docs/screenshots/orchestra.jpg" alt="Nexus AI — launching an Orchestra: one goal, a conductor agent (Claude Code) and a team of Codex CLI, Hermes and OpenCode, in supervised mode" width="900">

<sub>Orchestra: one goal, one conductor, a team of agents that talk to each other.</sub>

</div>

> [!NOTE]
> **Status: preview 0.2.1 — Linux is the verified platform.** Windows and macOS builds are produced but experimental:
> no sandbox, and process/terminal behaviour has not been verified on real machines. Details:
> [`.coordination/STATUS.md`](.coordination/STATUS.md) · [release notes](docs/RELEASE_NOTES.md).

## The key principle

**The agent CLIs do the coding — Nexus never replaces them.** Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode and
Hermes keep their own models, tools, logins and subscriptions; they read and edit files with their own tools. Nexus
launches them, **isolates** them (worktree copy, optional sandbox), **orchestrates** them (plan, task graph, hand-offs),
**relays messages** between them, **reviews** their results and **merges** them into your project when you confirm.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/compare-agents.jpg" alt="New session dialog comparing Claude Code, Codex CLI, Hermes and OpenCode on the same instruction, in sandboxed mode"></td>
    <td width="50%"><img src="docs/screenshots/workspace.jpg" alt="IDE workspace with file explorer, Monaco editor on an Express auth route and an integrated terminal showing git log"></td>
  </tr>
  <tr>
    <td align="center"><b>Compare agents</b> — same instruction, each agent in its own isolated copy</td>
    <td align="center"><b>IDE workspace</b> — explorer, Monaco editor, real terminals, Git</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/agent-detection.jpg" alt="Settings page listing detected agent CLIs with installed status, version and authentication state"></td>
    <td width="50%" valign="middle">
      <b>Agent detection</b> — Nexus finds the CLIs installed on your machine, their version and whether they are
      signed in. No API key to paste: each agent keeps its own login and subscription.
      <br><br>
      <sub>Screenshots show the French UI; English is available and follows your OS language.</sub>
    </td>
  </tr>
</table>

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


## Build from source

Requirements: Node 24.18, pnpm 11 (never npm), Linux with `bwrap`, `socat` and unprivileged user namespaces for the
sandbox tests.

```bash
pnpm install --frozen-lockfile && pnpm run generate
pnpm run check                          # lint, format, typecheck, tests
pnpm start                              # run the app in development
pnpm --filter @nexus/desktop run make   # build packages into apps/desktop/out/make
```

Reproducible Linux build in Docker: `docker build -f Dockerfile.release --target export -o dist .`

## Contributing

Nexus AI is young and there is a lot of room to make a real impact. Contributions of every size are welcome — and you
do not need to write code to help:

- **Try it and report** — run it with your agent CLIs and [open an issue](https://github.com/Dayifour/nexus/issues/new/choose)
  for what breaks or feels wrong.
- **Verify a platform** — Windows and macOS builds have never been confirmed on real machines; a test report is
  extremely valuable.
- **Run an untested agent** — Gemini CLI and Qwen Code adapters exist but have never been run for real.
- **Translate** — the UI ships in French and English; strings live in `apps/desktop/src/renderer/i18n/`.
- **Pick a [good first issue](https://github.com/Dayifour/nexus/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)**
  or one labelled [help wanted](https://github.com/Dayifour/nexus/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). Please follow our [Code of Conduct](CODE_OF_CONDUCT.md); report
vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md). Accessibility commitment and known limits:
[`ACCESSIBILITY.md`](ACCESSIBILITY.md). Publishing: [`docs/RELEASING.md`](docs/RELEASING.md) · guide for coding
agents: [`CLAUDE.md`](CLAUDE.md).

If Nexus AI is useful to you, a ⭐ on GitHub helps other developers find it.

## License and notices

Nexus AI is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for project and third-party notices. Copyright 2026 Dayifour.
