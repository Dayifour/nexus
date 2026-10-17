// Sessions d'agents (le cœur du produit) : un agent, une consigne, un mode. Liste en direct (`sessions.list`),
// démarrage, relance, arrêt, diff et revue. Le flux d'événements de chaque session est tenu par le store des flux
// (`runs`), alimenté par `tasks.events` et les événements poussés `run`.
import { create } from "zustand";
import { call } from "../api.ts";
import type { IpcResponse } from "@nexus/contracts";
import type { DiffDto, Res, SessionMode, SessionSummary } from "../types.ts";
import type { QuotaEvent } from "../lib/quota.ts";
import { useRunsStore } from "./runs.ts";
import { done, failed, pending } from "./util.ts";

export interface SandboxDenial {
  target: string;
  reason: string;
  at: number;
  count: number;
}

export type StartManyResult = IpcResponse<"sessions.startMany">;

export type LiveStatus = "starting" | "working" | "idle" | "needs_input" | "done" | "error";

interface SessionsState {
  projectId?: string;
  list: Res<SessionSummary[]>;
  diffs: Record<string, Res<DiffDto>>;
  /** Consigne initiale connue localement (sessions démarrées depuis cette fenêtre). */
  prompts: Record<string, string>;
  /** État en direct fourni par les hooks de l'agent (événements `agent-status`). */
  live: Record<string, LiveStatus>;
  setLive(taskId: string, status: LiveStatus): void;
  /** Dernier quota connu par agent (connectorId). */
  quotas: Record<string, QuotaEvent>;
  /** Sessions lancées en mode Terminal (TUI) depuis cette fenêtre (indicateur local, complète `terminalId`). */
  interactive: Record<string, true>;
  /** Messages envoyés après la consigne initiale (affichés dans le fil à l'endroit où ils ont été envoyés). */
  followUps: Record<string, Array<{ text: string; at: number; afterEntries: number }>>;
  /** Supprime une session terminée (`sessions.delete`) ; refusée par le main si elle est en cours. */
  remove(taskId: string): Promise<void>;
  markInteractive(taskId: string): void;
  /** Connexions refusées par la sandbox, par tâche ("" si non rattachée), les plus récentes d'abord. */
  denials: Record<string, SandboxDenial[]>;
  addDenial(taskId: string | undefined, d: { target: string; reason: string }): void;
  setQuota(connectorId: string, quota: QuotaEvent): void;
  startMany(input: {
    connectorIds: string[];
    mode: "sandboxed" | "supervised";
    prompt: string;
    title?: string;
    interactive: boolean;
    cols: number;
    rows: number;
  }): Promise<StartManyResult>;
  startInteractive(input: {
    connectorId: string;
    prompt?: string;
    mode: SessionMode;
    title?: string;
    cols: number;
    rows: number;
  }): Promise<{ taskId: string; terminalId: string; workspacePath: string }>;
  reset(projectId: string | undefined): void;
  refresh(): Promise<void>;
  start(input: { connectorId: string; prompt: string; mode: SessionMode; title?: string }): Promise<string>;
  followUp(taskId: string, prompt: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  review(taskId: string, decision: "approve" | "request_changes"): Promise<void>;
  loadDiff(taskId: string): Promise<void>;
}

export const ACTIVE_STATUSES = new Set(["queued", "running", "waiting_input"]);
/** Statuts finaux : l'état en direct (activité du terminal) n'est plus affiché par-dessus. */
export const FINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
/** État en direct à afficher pour une session (rien si elle est terminée ou si l'état est « done »). */
export const shownLive = (status: string, live: LiveStatus | undefined): LiveStatus | undefined =>
  live && live !== "done" && !FINAL_STATUSES.has(status) ? live : undefined;

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  projectId: undefined,
  list: { loading: false },
  diffs: {},
  prompts: {},
  live: {},
  quotas: {},
  interactive: {},
  followUps: {},
  async remove(taskId) {
    await call("sessions.delete", { taskId });
    set((s) => {
      const { [taskId]: _p, ...prompts } = s.prompts;
      const { [taskId]: _f, ...followUps } = s.followUps;
      return {
        prompts,
        followUps,
        list: s.list.data ? { ...s.list, data: s.list.data.filter((x) => x.taskId !== taskId) } : s.list,
      };
    });
    void get().refresh();
  },
  markInteractive(taskId) {
    set((s) => ({ interactive: { ...s.interactive, [taskId]: true } }));
  },
  denials: {},
  addDenial(taskId, d) {
    const key = taskId ?? "";
    set((s) => {
      const prev = s.denials[key] ?? [];
      const same = prev.find((x) => x.target === d.target);
      const next = same
        ? [{ ...same, reason: d.reason, at: Date.now(), count: same.count + 1 }, ...prev.filter((x) => x !== same)]
        : [{ ...d, at: Date.now(), count: 1 }, ...prev];
      return { denials: { ...s.denials, [key]: next.slice(0, 20) } };
    });
  },
  setQuota(connectorId, quota) {
    set((s) => ({ quotas: { ...s.quotas, [connectorId]: quota } }));
  },
  async startMany(input) {
    const projectId = get().projectId;
    if (!projectId) throw new Error("no project");
    const r = await call("sessions.startMany", {
      projectId,
      connectorIds: input.connectorIds,
      mode: input.mode,
      prompt: input.prompt,
      interactive: input.interactive,
      cols: input.cols,
      rows: input.rows,
      ...(input.title && { title: input.title }),
    });
    const prompts = { ...get().prompts };
    for (const x of r) if (x.taskId) prompts[x.taskId] = input.prompt;
    set({ prompts });
    if (input.interactive) for (const x of r) if (x.taskId) get().markInteractive(x.taskId);
    void get().refresh();
    return r;
  },
  setLive(taskId, status) {
    set((s) => ({ live: { ...s.live, [taskId]: status } }));
  },
  async startInteractive(input) {
    const projectId = get().projectId;
    if (!projectId) throw new Error("no project");
    const r = await call("sessions.startInteractive", {
      projectId,
      connectorId: input.connectorId,
      mode: input.mode,
      cols: input.cols,
      rows: input.rows,
      ...(input.prompt && { prompt: input.prompt }),
      ...(input.title && { title: input.title }),
    });
    if (input.prompt) set((s) => ({ prompts: { ...s.prompts, [r.taskId]: input.prompt ?? "" } }));
    get().markInteractive(r.taskId);
    void get().refresh();
    return r;
  },
  reset(projectId) {
    set({ projectId, list: { loading: false }, diffs: {} });
  },
  async refresh() {
    const projectId = get().projectId;
    if (!projectId) return;
    set((s) => ({ list: pending(s.list) }));
    try {
      const list = await call("sessions.list", { projectId });
      if (get().projectId !== projectId) return;
      // État en direct initial (rechargement) : celui rapporté par le main, puis les événements `agent-status`.
      const live = { ...get().live };
      for (const s of list) if (s.agentStatus) live[s.taskId] = s.agentStatus;
      set({ list: done([...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))), live });
    } catch (e) {
      if (get().projectId !== projectId) return;
      set((s) => ({ list: failed(s.list, e) }));
    }
  },
  async start(input) {
    const projectId = get().projectId;
    if (!projectId) throw new Error("no project");
    const { taskId } = await call("sessions.start", {
      projectId,
      connectorId: input.connectorId,
      prompt: input.prompt,
      mode: input.mode,
      ...(input.title && { title: input.title }),
    });
    set((s) => ({ prompts: { ...s.prompts, [taskId]: input.prompt } }));
    void get().refresh();
    return taskId;
  },
  async followUp(taskId, prompt) {
    // Position dans le fil mémorisée avant l'envoi : les événements du nouveau tour arrivent juste après.
    const afterEntries = useRunsStore.getState().runs[taskId]?.entries.length ?? 0;
    await call("sessions.followUp", { taskId, prompt });
    set((s) => ({
      followUps: {
        ...s.followUps,
        [taskId]: [...(s.followUps[taskId] ?? []), { text: prompt, at: Date.now(), afterEntries }],
      },
    }));
    void get().refresh();
  },
  async cancel(taskId) {
    await call("tasks.cancel", { taskId });
    void get().refresh();
  },
  async review(taskId, decision) {
    await call("tasks.review", { taskId, decision });
    void get().refresh();
  },
  async loadDiff(taskId) {
    set((s) => ({ diffs: { ...s.diffs, [taskId]: pending(s.diffs[taskId]) } }));
    try {
      const diff = await call("tasks.diff", { taskId });
      set((s) => ({ diffs: { ...s.diffs, [taskId]: done(diff) } }));
    } catch (e) {
      set((s) => ({ diffs: { ...s.diffs, [taskId]: failed(s.diffs[taskId], e) } }));
    }
  },
}));
