// Missions et tâches (FR-008, FR-010, FR-023, §10). Toutes les transitions passent par la machine d'états du
// contrat (`canTransition`) ; une transition invalide est refusée, jamais forcée.
import { randomUUID } from "node:crypto";
import { canTransition, type MissionSummary, type TaskStatus, type TaskSummary } from "@nexus/contracts";
import type { NewDomainEvent } from "@nexus/contracts";
import type { EventStore, Projector, Tx } from "@nexus/event-store";
import { validateDag, type DagTask } from "./dag.ts";
import { DomainError, domainEvent, type Actor, type Clock } from "./events.ts";

type MissionStatus = MissionSummary["status"];

export const missionsProjector: Projector = {
  name: "missions",
  async apply(tx, e) {
    const p = e.payload as Record<string, any>;
    if (e.aggregateType === "mission") {
      if (e.eventType === "mission.created") {
        await tx.mission.create({
          data: {
            id: e.aggregateId,
            projectId: p.projectId,
            teamId: p.teamId,
            title: p.title,
            prompt: p.prompt,
            status: "planning",
            createdAt: e.occurredAt,
            updatedAt: e.occurredAt,
            version: e.aggregateVersion,
          },
        });
      } else if (e.eventType === "mission.status_changed") {
        await tx.mission.update({
          where: { id: e.aggregateId },
          data: { status: p.to, updatedAt: e.occurredAt, version: e.aggregateVersion },
        });
      } else {
        await tx.mission.update({
          where: { id: e.aggregateId },
          data: { updatedAt: e.occurredAt, version: e.aggregateVersion },
        });
      }
      return;
    }
    if (e.aggregateType !== "task") return;
    switch (e.eventType) {
      case "task.created":
        await tx.task.create({
          data: {
            id: e.aggregateId,
            missionId: p.missionId,
            title: p.title,
            description: p.description,
            status: "draft",
            assignedAgentId: p.assignedAgentId ?? null,
            allowedPathsJson: JSON.stringify(p.allowedPaths),
            acceptanceJson: JSON.stringify(p.acceptance),
            maxAttempts: p.maxAttempts,
            planKey: p.planKey ?? null,
            createdAt: e.occurredAt,
            updatedAt: e.occurredAt,
            version: e.aggregateVersion,
          },
        });
        for (const dependsOnId of p.dependsOn as string[])
          await tx.taskDependency.create({ data: { taskId: e.aggregateId, dependsOnId } });
        return;
      case "task.assigned":
        await tx.task.update({
          where: { id: e.aggregateId },
          data: { assignedAgentId: p.agentId, updatedAt: e.occurredAt, version: e.aggregateVersion },
        });
        return;
      case "task.status_changed":
        await tx.task.update({
          where: { id: e.aggregateId },
          data: {
            status: p.to,
            ...(p.attempt !== undefined && { attempt: p.attempt }),
            ...(p.failureCode !== undefined && { lastFailureCode: p.failureCode }),
            updatedAt: e.occurredAt,
            version: e.aggregateVersion,
          },
        });
        return;
    }
  },
  async reset(tx) {
    await tx.taskDependency.deleteMany({});
    await tx.task.deleteMany({});
    await tx.mission.deleteMany({});
  },
};

export type NewTask = {
  /** Identifiant local au plan, pour exprimer des dépendances entre tâches créées dans le même lot. */
  key?: string;
  title: string;
  description: string;
  allowedPaths: string[];
  acceptance: string[];
  /** Identifiants de tâches existantes OU clés du lot courant. */
  dependsOn: string[];
  assignedAgentId?: string;
  maxAttempts?: number;
};

type TaskRow = {
  id: string;
  missionId: string;
  title: string;
  description: string;
  status: string;
  assignedAgentId: string | null;
  allowedPathsJson: string;
  acceptanceJson: string;
  attempt: number;
  maxAttempts: number;
  lastFailureCode: string | null;
  updatedAt: string;
  version: number;
};

export class MissionService {
  readonly #store: EventStore;
  readonly #clock: Clock;
  constructor(store: EventStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  async create(
    input: { projectId: string; teamId: string; title: string; prompt: string },
    actor: Actor,
  ): Promise<MissionSummary> {
    const team = await this.#store.prisma.team.findUnique({ where: { id: input.teamId } });
    if (!team || team.projectId !== input.projectId)
      throw new DomainError("invalid_request", "Équipe absente de ce projet");
    const missionId = randomUUID();
    await this.#store.append([
      domainEvent("mission", missionId, 1, "mission.created", { ...input }, { actor, clock: this.#clock }),
    ]);
    return this.get(missionId);
  }

  async get(missionId: string): Promise<MissionSummary> {
    const m = await this.#store.prisma.mission.findUnique({ where: { id: missionId } });
    if (!m) throw new DomainError("not_found", "Mission introuvable");
    return {
      missionId: m.id,
      projectId: m.projectId,
      teamId: m.teamId,
      title: m.title,
      prompt: m.prompt,
      status: m.status as MissionStatus,
      createdAt: m.createdAt,
    };
  }

  async setStatus(missionId: string, to: MissionStatus, actor: Actor, reason?: string): Promise<void> {
    const m = await this.#store.prisma.mission.findUnique({ where: { id: missionId } });
    if (!m) throw new DomainError("not_found", "Mission introuvable");
    if (m.status === to) return;
    await this.#store.append([
      domainEvent(
        "mission",
        missionId,
        m.version + 1,
        "mission.status_changed",
        { from: m.status, to, ...(reason && { reason }) },
        { actor, clock: this.#clock },
      ),
    ]);
  }

  /** Ajoute un lot de tâches après validation du DAG complet (tâches existantes + nouvelles). */
  async addTasks(missionId: string, tasks: NewTask[], actor: Actor): Promise<string[]> {
    const mission = await this.#store.prisma.mission.findUnique({ where: { id: missionId } });
    if (!mission) throw new DomainError("not_found", "Mission introuvable");
    if (["completed", "failed", "cancelled"].includes(mission.status))
      throw new DomainError("conflict", "Mission terminée");
    const existing = await this.listTasks(missionId);
    const ids = tasks.map(() => randomUUID());
    const keyToId = new Map<string, string>();
    tasks.forEach((t, i) => t.key && keyToId.set(t.key, ids[i]!));
    const resolved = tasks.map((t, i) => ({
      ...t,
      id: ids[i]!,
      dependsOn: t.dependsOn.map((d) => keyToId.get(d) ?? d),
    }));
    const issues = validateDag([...existing.map((t) => ({ id: t.taskId, dependsOn: t.dependsOn })), ...resolved]);
    if (issues.length) throw new DomainError("invalid_request", `DAG invalide : ${JSON.stringify(issues)}`);
    const members = new Set(
      (await this.#store.prisma.agentProfile.findMany({ where: { teamId: mission.teamId }, select: { id: true } })).map(
        (a) => a.id,
      ),
    );
    for (const t of resolved) {
      if (t.assignedAgentId && !members.has(t.assignedAgentId))
        throw new DomainError("invalid_request", "Agent assigné hors de l'équipe de la mission");
      if (t.allowedPaths.some((p) => p.startsWith("/") || p.split(/[\\/]/).includes(".."))) {
        throw new DomainError("invalid_request", "Chemins de tâche relatifs au projet uniquement, sans traversée");
      }
    }
    await this.#store.append(
      resolved.map((t) =>
        domainEvent(
          "task",
          t.id,
          1,
          "task.created",
          {
            missionId,
            title: t.title,
            description: t.description,
            allowedPaths: t.allowedPaths,
            acceptance: t.acceptance,
            dependsOn: t.dependsOn,
            maxAttempts: t.maxAttempts ?? 2,
            ...(t.key && { planKey: t.key }),
            ...(t.assignedAgentId && { assignedAgentId: t.assignedAgentId }),
          },
          { actor, clock: this.#clock },
        ),
      ),
    );
    return ids;
  }

  async assign(taskId: string, agentId: string, actor: Actor): Promise<void> {
    const task = await this.#row(taskId);
    const mission = await this.#store.prisma.mission.findUnique({ where: { id: task.missionId } });
    const agent = await this.#store.prisma.agentProfile.findUnique({ where: { id: agentId } });
    if (!agent || agent.teamId !== mission?.teamId)
      throw new DomainError("invalid_request", "Agent hors de l'équipe de la mission");
    if (!["draft", "ready", "interrupted", "failed"].includes(task.status))
      throw new DomainError("conflict", `Réaffectation impossible en état ${task.status}`);
    await this.#store.append([
      domainEvent("task", taskId, task.version + 1, "task.assigned", { agentId }, { actor, clock: this.#clock }),
    ]);
  }

  /**
   * Transition validée. `extra(tx)` écrit des données liées dans la même transaction (ex. enregistrement de run).
   */
  async transition(
    taskId: string,
    to: TaskStatus,
    actor: Actor,
    details: { failureCode?: string; reason?: string; attempt?: number } = {},
    extra?: (tx: Tx) => Promise<void>,
  ): Promise<void> {
    await this.#store.append(
      [await this.transitionEvent(taskId, to, actor, details)],
      extra ? (tx) => extra(tx) : undefined,
    );
  }

  /** Construit (sans l'écrire) l'événement d'une transition validée, pour l'ajouter à un lot atomique. */
  async transitionEvent(
    taskId: string,
    to: TaskStatus,
    actor: Actor,
    details: { failureCode?: string; reason?: string; attempt?: number } = {},
  ): Promise<NewDomainEvent> {
    const task = await this.#row(taskId);
    const from = task.status as TaskStatus;
    if (!canTransition(from, to)) throw new DomainError("conflict", `Transition interdite ${from} -> ${to}`);
    return domainEvent(
      "task",
      taskId,
      task.version + 1,
      "task.status_changed",
      { from, to, ...details },
      { actor, clock: this.#clock },
    );
  }

  async #row(taskId: string): Promise<TaskRow> {
    const t = await this.#store.prisma.task.findUnique({ where: { id: taskId } });
    if (!t) throw new DomainError("not_found", "Tâche introuvable");
    return t;
  }

  async getTask(taskId: string): Promise<TaskSummary> {
    const t = await this.#row(taskId);
    const deps = await this.#store.prisma.taskDependency.findMany({ where: { taskId } });
    return toTaskSummary(
      t,
      deps.map((d) => d.dependsOnId),
    );
  }

  async listTasks(missionId: string): Promise<TaskSummary[]> {
    const rows = await this.#store.prisma.task.findMany({ where: { missionId }, orderBy: { createdAt: "asc" } });
    const deps = await this.#store.prisma.taskDependency.findMany({ where: { taskId: { in: rows.map((r) => r.id) } } });
    return rows.map((r) =>
      toTaskSummary(
        r,
        deps.filter((d) => d.taskId === r.id).map((d) => d.dependsOnId),
      ),
    );
  }

  /** Vue DAG pour l'ordonnanceur. */
  async dagTasks(missionId: string): Promise<DagTask[]> {
    const tasks = await this.listTasks(missionId);
    const rows = await this.#store.prisma.task.findMany({
      where: { missionId },
      select: { id: true, maxAttempts: true },
    });
    const max = new Map(rows.map((r) => [r.id, r.maxAttempts]));
    return tasks.map((t) => ({
      id: t.taskId,
      status: t.status,
      dependsOn: t.dependsOn,
      allowedPaths: t.allowedPaths,
      attempt: t.attempt,
      maxAttempts: max.get(t.taskId) ?? 2,
      lastFailureCode: t.lastFailureCode,
      assignedAgentId: t.assignedAgentId,
    }));
  }
}

function toTaskSummary(t: TaskRow, dependsOn: string[]): TaskSummary {
  return {
    taskId: t.id,
    missionId: t.missionId,
    title: t.title,
    description: t.description,
    status: t.status as TaskStatus,
    ...(t.assignedAgentId && { assignedAgentId: t.assignedAgentId }),
    allowedPaths: JSON.parse(t.allowedPathsJson) as string[],
    acceptance: JSON.parse(t.acceptanceJson) as string[],
    dependsOn,
    attempt: t.attempt,
    ...(t.lastFailureCode && { lastFailureCode: t.lastFailureCode }),
    updatedAt: t.updatedAt,
  };
}
