// Contexte d'une tâche affichée dans la vue d'activité, quelle que soit son origine : session ou tâche d'un
// orchestre (titre, agent, statut, dépendances, raison d'échec, réattribution).
import { useMemo } from "react";
import { useOrchestraStore } from "../stores/orchestra.ts";
import { useSessionsStore } from "../stores/sessions.ts";
import { getDock, openSession } from "../workbench/dock.ts";
import { openSessionTerminal } from "./agent-terminal.ts";

export interface TaskContext {
  title?: string;
  status?: string;
  connectorId?: string;
  /** Titres des tâches dont celle-ci dépend et qui ne sont pas terminées. */
  waitingFor: string[];
  lastFailureCode?: string;
  /** Réattributions de l'orchestre concernant cette tâche (texte localisé par le main). */
  reassignments: string[];
}

const DONE = new Set(["completed", "done", "skipped"]);

export function useTaskContext(taskId: string): TaskContext {
  const session = useSessionsStore((s) => s.list.data?.find((x) => x.taskId === taskId));
  // Sélecteurs stables (références du store) ; le calcul se fait ensuite, sans créer d'objet dans le sélecteur.
  const details = useOrchestraStore((s) => s.details);
  const liveFeeds = useOrchestraStore((s) => s.live);
  const orch = useMemo(() => {
    for (const [missionId, res] of Object.entries(details)) {
      const task = res.data?.tasks.find((x) => x.taskId === taskId);
      if (task && res.data) return { detail: res.data, task, live: liveFeeds[missionId] };
    }
    return undefined;
  }, [details, liveFeeds, taskId]);

  let waitingFor: string[] = [];
  let connectorId = session?.connectorId;
  let reassignments: string[] = [];
  if (orch?.detail) {
    const all = orch.detail.tasks;
    waitingFor = orch.task.dependsOn
      .map((d) => all.find((x) => x.taskId === d || x.key === d))
      .filter((x) => x && !DONE.has(x.status))
      .map((x) => x?.title ?? "");
    connectorId ??= orch.detail.members.find((m) => m.agentId === orch.task.agentId)?.connectorId;
    reassignments = [...orch.detail.feed, ...(orch.live ?? [])]
      .filter((e) => e.kind === "assign" && e.reassigned && e.taskId === taskId)
      .map((e) => e.text);
    reassignments = [...new Set(reassignments)];
  }
  return {
    title: session?.title ?? orch?.task.title,
    status: session?.status ?? orch?.task.status,
    ...(connectorId && { connectorId }),
    waitingFor,
    ...(session?.lastFailureCode && { lastFailureCode: session.lastFailureCode }),
    reassignments,
  };
}

/** Ouvre l'activité d'une tâche : vue en direct, plus son onglet terminal si elle tourne en mode Terminal. */
export function openTaskActivity(taskId: string, title: string): void {
  openSession(taskId, title);
  const s = useSessionsStore.getState().list.data?.find((x) => x.taskId === taskId);
  if (s && (s.terminalId || getDock()?.getPanel(`agent-term:${taskId}`))) openSessionTerminal(s);
}
