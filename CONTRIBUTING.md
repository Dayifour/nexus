# Contributing to Nexus AI

Thank you for investing time in Nexus AI. We welcome bug reports, documentation improvements, tests, design feedback, and code contributions that make AI-assisted development safer and more collaborative.

Nexus AI is currently a source-first preview. Please read the project status in the [README](README.md) before starting work and keep contributions focused, reviewable, and evidence-based.

## Before you start

1. Search existing issues and pull requests to avoid duplicate work.
2. For a bug, open an issue with reproducible steps, expected and actual behaviour, environment details, and any relevant non-sensitive logs.
3. For a significant feature, security-sensitive change, public-contract change, or architectural decision, open an issue first so maintainers and contributors can agree on the approach.
4. Do not include secrets, access tokens, private project data, or real credentials in issues, pull requests, fixtures, commits, or logs. See [SECURITY.md](SECURITY.md) for vulnerability reporting.


## Development environment

- Node.js `24.18.x` (the supported range is defined in `package.json`)
- pnpm `11.10.x` (the exact version is declared through `packageManager`)
- Linux is the primary development and verification platform. Sandbox tests additionally require Bubblewrap (`bwrap`) and unprivileged user namespaces.

Clone your fork, add the upstream remote, and create a focused branch:

```bash
git clone https://github.com/<your-account>/nexus.git
cd nexus
git remote add upstream https://github.com/Dayifour/nexus.git
git checkout -b docs/short-description
```

Install dependencies reproducibly and generate the checked-in runtime assets:

```bash
pnpm install --frozen-lockfile
pnpm run generate
```

## Local commands

| Command | Purpose |
| --- | --- |
| `pnpm start` | Start the Electron application in development mode. |
| `pnpm run generate` | Generate the Prisma client and bundled migrations required by the workspace. |
| `pnpm test` | Run the repository test suite. |
| `pnpm run lint` | Run linting and formatting checks. |
| `pnpm run typecheck` | Run TypeScript type checks. |
| `pnpm run check` | Run linting, type checks, and tests; required before opening a pull request. |
| `pnpm --filter @nexus/desktop run e2e` | Package and run Electron end-to-end tests (Linux with `xvfb-run`). |
| `pnpm run licenses` | Audit embedded dependency licences. |
| `pnpm run test:spikes` | Run the historical T-001 security-spike evidence. |

Opt-in tests that invoke a real provider can consume a paid subscription. Run them only with an account you control:

```bash
NEXUS_REAL_CLAUDE=1 node --test packages/connectors/test/*.test.ts
```

## Contribution workflow

1. Branch from the current `main` branch with a descriptive prefix such as `fix/`, `feat/`, `docs/`, or `test/`.
2. Make one coherent change per pull request. Do not combine unrelated cleanup with a feature or fix.
3. Add or update tests when behaviour changes. A fixture-based result must be identified as such in the pull request.
4. Run the narrowest relevant checks during development, then run `pnpm run check` before requesting review.
5. Update documentation, contracts, tests, and threat-model evidence whenever they are affected.
6. Open a pull request against `main` using a clear title and description.

## Pull request requirements

Every pull request should state:

- the problem and intended outcome;
- the issue it addresses, if one exists;
- the modified packages or paths;
- tests and validation commands run, with their results;
- security impact, including new privileges, data flows, external processes, or network access;
- public-contract or compatibility impact; and
- a rollback approach when the change affects persistent data, releases, or integrations.

Maintainers may request an [ADR](docs/adr/) for incompatible contracts, architectural changes, or security-sensitive design choices. A question or ADR is preferable to an unverified assumption.

## Engineering and security rules

- Use erasable TypeScript syntax: do not introduce `enum`, `namespace`, or parameter properties. Keep relative TypeScript imports explicit with `.ts` extensions where the project convention requires them.
- Shared schemas belong in `packages/contracts`. A breaking change requires an ADR and coordinated consumer updates.
- Run external processes exclusively through `@nexus/process-supervisor`: absolute executable path, argument array, no shell, and an explicitly constructed environment. Never concatenate a command string for execution.
- Pin every added dependency, document its justification, and verify its licence. New external commands require a brokered design rather than direct execution.
- Keep sensitive values out of the repository and output. Use obviously fake fixture values.
- Do not push, open a pull request, deploy, publish a release, or access a real environment on behalf of a maintainer without explicit approval.

## Licensing contributions

By submitting a contribution, you agree that it is licensed under the repository's [Apache-2.0 License](LICENSE). The project does not currently operate a separate CLA or DCO; maintainers will publish one before requiring it from external contributors.

## Getting help

Use a GitHub issue for reproducible bugs, documentation gaps, and proposals. For vulnerabilities, do not open a public issue; follow [SECURITY.md](SECURITY.md).
