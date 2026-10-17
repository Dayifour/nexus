// Contrat universel d'agent et de connecteur (cahier maître §9), version Zod.
import { z } from "zod";
import { AbsolutePath, Id, LongText, Platform, ShortText, Timestamp } from "./common.ts";

export const AgentKind = z.enum(["cli", "api", "local"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const Capability = z.enum([
  "chat",
  "edit",
  "terminal",
  "structured-output",
  "resume",
  "stream",
  "usage",
  "tools",
]);
export type Capability = z.infer<typeof Capability>;

export const AuthMode = z.enum(["vendor-login", "api-key", "local-none"]);
export type AuthMode = z.infer<typeof AuthMode>;

/** Maturité déclarée : `beta` tant que le connecteur n'a pas été testé contre une version réelle (§26). */
export const ConnectorMaturity = z.enum(["stable", "beta", "fixture-only"]);

export const ConnectorManifest = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  version: z.string().min(1).max(40),
  kind: AgentKind,
  displayName: ShortText,
  capabilities: z.array(Capability),
  supportedPlatforms: z.array(Platform).min(1),
  authModes: z.array(AuthMode).min(1),
  maturity: ConnectorMaturity,
});
export type ConnectorManifest = z.infer<typeof ConnectorManifest>;

export const ProbeResult = z.strictObject({
  connectorId: z.string(),
  installed: z.boolean(),
  version: z.string().max(80).optional(),
  path: AbsolutePath.optional(),
  /** `undefined` = non testé ou non testable sans lire des données d'authentification privées. */
  authenticated: z.boolean().optional(),
  reason: z.string().max(500).optional(),
  probedAt: Timestamp,
});
export type ProbeResult = z.infer<typeof ProbeResult>;

export const Budget = z.strictObject({
  tokens: z.number().int().positive().optional(),
  currencyUsd: z.number().positive().optional(),
});

export const AgentTaskRequest = z.strictObject({
  taskId: Id,
  projectId: Id,
  sessionId: Id,
  agentProfileId: Id,
  workspacePath: AbsolutePath,
  prompt: LongText.min(1),
  contextRefs: z.array(z.string().max(500)).max(200),
  permissionsPolicyId: z.string().min(1).max(100),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(24 * 3600 * 1000),
  budget: Budget.optional(),
  /**
   * Serveurs MCP fournis par Nexus à l'agent (ex. « nexus » : messagerie de l'équipe dans l'Orchestre). Chaque
   * connecteur les transmet à sa CLI sous la forme qu'elle comprend ; ignorés par celles qui n'en ont pas.
   */
  mcpServers: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/),
        command: AbsolutePath,
        args: z.array(z.string().max(2000)).max(20),
        env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000)),
      }),
    )
    .max(4)
    .optional(),
});
export type AgentTaskRequest = z.infer<typeof AgentTaskRequest>;
export type McpServerSpec = NonNullable<AgentTaskRequest["mcpServers"]>[number];

/** Codes d'échec normalisés (proposition D-3 de l'ADR-001, intégrée au contrat v1). */
export const FailureCode = z.enum([
  "cli_reported_error",
  "stream_ended_without_result",
  "spawn_failed",
  "binary_not_found",
  "timeout",
  "cancelled",
  "sandbox_unavailable",
  "policy_denied",
  "auth_required",
  "rate_limited",
  "network_error",
  "provider_error",
  "budget_exceeded",
  "invalid_output",
]);
export type FailureCode = z.infer<typeof FailureCode>;

const base = { taskId: Id, sequence: z.number().int().positive() };

export const AgentEvent = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("started"), ...base, nativeSessionId: z.string().max(200).optional() }),
  z.strictObject({
    kind: z.literal("output"),
    ...base,
    text: z.string().max(1_000_000),
    channel: z.enum(["stdout", "stderr", "message"]),
  }),
  z.strictObject({
    kind: z.literal("tool-request"),
    ...base,
    tool: z.string().max(200),
    payloadRef: z.string().max(500),
  }),
  z.strictObject({
    kind: z.literal("usage"),
    ...base,
    source: z.enum(["reported", "estimated"]),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    usd: z.number().nonnegative().optional(),
    /** Obligatoire en pratique quand `usd` est indicatif (ex. coût affiché sous abonnement). */
    caveat: z.string().max(500).optional(),
  }),
  /** État de quota signalé par le CLI (ex. Claude `rate_limit_event`) : fenêtre, utilisation, réinitialisation. */
  z.strictObject({
    kind: z.literal("quota"),
    ...base,
    status: z.string().max(40),
    window: z.string().max(40).optional(),
    /** Part consommée de la fenêtre (0..1), si le CLI la donne. */
    utilization: z.number().min(0).max(1).optional(),
    resetsAt: Timestamp.optional(),
  }),
  /** `nativeSessionId` : pour les CLI qui ne donnent l'identifiant de session qu'à la fin (ex. Hermes `chat -Q`). */
  z.strictObject({
    kind: z.literal("completed"),
    ...base,
    resultRef: z.string().max(500),
    nativeSessionId: z.string().max(200).optional(),
  }),
  z.strictObject({ kind: z.literal("failed"), ...base, code: FailureCode, message: z.string().max(2000) }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const UsageSnapshot = z.strictObject({
  observedAt: Timestamp,
  source: z.enum(["vendor", "cli", "local-estimate", "unavailable"]),
  remaining: z.number().nonnegative().optional(),
  consumed: z.number().nonnegative().optional(),
  unit: z.enum(["tokens", "requests", "usd", "percent"]).optional(),
  windowEnd: Timestamp.optional(),
  caveat: z.string().max(500).optional(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

/**
 * Interface d'un connecteur (cahier maître §9). Type TypeScript seulement : les données qui la traversent
 * (requêtes, événements) sont validées par les schémas ci-dessus.
 */
export interface AgentConnector {
  readonly manifest: ConnectorManifest;
  probe(): Promise<ProbeResult>;
  start(req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  resume?(nativeSessionId: string, req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  getUsage?(): Promise<UsageSnapshot>;
}
