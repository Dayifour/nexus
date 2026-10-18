// Client IPC typé du renderer. Seule interface avec le main : `window.nexus` exposé par le preload.
// Imports de TYPES uniquement depuis @nexus/contracts (zod n'est pas embarqué dans le renderer).
import type { IpcChannel, IpcErrorCode, IpcPushEvent, IpcRequest, IpcResponse, IpcResult } from "@nexus/contracts";

interface NexusBridge {
  invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>>;
  onEvent(listener: (event: unknown) => void): () => void;
  pathForFile?(file: File): string;
}

/** Code d'erreur côté renderer : codes du contrat + erreurs locales (pont absent, réponse illisible). */
export type NexusErrorCode = IpcErrorCode | "bridge_missing" | "client_error";

/** Erreur typée levée par `call` quand le main répond `ok: false`. */
export class NexusError extends Error {
  readonly code: NexusErrorCode;
  readonly channel: string;
  constructor(code: NexusErrorCode, message: string, channel: string) {
    super(message);
    this.name = "NexusError";
    this.code = code;
    this.channel = channel;
  }
}

function bridge(): NexusBridge | undefined {
  return (globalThis as unknown as { nexus?: NexusBridge }).nexus;
}

/** Appelle un canal IPC ; renvoie la donnée validée par le main ou lève une `NexusError`. */
export async function call<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>> {
  const nexus = bridge();
  if (!nexus) throw new NexusError("bridge_missing", "Preload bridge is not available", channel);
  let result: IpcResult<IpcResponse<C>>;
  try {
    result = await nexus.invoke(channel, payload);
  } catch (e) {
    throw new NexusError("client_error", e instanceof Error ? e.message : String(e), channel);
  }
  if (!result || typeof result !== "object") throw new NexusError("client_error", "Malformed IPC result", channel);
  if (result.ok) return result.data;
  throw new NexusError(result.error.code, result.error.message, channel);
}

/** Normalise n'importe quelle erreur en `NexusError` (pour l'affichage). */
export function toNexusError(e: unknown, channel = "?"): NexusError {
  if (e instanceof NexusError) return e;
  return new NexusError("client_error", e instanceof Error ? e.message : String(e), channel);
}

/**
 * Validation légère de la forme d'un événement poussé (le main l'a déjà validé et expurgé ;
 * on vérifie seulement la discrimination pour ne pas planter sur une donnée inattendue).
 */
function asPushEvent(raw: unknown): IpcPushEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Record<string, unknown>;
  if (e.type === "domain" && typeof e.aggregateType === "string" && typeof e.aggregateId === "string") {
    return raw as IpcPushEvent;
  }
  if (e.type === "terminal" && typeof e.terminalId === "string" && typeof e.data === "string") {
    return raw as IpcPushEvent;
  }
  if (e.type === "terminal-exit" && typeof e.terminalId === "string") return raw as IpcPushEvent;
  if (e.type === "agent-status" && typeof e.taskId === "string" && typeof e.status === "string") {
    return raw as IpcPushEvent;
  }
  if (e.type === "navigate" && typeof e.taskId === "string") return raw as IpcPushEvent;
  if (e.type === "orchestra" && typeof e.missionId === "string" && e.entry && typeof e.entry === "object") {
    return raw as IpcPushEvent;
  }
  if (
    e.type === "deploy-log" &&
    typeof e.projectId === "string" &&
    typeof e.stepId === "string" &&
    typeof e.line === "string"
  ) {
    return raw as IpcPushEvent;
  }
  if (e.type === "sandbox-denied" && typeof e.target === "string" && typeof e.reason === "string") {
    return raw as IpcPushEvent;
  }
  if (e.type === "fs" && typeof e.projectId === "string" && Array.isArray(e.changes)) return raw as IpcPushEvent;
  if (e.type === "system-theme" && typeof e.dark === "boolean") return raw as IpcPushEvent;
  if (
    e.type === "run" &&
    typeof e.taskId === "string" &&
    typeof e.runId === "string" &&
    e.event &&
    typeof e.event === "object"
  ) {
    return raw as IpcPushEvent;
  }
  return undefined;
}

/** Abonnement aux événements du main. Renvoie la fonction de désabonnement (no-op si pont absent). */
export function subscribe(listener: (event: IpcPushEvent) => void): () => void {
  const nexus = bridge();
  if (!nexus) return () => {};
  return nexus.onEvent((raw) => {
    const event = asPushEvent(raw);
    if (event) listener(event);
  });
}

/** Vrai si l'erreur signifie « canal pas (encore) servi par le main » : l'interface affiche alors un état propre. */
export function isUnavailable(e: unknown): boolean {
  return (
    e instanceof NexusError && (e.code === "unavailable" || e.code === "unknown_channel" || e.code === "bridge_missing")
  );
}

/**
 * Chemin absolu d'un fichier ou dossier déposé (glisser-déposer), via le pont. Chaîne vide si inconnu
 * (fichier synthétique, pont absent) : le main revalide de toute façon le chemin.
 */
export function pathForFile(file: File): string {
  try {
    return bridge()?.pathForFile?.(file) ?? "";
  } catch {
    return "";
  }
}
