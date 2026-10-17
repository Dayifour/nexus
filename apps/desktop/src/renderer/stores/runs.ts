// Flux de sortie des agents par tâche (sessions et tâches d'orchestre) : historique (`tasks.events`) puis
// événements poussés, dédoublonnés et bornés en mémoire.
import { create } from "zustand";
import { call } from "../api.ts";
import type { AgentEvent, Res } from "../types.ts";
import { failed } from "./util.ts";

export interface RunEntry {
  key: string;
  runId: string;
  globalSequence?: number;
  /** Horodatage (ms) : `occurredAt` de l'historique, ou réception pour un événement poussé. */
  at?: number;
  event: AgentEvent;
}

export interface RunStream {
  entries: RunEntry[];
  /** Incrémenté quand la liste est reconstruite (le terminal se réinitialise alors). */
  version: number;
  loading: boolean;
  error?: Res<never>["error"];
}

/** Taille maximale conservée par flux de tâche, pour borner la mémoire du renderer. */
const MAX_ENTRIES = 5000;

interface RunsState {
  runs: Record<string, RunStream>;
  loadRun(taskId: string): Promise<void>;
  appendRunEvent(taskId: string, runId: string, event: AgentEvent): void;
  /** Libère les flux des tâches (changement ou fermeture de projet) : la mémoire ne grossit pas d'un projet à l'autre. */
  evictRuns(): void;
}

const entryKey = (runId: string, sequence: number) => `${runId}:${sequence}`;
/** Clés déjà reçues par tâche : dédoublonnage en O(1) à chaque événement poussé (au lieu d'un parcours du flux). */
const seenKeys = new Map<string, Set<string>>();
const resetSeen = (taskId: string, entries: RunEntry[]) => {
  seenKeys.set(taskId, new Set(entries.map((e) => e.key)));
};
const emptyStream = (): RunStream => ({ entries: [], version: 0, loading: false });

export const useRunsStore = create<RunsState>()((set) => ({
  runs: {},
  async loadRun(taskId) {
    set((s) => ({
      runs: { ...s.runs, [taskId]: { ...(s.runs[taskId] ?? emptyStream()), loading: true, error: undefined } },
    }));
    try {
      const history = await call("tasks.events", { taskId, afterSequence: 0 });
      set((s) => {
        const prev = s.runs[taskId] ?? emptyStream();
        const entries: RunEntry[] = history.map((h) => ({
          key: entryKey(h.runId, h.event.sequence),
          runId: h.runId,
          globalSequence: h.globalSequence,
          at: Date.parse(h.occurredAt) || undefined,
          event: h.event,
        }));
        const known = new Set(entries.map((e) => e.key));
        // Événements poussés reçus pendant le chargement et absents de l'historique : conservés à la suite.
        for (const e of prev.entries) if (!known.has(e.key)) entries.push(e);
        const kept = entries.slice(-MAX_ENTRIES);
        resetSeen(taskId, kept);
        return {
          runs: {
            ...s.runs,
            [taskId]: { entries: kept, version: prev.version + 1, loading: false },
          },
        };
      });
    } catch (e) {
      set((s) => ({
        runs: {
          ...s.runs,
          [taskId]: { ...(s.runs[taskId] ?? emptyStream()), loading: false, error: failed(undefined, e).error },
        },
      }));
    }
  },
  appendRunEvent(taskId, runId, event) {
    set((s) => {
      const prev = s.runs[taskId] ?? emptyStream();
      const key = entryKey(runId, event.sequence);
      let seen = seenKeys.get(taskId);
      if (!seen) {
        seen = new Set(prev.entries.map((e) => e.key));
        seenKeys.set(taskId, seen);
      }
      if (seen.has(key)) return s;
      seen.add(key);
      let entries = [...prev.entries, { key, runId, at: Date.now(), event }];
      let version = prev.version;
      if (entries.length > MAX_ENTRIES) {
        entries = entries.slice(-MAX_ENTRIES);
        resetSeen(taskId, entries);
        version += 1;
      }
      return { runs: { ...s.runs, [taskId]: { ...prev, entries, version } } };
    });
  },
  evictRuns() {
    seenKeys.clear();
    set({ runs: {} });
  },
}));
