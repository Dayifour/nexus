// Pont des événements poussés par le main : sortie des terminaux, changements de fichiers, flux des agents et
// événements de domaine (rafraîchissements regroupés pour qu'une rafale ne déclenche qu'un appel par cible).
import type { IpcPushEvent } from "@nexus/contracts";
import { subscribe } from "../api.ts";
import { useDeployPlanStore } from "../stores/deployPlan.ts";
import { useEditorsStore } from "../stores/editors.ts";
import { tNow, type TKey } from "../i18n/index.ts";
import { logEvent } from "../stores/log.ts";
import { useFilesStore } from "../stores/files.ts";
import { useGitStore } from "../stores/git.ts";
import { useRunsStore } from "../stores/runs.ts";
import { useOrchestraStore } from "../stores/orchestra.ts";
import { useProjectStore } from "../stores/project.ts";
import { useSessionsStore } from "../stores/sessions.ts";
import { terminalBus } from "../stores/terminals.ts";
import { openSession } from "../workbench/dock.ts";
import { openSessionTerminal } from "./agent-terminal.ts";
import { onSandboxDenied } from "./sandbox-denials.ts";
import { agentName } from "../ui/AgentAvatar.tsx";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
function soon(key: string, fn: () => void, delay = 200): void {
  if (timers.has(key)) return;
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      fn();
    }, delay),
  );
}

const sessionLabel = (taskId: string) => {
  const s = useSessionsStore.getState().list.data?.find((x) => x.taskId === taskId);
  return s ? `${agentName(s.connectorId)} · ${s.title.slice(0, 60)}` : taskId.slice(0, 8);
};

export function handlePushEvent(event: IpcPushEvent): void {
  const projectId = useProjectStore.getState().current?.projectId;
  switch (event.type) {
    case "terminal":
      terminalBus.emitData(event.terminalId, event.data);
      return;
    case "terminal-exit":
      terminalBus.emitExit(event.terminalId, event.exitCode);
      logEvent("info", "terminal", `exit ${event.exitCode ?? "?"} (${event.terminalId.slice(0, 8)})`);
      return;
    case "fs": {
      if (event.projectId !== projectId) return;
      useFilesStore.getState().handleFsChanges(event.changes.map((c) => c.path));
      for (const c of event.changes) if (c.kind === "changed") useEditorsStore.getState().externalChange(c.path);
      soon("git", () => void useGitStore.getState().refresh(), 600);
      return;
    }
    case "run":
      useRunsStore.getState().appendRunEvent(event.taskId, event.runId, event.event);
      if (event.event.kind === "started" || event.event.kind === "completed")
        logEvent(
          "info",
          "agent",
          `${sessionLabel(event.taskId)} : ${tNow(event.event.kind === "started" ? "session.started" : "session.completed")}`,
        );
      else if (event.event.kind === "failed")
        logEvent(
          "error",
          "agent",
          `${sessionLabel(event.taskId)} : ${tNow("session.failed")} [${event.event.code}] ${event.event.message}`,
        );
      if (event.event.kind === "quota") {
        const connectorId = useSessionsStore.getState().list.data?.find((x) => x.taskId === event.taskId)?.connectorId;
        if (connectorId) useSessionsStore.getState().setQuota(connectorId, event.event);
      }
      if (event.event.kind === "completed" || event.event.kind === "failed" || event.event.kind === "started") {
        soon("sessions", () => void useSessionsStore.getState().refresh());
        soon("git", () => void useGitStore.getState().refresh(), 600);
      }
      return;
    case "agent-status":
      if (useSessionsStore.getState().live[event.taskId] !== event.status)
        logEvent(
          event.status === "error" ? "error" : event.status === "needs_input" ? "warn" : "info",
          "agent",
          `${sessionLabel(event.taskId)} : ${tNow(`live.${event.status}` as TKey)}`,
        );
      useSessionsStore.getState().setLive(event.taskId, event.status);
      if (event.status === "done" || event.status === "error" || event.status === "needs_input") {
        soon("sessions", () => void useSessionsStore.getState().refresh());
      }
      return;
    case "navigate": {
      // Clic sur une notification : ouvre la session et, si elle a un terminal d'agent, son onglet terminal.
      const taskId = event.taskId;
      const find = () => useSessionsStore.getState().list.data?.find((x) => x.taskId === taskId);
      const go = () => {
        const s = find();
        openSession(taskId, s?.title ?? tNow("session.fallbackTitle"));
        if (s) openSessionTerminal(s);
      };
      if (find()?.terminalId) go();
      else void useSessionsStore.getState().refresh().then(go, go);
      return;
    }
    case "orchestra": {
      const orch = useOrchestraStore.getState();
      orch.pushEntry(event.missionId, event.entry);
      // Journal : jalons seulement (phases, synthèse, erreurs) ; le fil complet est dans la vue Orchestre.
      if (event.entry.kind === "phase" || event.entry.kind === "summary" || event.entry.kind === "error")
        logEvent(
          event.entry.kind === "error" ? "error" : "info",
          "orchestra",
          `${event.entry.kind} : ${event.entry.text.slice(0, 200)}`,
        );
      // Détail (équipe, tâches, phase) rechargé par paquets ; la liste suit les changements de phase.
      if (orch.details[event.missionId])
        soon(`orch:${event.missionId}`, () => void useOrchestraStore.getState().load(event.missionId), 400);
      if (event.entry.kind === "phase" || event.entry.kind === "summary")
        soon("orchestras", () => void useOrchestraStore.getState().refresh());
      return;
    }
    case "deploy-log":
      // Chaque ligne est affichée dans l'étape de déploiement ; le journal ne la duplique pas.
      useDeployPlanStore.getState().appendLog(event.projectId, event.stepId, event.line);
      return;
    case "sandbox-denied":
      logEvent("warn", "sandbox", `${event.target} — ${event.reason}`);
      onSandboxDenied(event);
      return;
    case "domain":
      logEvent("info", event.aggregateType, event.eventType);
      break;
    default:
      return;
  }
  switch (event.aggregateType) {
    case "project":
      soon("recent", () => void useProjectStore.getState().loadRecent());
      break;
    case "mission":
      if (useOrchestraStore.getState().details[event.aggregateId])
        soon(`orch:${event.aggregateId}`, () => void useOrchestraStore.getState().load(event.aggregateId), 400);
      soon("sessions", () => void useSessionsStore.getState().refresh());
      break;
    case "task":
    case "agent_run":
    case "session":
      soon("sessions", () => void useSessionsStore.getState().refresh());
      // Tâche d'un orchestre ouvert : statut des nœuds du graphe et de l'équipe mis à jour.
      for (const [missionId, res] of Object.entries(useOrchestraStore.getState().details)) {
        if (res.data?.tasks.some((x) => x.taskId === event.aggregateId))
          soon(`orch:${missionId}`, () => void useOrchestraStore.getState().load(missionId), 400);
      }
      break;
    case "worktree":
      soon("git", () => void useGitStore.getState().refresh());
      break;
    default:
      break;
  }
}

export function startEventBridge(): () => void {
  return subscribe(handlePushEvent);
}
