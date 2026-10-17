// Connecteur Codex CLI (FR-004) — maturité `fixture-only`.
// Codex n'est PAS installé sur l'hôte de développement : aucune compatibilité réelle n'est revendiquée (ADR-001).
// Le mapping suit la forme d'événements JSONL documentée publiquement pour `codex exec --json` (événements
// `thread.started`, `item.completed`, `turn.completed`, `turn.failed`, `error`), à VÉRIFIER contre un binaire réel
// avant de passer en `beta`. Tout type non reconnu est ignoré et compté, jamais deviné.
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
import { refuse } from "./claude.ts";
import { runCliTask, type EventSequencer, type OutputNormalizer } from "./run-cli.ts";

export const CODEX_MANIFEST: ConnectorManifest = {
  id: "codex-cli",
  version: "0.1.0",
  kind: "cli",
  displayName: "Codex CLI",
  capabilities: ["chat", "edit", "stream", "resume"],
  supportedPlatforms: ["linux", "darwin", "win32"],
  authModes: ["vendor-login", "api-key"],
  maturity: "beta",
};

export function createCodexNormalizer(): OutputNormalizer & { stats(): { malformed: number; unknown: number } } {
  const stats = { malformed: 0, unknown: 0 };
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
      switch (msg?.type) {
        case "thread.started":
          seq.emit({ kind: "started", ...(typeof msg.thread_id === "string" && { nativeSessionId: msg.thread_id }) });
          return;
        case "item.completed": {
          const item = msg.item ?? {};
          if (item.type === "agent_message" && typeof item.text === "string")
            seq.emit({ kind: "output", text: item.text, channel: "message" });
          else if (typeof item.type === "string" && item.type !== "reasoning") {
            seq.emit({
              kind: "tool-request",
              tool: item.type.slice(0, 200),
              payloadRef: `codex-item:${String(item.id ?? "unknown").slice(0, 100)}`,
            });
          }
          return;
        }
        case "turn.completed": {
          const u = msg.usage ?? {};
          if (Number.isFinite(u.input_tokens) || Number.isFinite(u.output_tokens)) {
            seq.emit({
              kind: "usage",
              source: "reported",
              ...(Number.isFinite(u.input_tokens) && { inputTokens: u.input_tokens }),
              ...(Number.isFinite(u.output_tokens) && { outputTokens: u.output_tokens }),
            });
          }
          seq.emit({ kind: "completed", resultRef: "codex-turn" });
          return;
        }
        case "turn.failed":
        case "error":
          seq.fail("cli_reported_error", String(msg.error?.message ?? msg.message ?? "Codex reported an error"));
          return;
        default:
          stats.unknown++;
      }
    },
    finish() {},
  };
}

/**
 * Serveurs MCP de Nexus pour Codex, sans secret dans argv ni CODEX_HOME de remplacement (la connexion et la
 * configuration de l'utilisateur restent chargées) : `-c mcp_servers.<nom>.*` ne porte que la commande et le script ;
 * les variables (socket, jeton du bus) sont dans l'environnement du processus Codex, que l'option `env_vars` de Codex
 * transmet au serveur MCP (vérifié avec codex-cli 0.162). argv est lisible par tous les utilisateurs de la machine,
 * l'environnement seulement par le propriétaire du processus.
 */
export function codexMcpConfig(servers: AgentTaskRequest["mcpServers"]): {
  args: string[];
  env: Record<string, string>;
} {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const s of servers ?? []) {
    const key = `mcp_servers.${s.name}`;
    // Chaînes et tableaux TOML : la syntaxe JSON des chaînes échappées est un sous-ensemble valide.
    args.push("-c", `${key}.command=${JSON.stringify(s.command)}`);
    args.push("-c", `${key}.args=${JSON.stringify(s.args)}`);
    args.push("-c", `${key}.env_vars=${JSON.stringify(Object.keys(s.env))}`);
    // ask_lead peut attendre la réponse du chef.
    args.push("-c", `${key}.tool_timeout_sec=300`);
    // Outils de l'équipe approuvés d'office : en `exec`, personne ne peut répondre (sans cela, codex-cli 0.162
    // refuse l'appel : « MCP tool call requires approval, but approval policy is never »).
    args.push("-c", `${key}.default_tools_approval_mode="approve"`);
    Object.assign(env, s.env);
  }
  return { args, env };
}

/** Arguments MCP de Codex (sans secret ; les variables sont données par `codexMcpConfig().env`). */
export function codexMcpArgs(servers: AgentTaskRequest["mcpServers"]): string[] {
  return codexMcpConfig(servers).args;
}

/** Options de bac à sable de Codex : complément de défense, jamais substitut à l'isolation OS. */
export function codexSandboxArgs(mode: PermissionMode): string[] {
  // En exécution non interactive, personne ne peut répondre à une demande d'autorisation : sans `approval_policy="never"`,
  // Codex reste bloqué (constaté avec codex-cli 0.162 en workspace-write). Son bac à sable reste actif.
  const never = ["-c", 'approval_policy="never"'];
  if (mode === "read-only") return ["--sandbox", "read-only", ...never];
  // Vérifié avec codex-cli 0.162 : accès complet en mode Autonome.
  if (mode === "autonomous") return ["--sandbox", "danger-full-access"];
  // Dans la sandbox de Nexus, le bac à sable propre de Codex ne peut pas s'imbriquer (seccomp refuse les namespaces) :
  // l'option prévue pour un environnement déjà isolé de l'extérieur est utilisée.
  if (mode === "sandbox-auto") return ["--dangerously-bypass-approvals-and-sandbox"];
  return ["--sandbox", "workspace-write", ...never];
}

export class CodexCliConnector implements AgentConnector {
  readonly manifest = CODEX_MANIFEST;
  readonly #probe: ProbeContext;
  readonly #runner: Runner | undefined;
  readonly #baseEnv: Record<string, string>;
  readonly #resolveMode: (policyId: string) => PermissionMode;
  #binary: string | undefined;

  constructor(opts: {
    probeContext: ProbeContext;
    runner?: Runner;
    baseEnv: Record<string, string>;
    resolvePermissionMode: (p: string) => PermissionMode;
    binaryPath?: string;
  }) {
    this.#probe = opts.probeContext;
    this.#runner = opts.runner;
    this.#baseEnv = opts.baseEnv;
    this.#resolveMode = opts.resolvePermissionMode;
    this.#binary = opts.binaryPath;
  }

  async probe(): Promise<ProbeResult> {
    const r = await probeCli(
      CLI_SIGNATURES.find((s) => s.connectorId === "codex-cli")!,
      this.#probe,
    );
    if (r.path) this.#binary = r.path;
    return r;
  }

  start(req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    return this.#run(req, signal, [
      "exec",
      "--json",
      ...codexMcpArgs(req.mcpServers),
      // Sans cela, Codex refuse un dossier qui n'est pas un dépôt Git (mode Autonome sur un projet sans Git).
      "--skip-git-repo-check",
      ...codexSandboxArgs(this.#resolveMode(req.permissionsPolicyId)),
      "-",
    ]);
  }

  resume(nativeSessionId: string, req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    return this.#run(req, signal, [
      "exec",
      "resume",
      ...codexMcpArgs(req.mcpServers),
      "--json",
      "--skip-git-repo-check",
      ...codexSandboxArgs(this.#resolveMode(req.permissionsPolicyId)),
      nativeSessionId,
      "-",
    ]);
  }

  #run(req: AgentTaskRequest, signal: AbortSignal, args: string[]): AsyncIterable<AgentEvent> {
    if (!this.#binary)
      return refuse(req.taskId, "binary_not_found", "Codex CLI n'est pas installé ou n'a pas été détecté");
    return runCliTask({
      taskId: req.taskId,
      file: this.#binary,
      args,
      stdin: req.prompt,
      cwd: req.workspacePath,
      env: { ...this.#baseEnv, ...codexMcpConfig(req.mcpServers).env },
      timeoutMs: req.timeoutMs,
      signal,
      normalizer: createCodexNormalizer(),
      ...(this.#runner && { runner: this.#runner }),
    });
  }
}
