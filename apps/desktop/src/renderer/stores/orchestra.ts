// Orchestres du projet : liste, détail par mission (équipe, tâches, fil), fil en direct (événements `orchestra`)
// et actions (lancer, valider le plan, arrêter, message au chef, changements, intégration).
import type { IpcRequest, IpcResponse, OrchestraDetail, OrchestraFeedEntry, OrchestraSummary } from "@nexus/contracts";
import { create } from "zustand";
import { call } from "../api.ts";
import type { Res } from "../types.ts";
import { done, failed, pending } from "./util.ts";

export type OrchestraChanges = IpcResponse<"orchestra.changes">;
export type OrchestraStartInput = Omit<IpcRequest<"orchestra.start">, "projectId">;

const MAX_FEED = 1500;
const feedKey = (e: OrchestraFeedEntry) => `${e.at}|${e.kind}|${e.from ?? ""}|${e.to ?? ""}|${e.text.slice(0, 80)}`;

/** Fusionne deux fils (détail chargé + événements en direct) sans doublon, dans l'ordre chronologique. */
export function mergeFeed(a: OrchestraFeedEntry[], b: OrchestraFeedEntry[]): OrchestraFeedEntry[] {
  const seen = new Set<string>();
  const out: OrchestraFeedEntry[] = [];
  for (const e of [...a, ...b]) {
    const k = feedKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((x, y) => x.at.localeCompare(y.at)).slice(-MAX_FEED);
}

interface OrchestraState {
  projectId?: string;
  list: Res<OrchestraSummary[]>;
  details: Record<string, Res<OrchestraDetail>>;
  /** Entrées reçues en direct (avant ou en plus du détail chargé). */
  live: Record<string, OrchestraFeedEntry[]>;
  changes: Record<string, Res<OrchestraChanges>>;
  reset(projectId: string | undefined): void;
  refresh(): Promise<void>;
  load(missionId: string): Promise<void>;
  start(input: OrchestraStartInput): Promise<string>;
  approvePlan(missionId: string): Promise<void>;
  stop(missionId: string): Promise<void>;
  /** Reprend un orchestre arrêté ou en échec (ex. interrompu par un redémarrage de l'application). */
  resume(missionId: string): Promise<void>;
  message(missionId: string, text: string): Promise<void>;
  loadChanges(missionId: string): Promise<void>;
  merge(missionId: string): Promise<string>;
  pushEntry(missionId: string, entry: OrchestraFeedEntry): void;
}

export const useOrchestraStore = create<OrchestraState>()((set, get) => ({
  list: { loading: false },
  details: {},
  live: {},
  changes: {},
  reset(projectId) {
    set({ projectId, list: { loading: false }, details: {}, live: {}, changes: {} });
  },
  async refresh() {
    const projectId = get().projectId;
    if (!projectId) return;
    set((s) => ({ list: pending(s.list) }));
    try {
      const list = await call("orchestra.list", { projectId });
      if (get().projectId !== projectId) return;
      set({ list: done([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) });
    } catch (e) {
      if (get().projectId === projectId) set((s) => ({ list: failed(s.list, e) }));
    }
  },
  async load(missionId) {
    set((s) => ({ details: { ...s.details, [missionId]: pending(s.details[missionId]) } }));
    try {
      const detail = await call("orchestra.get", { missionId });
      set((s) => ({ details: { ...s.details, [missionId]: done(detail) } }));
    } catch (e) {
      set((s) => ({ details: { ...s.details, [missionId]: failed(s.details[missionId], e) } }));
    }
  },
  async start(input) {
    const projectId = get().projectId;
    if (!projectId) throw new Error("no project");
    const { missionId } = await call("orchestra.start", { projectId, ...input });
    void get().refresh();
    void get().load(missionId);
    return missionId;
  },
  async approvePlan(missionId) {
    await call("orchestra.approvePlan", { missionId });
    void get().load(missionId);
  },
  async stop(missionId) {
    await call("orchestra.stop", { missionId });
    void get().load(missionId);
    void get().refresh();
  },
  async resume(missionId) {
    await call("orchestra.resume", { missionId });
    void get().load(missionId);
    void get().refresh();
  },
  async message(missionId, text) {
    await call("orchestra.message", { missionId, text });
  },
  async loadChanges(missionId) {
    set((s) => ({ changes: { ...s.changes, [missionId]: pending(s.changes[missionId]) } }));
    try {
      const changes = await call("orchestra.changes", { missionId });
      set((s) => ({ changes: { ...s.changes, [missionId]: done(changes) } }));
    } catch (e) {
      set((s) => ({ changes: { ...s.changes, [missionId]: failed(s.changes[missionId], e) } }));
    }
  },
  async merge(missionId) {
    const r = await call("orchestra.merge", { missionId });
    void get().loadChanges(missionId);
    return r.summary;
  },
  pushEntry(missionId, entry) {
    set((s) => ({ live: { ...s.live, [missionId]: mergeFeed(s.live[missionId] ?? [], [entry]) } }));
  },
}));
