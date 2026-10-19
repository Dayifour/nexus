# Security Policy

Nexus AI orchestrates local coding agents and can interact with developer tools, project files, and provider sessions. Security is a core design concern, but this is preview software and its protections have important platform-specific limits.

## Supported security posture

| Platform | Agent isolation | Current posture |
| --- | --- | --- |
| Ubuntu / Linux | Bubblewrap, seccomp, cgroups v2, and an egress proxy | Verified on a real host; preview only |
| Windows | No verified sandbox backend | `sandbox-auto` is refused |
| macOS | No verified sandbox backend | `sandbox-auto` is refused |

Nexus AI does not claim that sandboxing is available on a platform until containment, write, network, and escape tests have passed there. When verified isolation is unavailable, dangerous autonomous sandbox actions are refused.

Read the [threat model](docs/threat-model/README.md) for the trust boundaries, automated evidence, residual risks, and incident-response procedure. In particular, review the documented trade-offs around provider sessions and project `.env*` files before using preview builds with sensitive projects.

## Reporting a vulnerability

**Do not report security vulnerabilities in a public GitHub issue, discussion, pull request, or commit.**

Report vulnerabilities privately through GitHub: **[Report a vulnerability](https://github.com/Dayifour/nexus/security/advisories/new)** (Security tab → *Report a vulnerability*). Only the maintainers can see the report. If that form is unavailable, contact the repository owner through the [Dayifour GitHub profile](https://github.com/Dayifour) and request a private channel, without including exploit details, credentials, customer data, or proof-of-concept code in any public message.

Please include:

- a concise description of the vulnerability and affected component;
- reproducible steps or a minimal, non-destructive proof of concept;
- expected and actual security impact;
- affected version, commit, platform, and configuration; and
- any suggested mitigation, if known.

Please give maintainers a reasonable opportunity to investigate and release a fix before public disclosure. We will acknowledge reports, assess severity and scope, communicate the remediation plan when possible, and credit reporters only with their permission.

## Handling a suspected incident

1. Stop active agents with **Stop agents**.
2. Revoke the affected secret in **Connections and secrets**, then revoke it at the provider.
3. Preserve the relevant redacted event log and run information for analysis.
4. Switch the affected team to `manual` or `read-only` mode and disable `sandbox-auto`.
5. Before a fix is accepted, add a regression test that reproduces the incident safely.

## Scope

This policy covers the source repository, official release artefacts when published, and the Nexus AI desktop application. Third-party CLIs, model providers, and dependencies should also be reported to their respective maintainers when the issue originates in their software.
