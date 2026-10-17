// Alias de types dérivés du contrat IPC (les schémas zod ne sont pas importés dans le renderer).
import type { IpcResponse } from "@nexus/contracts";
import type { NexusError } from "./api.ts";

export type AppInfo = IpcResponse<"app.info">;
export type Capabilities = IpcResponse<"app.capabilities">;
export type ProbeResult = IpcResponse<"agents.inventory">[number];
export type ProjectSummary = IpcResponse<"projects.list">[number];
export type ProjectDetail = IpcResponse<"projects.get">;
export type RunEventDto = IpcResponse<"tasks.events">[number];
export type AgentEvent = RunEventDto["event"];
export type DiffDto = IpcResponse<"tasks.diff">;
export type SecretMetadata = IpcResponse<"secrets.list">[number];
export type FileEntry = IpcResponse<"files.list">[number];
export type FileContent = IpcResponse<"files.read">;
export type GitStatus = IpcResponse<"git.status">;
export type UsageSummary = IpcResponse<"usage.summary">;

/** Donnée chargée depuis le main : valeur, erreur éventuelle et indicateur de chargement. */
export interface Res<T> {
  data?: T;
  error?: NexusError;
  loading: boolean;
}

export const IDLE: Res<never> = Object.freeze({ loading: false });

export type RecentProject = IpcResponse<"projects.recent">[number];
export type SessionSummary = IpcResponse<"sessions.list">[number];
export type SessionMode = "autonomous" | "sandboxed" | "supervised";
export type AppSettings = IpcResponse<"settings.get">;
export type SearchHit = IpcResponse<"files.search">[number];
export type PushNowResult = IpcResponse<"git.pushNow">;

/** Outils sondés par l'inventaire qui ne sont pas des agents (exclus du choix d'agent). */
export const NON_AGENT_TOOLS = new Set(["git", "gh", "vercel"]);
