// Connecteur factice et déterministe pour les tests du cœur (aucun processus, aucun réseau).
import type { AgentConnector, AgentEvent, AgentTaskRequest, ConnectorManifest, ProbeResult } from "@nexus/contracts";

export type FakeScript =
  /** `sessionAtEnd` : identifiant natif donné par l'événement `completed` (comme Hermes), pas par `started`. */
  | { kind: "complete"; text?: string; nativeSessionId?: string; sessionAtEnd?: boolean }
  | { kind: "fail"; code: "timeout" | "auth_required" | "cli_reported_error" | "network_error" }
  | { kind: "hang"; nativeSessionId?: string };

export class FakeConnector implements AgentConnector {
  readonly manifest: ConnectorManifest;
  readonly requests: Array<{ req: AgentTaskRequest; resumedFrom?: string }> = [];
  script: FakeScript;
  readonly #withResume: boolean;

  constructor(id: string, script: FakeScript, opts: { withResume?: boolean } = {}) {
    this.script = script;
    this.#withResume = opts.withResume ?? true;
    this.manifest = {
      id,
      version: "test",
      kind: "cli",
      displayName: id,
      capabilities: ["chat", "edit", "stream", ...(this.#withResume ? (["resume"] as const) : [])],
      supportedPlatforms: ["linux"],
      authModes: ["api-key"],
      maturity: "fixture-only",
    };
    if (!this.#withResume) delete (this as Partial<AgentConnector>).resume;
  }

  async probe(): Promise<ProbeResult> {
    return { connectorId: this.manifest.id, installed: true, probedAt: new Date().toISOString() };
  }

  start(req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.requests.push({ req });
    return this.#events(req, signal);
  }

  resume(nativeSessionId: string, req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.requests.push({ req, resumedFrom: nativeSessionId });
    return this.#events(req, signal);
  }

  async *#events(req: AgentTaskRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const s = this.script;
    let seq = 0;
    const base = () => ({ taskId: req.taskId, sequence: ++seq });
    yield {
      kind: "started",
      ...base(),
      ...("nativeSessionId" in s &&
        s.nativeSessionId &&
        !("sessionAtEnd" in s && s.sessionAtEnd) && { nativeSessionId: s.nativeSessionId }),
    };
    if (s.kind === "hang") {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { kind: "failed", ...base(), code: "cancelled", message: "cancelled" };
      return;
    }
    if (s.kind === "fail") {
      yield { kind: "failed", ...base(), code: s.code, message: `fake ${s.code}` };
      return;
    }
    yield { kind: "output", ...base(), text: s.text ?? "fait", channel: "message" };
    yield { kind: "usage", ...base(), source: "reported", inputTokens: 10, outputTokens: 5 };
    yield {
      kind: "completed",
      ...base(),
      resultRef: "fake",
      ...(s.sessionAtEnd && s.nativeSessionId && { nativeSessionId: s.nativeSessionId }),
    };
  }
}
