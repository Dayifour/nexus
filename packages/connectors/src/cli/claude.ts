// Connecteur Claude Code (FR-004) — formats observés avec Claude Code 2.1.296 (ADR-001 §3.1).
// `--print --output-format stream-json --verbose`, prompt sur stdin, identifiant de session neuf (`--session-id`) à
// chaque lancement ; reprise native par `--resume` avec l'identifiant rapporté par le CLI. Le formatage interne du CLI peut évoluer : tout type inconnu est ignoré et compté.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentConnector,
  AgentEvent,
  AgentTaskRequest,
  ConnectorManifest,
  PermissionMode,
  ProbeResult,
} from "@nexus/contracts";
import { probeCli, type ProbeContext, type Runner } from "../probe.ts";
import { CLI_SIGNATURES } from "../signatures.ts";
import { runCliTask, type EventSequencer, type OutputNormalizer } from "./run-cli.ts";

export const CLAUDE_MANIFEST: ConnectorManifest = {
  id: "claude-cli",
  version: "1.0.0",
  kind: "cli",
  displayName: "Claude Code",
  capabilities: ["chat", "edit", "stream", "resume", "structured-output", "usage", "tools"],
  supportedPlatforms: ["linux", "darwin", "win32"],
  authModes: ["vendor-login", "api-key"],
  maturity: "beta",
};

export type ClaudeNormalizerStats = { malformed: number; unknown: number; ignored: number };

/** Normaliseur du flux stream-json (repris du spike T-001, testé sur fixtures assainies et en réel). */
export function createClaudeNormalizer(): OutputNormalizer & { stats(): ClaudeNormalizerStats } {
  const stats: ClaudeNormalizerStats = { malformed: 0, unknown: 0, ignored: 0 };
  return {
    stats: () => ({ ...stats }),
    onStdout(line: string, seq: EventSequencer) {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(line);
      } catch {
        stats.malformed++;
        return;
      }
      if (!msg || typeof msg !== "object") {
        stats.malformed++;
        return;
      }
      switch (msg.type) {
        case "system":
          // Seul l'identifiant de session natif est retenu (cwd, chemins mémoire, source de clé… restent hors journal).
          if (msg.subtype === "init") {
            seq.emit({
              kind: "started",
              ...(typeof msg.session_id === "string" && { nativeSessionId: msg.session_id }),
            });
          } else stats.ignored++;
          return;
        case "assistant": {
          const content: unknown[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const block of content as Array<Record<string, any>>) {
            if (block?.type === "text" && typeof block.text === "string") {
              seq.emit({ kind: "output", text: block.text, channel: "message" });
            } else if (block?.type === "tool_use" && typeof block.name === "string") {
              seq.emit({
                kind: "tool-request",
                tool: block.name.slice(0, 200),
                payloadRef: `claude-tool-use:${String(block.id ?? "unknown").slice(0, 100)}`,
              });
            }
          }
          return;
        }
        case "rate_limit_event": {
          const info = msg.rate_limit_info;
          if (!info || typeof info.status !== "string") {
            stats.ignored++;
            return;
          }
          const resets = Number(info.resetsAt);
          const util = Number(info.utilization);
          seq.emit({
            kind: "quota",
            status: info.status.slice(0, 40),
            ...(typeof info.rateLimitType === "string" && { window: info.rateLimitType.slice(0, 40) }),
            ...(Number.isFinite(util) && util >= 0 && util <= 1 && { utilization: util }),
            ...(Number.isFinite(resets) && resets > 0 && { resetsAt: new Date(resets * 1000).toISOString() }),
          });
          return;
        }
        case "user":
          stats.ignored++;
          return;
        case "result": {
          const u = msg.usage;
          if (u && (Number.isFinite(u.input_tokens) || Number.isFinite(u.output_tokens))) {
            seq.emit({
              kind: "usage",
              source: "reported",
              ...(Number.isFinite(u.input_tokens) && { inputTokens: u.input_tokens }),
              ...(Number.isFinite(u.output_tokens) && { outputTokens: u.output_tokens }),
              // total_cost_usd est indicatif sous abonnement : exposé avec avertissement explicite (D-3).
              ...(Number.isFinite(msg.total_cost_usd) && {
                usd: msg.total_cost_usd,
                caveat: "Coût indicatif calculé par le CLI ; ne correspond pas à une facturation sous abonnement",
              }),
            });
          }
          const text = typeof msg.result === "string" ? msg.result : "Claude CLI reported an error";
          // Piège observé : subtype "success" avec is_error=true (« Not logged in »). is_error fait foi.
          if (msg.is_error === true || (msg.subtype && msg.subtype !== "success")) {
            const code = /not logged in|\/login|authentication/i.test(text)
              ? "auth_required"
              : /rate limit|usage limit/i.test(text)
                ? "rate_limited"
                : "cli_reported_error";
            seq.fail(code, text);
          } else {
            seq.emit({
              kind: "completed",
              resultRef: `claude-result:${String(msg.session_id ?? "unknown").slice(0, 100)}`,
            });
          }
          return;
        }
        default:
          stats.unknown++;
      }
    },
    finish() {
      /* l'absence de `result` est traitée par runCliTask (stream_ended_without_result) */
    },
  };
}

/**
 * Traduction de la politique Nexus en options du CLI. Défense en profondeur seulement : la barrière reste
 * l'isolation OS (ADR-001). `autonomous` et `sandbox-auto` : aucune question de permission (choix de l'utilisateur).
 */
export function claudePermissionArgs(mode: PermissionMode): string[] {
  const common = ["--strict-mcp-config", "--disable-slash-commands"];
  switch (mode) {
    case "read-only":
      return [...common, "--restricted", "--permission-mode", "plan", "--tools", "Read", "Glob", "Grep"];
    case "manual":
    case "notify":
      // Aucun outil exécutant du code ; lecture et édition dans le worktree assigné ; le reste est refusé sans question.
      return [
        ...common,
        "--restricted",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Read",
        "Glob",
        "Grep",
        "Edit",
        "Write",
      ];
    case "sandbox-auto":
    case "autonomous":
      // Autonomie complète : aucune question de permission. En sandbox-auto, la barrière est la sandbox.
      return [...common, "--permission-mode", "bypassPermissions"];
  }
}

/** Configuration MCP temporaire, privée et supprimée à la fin de la tâche. */
export function claudeMcpConfig(
  servers: AgentTaskRequest["mcpServers"],
  mode: PermissionMode,
): { args: string[]; cleanup: () => void } | undefined {
  if (!servers?.length) return undefined;
  const mcpServers = Object.fromEntries(servers.map((s) => [s.name, { command: s.command, args: s.args, env: s.env }]));
  const dir = mkdtempSync(join(tmpdir(), "nexus-mcp-"));
  const file = join(dir, "claude-mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return {
    args: [
      "--mcp-config",
      file,
      ...(mode === "manual" || mode === "notify" || mode === "read-only"
        ? ["--allowedTools", ...servers.map((s) => `mcp__${s.name}`)]
        : []),
    ],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Sans propriétaire de cycle de vie, cette ancienne API refuse plutôt que de mettre un jeton dans argv. */
export function claudeMcpArgs(_servers: AgentTaskRequest["mcpServers"], _mode: PermissionMode): string[] {
  return [];
}

export type ClaudeConnectorOptions = {
  probeContext: ProbeContext;
  /** Chemin absolu du binaire (issu de la sonde). */
  binaryPath?: string;
  runner?: Runner;
  /** Mode d'authentification du profil (connexion du CLI ou clé API). */
  authMode: "vendor-login" | "api-key";
  /** Variables minimales transmises (HOME requis pour que le CLI retrouve sa propre session de connexion). */
  baseEnv: Record<string, string>;
  resolvePermissionMode: (policyId: string) => PermissionMode;
};

export class ClaudeCliConnector implements AgentConnector {
  readonly manifest = CLAUDE_MANIFEST;
  readonly #opts: ClaudeConnectorOptions;
  #binary: string | undefined;

  constructor(opts: ClaudeConnectorOptions) {
    this.#opts = opts;
    this.#binary = opts.binaryPath;
  }

  async probe(): Promise<ProbeResult> {
    const sig = CLI_SIGNATURES.find((s) => s.connectorId === "claude-cli")!;
    const r = await probeCli(sig, this.#opts.probeContext);
    if (r.path) this.#binary = r.path;
    return r;
  }

  start(req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    // Session CLI neuve à chaque lancement : `req.sessionId` regroupe les tâches (projet, agent) côté Nexus et la
    // réutiliser ferait échouer Claude (« Session ID already in use »). La reprise passe par `resume` (identifiant natif).
    return this.#run(req, signal, ["--session-id", randomUUID()]);
  }

  resume(nativeSessionId: string, req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    return this.#run(req, signal, ["--resume", nativeSessionId]);
  }

  #run(req: AgentTaskRequest, signal: AbortSignal, sessionArgs: string[]): AsyncIterable<AgentEvent> {
    const mode = this.#opts.resolvePermissionMode(req.permissionsPolicyId);
    if (!this.#binary)
      return refuse(req.taskId, "binary_not_found", "Claude Code n'a pas été détecté (lancer la sonde)");
    const mcp = claudeMcpConfig(req.mcpServers, mode);
    const task = runCliTask({
      taskId: req.taskId,
      file: this.#binary,
      args: [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        ...sessionArgs,
        ...claudePermissionArgs(mode),
        ...(mcp?.args ?? []),
      ],
      stdin: req.prompt,
      cwd: req.workspacePath,
      env: { ...this.#opts.baseEnv },
      timeoutMs: req.timeoutMs,
      signal,
      normalizer: createClaudeNormalizer(),
      ...(this.#opts.runner && { runner: this.#opts.runner }),
    });
    if (!mcp) return task;
    return (async function* () {
      try {
        yield* task;
      } finally {
        mcp.cleanup();
      }
    })();
  }
}

export function refuse(
  taskId: string,
  code: "policy_denied" | "binary_not_found" | "sandbox_unavailable" | "auth_required",
  message: string,
): AsyncIterable<AgentEvent> {
  return (async function* () {
    yield { kind: "failed" as const, taskId, sequence: 1, code, message };
  })();
}
