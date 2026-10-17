// DAG de tâches et ordonnancement (cahier maître §10, FR-010, T-012). Fonctions pures, sans E/S.
// Une tâche ne démarre que si ses dépendances sont terminées avec succès, que le budget et les permissions le
// permettent, qu'aucune tâche en cours n'écrit dans un chemin qui recouvre le sien, et sous le plafond de parallélisme.
import { TERMINAL_TASK_STATUSES, type FailureCode, type TaskStatus } from "@nexus/contracts";

export type DagTask = {
  id: string;
  status: TaskStatus;
  dependsOn: readonly string[];
  allowedPaths: readonly string[];
  attempt: number;
  maxAttempts: number;
  lastFailureCode?: string | undefined;
  assignedAgentId?: string | undefined;
};

export type DagIssue =
  | { kind: "unknown_dependency"; taskId: string; dependsOn: string }
  | { kind: "self_dependency"; taskId: string }
  | { kind: "cycle"; taskIds: string[] }
  | { kind: "duplicate_id"; taskId: string };

/** Valide la structure : identifiants uniques, dépendances connues, pas d'auto-dépendance ni de cycle. */
export function validateDag(tasks: readonly Pick<DagTask, "id" | "dependsOn">[]): DagIssue[] {
  const issues: DagIssue[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) issues.push({ kind: "duplicate_id", taskId: t.id });
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) issues.push({ kind: "self_dependency", taskId: t.id });
      else if (!ids.has(d)) issues.push({ kind: "unknown_dependency", taskId: t.id, dependsOn: d });
    }
  }
  // Détection de cycles par DFS tricolore ; le cycle est reconstruit pour être expliqué à l'utilisateur.
  const color = new Map<string, 0 | 1 | 2>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (id: string) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d) || d === id) continue;
      const c = color.get(d) ?? 0;
      if (c === 0) visit(d);
      else if (c === 1) {
        const cycle = stack.slice(stack.indexOf(d));
        const key = [...cycle].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({ kind: "cycle", taskIds: cycle });
        }
      }
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const t of tasks) if ((color.get(t.id) ?? 0) === 0) visit(t.id);
  return issues;
}

/** Deux périmètres se recouvrent si l'un est un préfixe de chemin de l'autre (`src` recouvre `src/api`). */
export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
  const within = (x: string, y: string) => x === y || y === "." || y === "" || x.startsWith(`${y}/`);
  return a.some((pa) => b.some((pb) => within(norm(pa), norm(pb)) || within(norm(pb), norm(pa))));
}

const ACTIVE: readonly TaskStatus[] = ["queued", "running", "waiting_input"];
const isTerminal = (s: TaskStatus) => TERMINAL_TASK_STATUSES.includes(s);

/** Échecs pour lesquels une nouvelle tentative a un sens ; les autres demandent une intervention. */
export const RETRYABLE_FAILURES: ReadonlySet<FailureCode | string> = new Set([
  "timeout",
  "network_error",
  "provider_error",
  "rate_limited",
  "stream_ended_without_result",
  "interrupted",
]);

export type ScheduleInput = {
  tasks: readonly DagTask[];
  maxParallel: number;
  /** false = budget épuisé : aucune nouvelle tâche (FR-024). */
  budgetAvailable: boolean;
  /** Refus de politique (permissions, sandbox indisponible…) avec raison. */
  isPermitted: (task: DagTask) => { ok: true } | { ok: false; reason: string };
};

export type ScheduleDecision = {
  start: string[];
  retry: string[];
  blocked: Array<{ taskId: string; reason: string }>;
  /** Plus rien ne peut progresser alors que des tâches restent non terminées. */
  deadlock: { stuck: string[]; causes: string[] } | null;
  done: boolean;
};

export function schedule(input: ScheduleInput): ScheduleDecision {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const decision: ScheduleDecision = { start: [], retry: [], blocked: [], deadlock: null, done: false };

  // Nouvelles tentatives : échecs réessayables sous le plafond de tentatives, et tâches interrompues par un redémarrage
  // de l'application (pas une erreur de l'agent : toujours reprises, une fois par redémarrage au plus).
  for (const t of input.tasks) {
    if (
      t.status === "interrupted" ||
      (t.status === "failed" &&
        t.attempt < t.maxAttempts &&
        t.lastFailureCode &&
        RETRYABLE_FAILURES.has(t.lastFailureCode))
    ) {
      decision.retry.push(t.id);
    }
  }

  const active = input.tasks.filter((t) => ACTIVE.includes(t.status));
  let slots = Math.max(0, input.maxParallel - active.length);
  const claimedPaths: Array<readonly string[]> = active.map((t) => t.allowedPaths);

  for (const t of input.tasks) {
    if (t.status !== "ready") continue;
    const deps = t.dependsOn.map((d) => byId.get(d));
    const pending = deps.filter((d) => d && d.status !== "completed");
    if (pending.length > 0) {
      const failedDep = pending.find((d) => d && (d.status === "failed" || d.status === "cancelled"));
      decision.blocked.push({
        taskId: t.id,
        reason: failedDep
          ? `dependency_${failedDep.status}:${failedDep.id}`
          : `waiting_for:${pending.map((d) => d!.id).join(",")}`,
      });
      continue;
    }
    if (!t.assignedAgentId) {
      decision.blocked.push({ taskId: t.id, reason: "unassigned" });
      continue;
    }
    if (!input.budgetAvailable) {
      decision.blocked.push({ taskId: t.id, reason: "budget_exhausted" });
      continue;
    }
    const permitted = input.isPermitted(t);
    if (!permitted.ok) {
      decision.blocked.push({ taskId: t.id, reason: `policy:${permitted.reason}` });
      continue;
    }
    if (claimedPaths.some((p) => pathsOverlap(p, t.allowedPaths))) {
      decision.blocked.push({ taskId: t.id, reason: "path_conflict" });
      continue;
    }
    if (slots === 0) {
      decision.blocked.push({ taskId: t.id, reason: "parallelism_limit" });
      continue;
    }
    decision.start.push(t.id);
    claimedPaths.push(t.allowedPaths);
    slots--;
  }

  const unfinished = input.tasks.filter((t) => !isTerminal(t.status));
  decision.done = unfinished.length === 0;
  const progressing =
    decision.start.length > 0 ||
    decision.retry.length > 0 ||
    input.tasks.some(
      (t) =>
        ACTIVE.includes(t.status) ||
        t.status === "waiting_review" ||
        t.status === "draft" ||
        t.status === "interrupted",
    );
  if (!decision.done && !progressing) {
    const transient = new Set(["parallelism_limit", "path_conflict", "budget_exhausted", "unassigned"]);
    const onlyTransient = decision.blocked.every((b) => transient.has(b.reason) || b.reason.startsWith("waiting_for:"));
    if (!onlyTransient || decision.blocked.length === 0) {
      decision.deadlock = {
        stuck: unfinished.map((t) => t.id),
        causes: [...new Set(decision.blocked.map((b) => b.reason))],
      };
    }
  }
  return decision;
}
