// Exécution des tâches par les connecteurs, persistance des événements d'agent, annulation, reprise (T-009).
// Règles (UC-05, §11) : un événement est persisté AVANT tout signal UI ; jamais d'état `running` sans processus
// actif vérifié ; reprise native si le connecteur la supporte, sinon contexte reconstruit et signalé comme tel.
import { randomUUID } from "node:crypto";
import type { AgentConnector, AgentEvent, AgentTaskRequest, NewDomainEvent, PermissionMode } from "@nexus/contracts";
import type { EventStore, Projector } from "@nexus/event-store";
import { DomainError, domainEvent, SYSTEM, type Actor, type Clock } from "./events.ts";
import type { MissionService } from "./missions.ts";
import { evaluatePolicy } from "./policy.ts";

type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ResumeMode = "fresh" | "native-resume" | "reconstructed";

export const runsProjector: Projector = {
  name: "agent_runs",
  async apply(tx, e) {
    if (e.aggregateType !== "agent_run") return;
    const p = e.payload as Record<string, any>;
    if (e.eventType === "run.started") {
      await tx.agentRun.create({
        data: {
          id: e.aggregateId,
          taskId: p.taskId,
          sessionId: p.sessionId,
          connectorId: p.connectorId,
          connectorVersion: p.connectorVersion ?? null,
          nativeSessionId: p.nativeSessionId ?? null,
          runnerInstanceId: p.runnerInstanceId,
          status: "running",
          startedAt: e.occurredAt,
        },
      });
    } else if (e.eventType === "run.event") {
      const ev = p.event as AgentEvent;
      await tx.agentRun.update({
        where: { id: e.aggregateId },
        data: {
          lastSequence: ev.sequence,
          ...((ev.kind === "started" || ev.kind === "completed") &&
            ev.nativeSessionId && { nativeSessionId: ev.nativeSessionId }),
        },
      });
      // Quota signalé par le CLI : instantané consultable dans la vue Consommation.
      if (ev.kind === "quota") {
        const run = await tx.agentRun.findUnique({ where: { id: e.aggregateId } });
        const consumed = ev.utilization !== undefined ? Math.round(ev.utilization * 1000) / 10 : undefined;
        await tx.usageSnapshot.create({
          data: {
            id: `${e.aggregateId}:${ev.sequence}`,
            connectorId: run?.connectorId ?? "inconnu",
            observedAt: e.occurredAt,
            source: "cli",
            consumed: consumed ?? null,
            remaining: consumed !== undefined ? Math.max(0, 100 - consumed) : null,
            unit: consumed !== undefined ? "percent" : null,
            windowEnd: ev.resetsAt ?? null,
            caveat: `Statut ${ev.status}${ev.window ? ` · fenêtre ${ev.window}` : ""} (signalé par le CLI)`,
          },
        });
      }
    } else if (e.eventType === "run.finished") {
      await tx.agentRun.update({ where: { id: e.aggregateId }, data: { status: p.status, endedAt: e.occurredAt } });
    }
  },
  async reset(tx) {
    await tx.agentRun.deleteMany({});
    await tx.usageSnapshot.deleteMany({ where: { source: "cli" } });
  },
};

export type ExecutionEnvironment = {
  /** Connecteur à utiliser pour un profil d'agent. */
  connectorFor(connectorId: string): AgentConnector | undefined;
  /** Dossier de travail de la tâche (worktree isolé, T-016). */
  workspaceFor(taskId: string): Promise<string>;
  /** Isolation OS vérifiée au démarrage (ADR-001). */
  sandboxAvailable: boolean;
  defaultTimeoutMs?: number;
  /** Les tâches terminées passent en revue humaine avant `completed` (par défaut : oui, pas de merge silencieux). */
  requireReview?: boolean;
  /** Serveurs MCP à fournir à l'agent pour cette tâche (messagerie de l'Orchestre). */
  mcpFor?: (taskId: string, connectorId: string) => AgentTaskRequest["mcpServers"];
};

type ActiveRun = { abort: AbortController; missionId: string };

/** Délai maximal de regroupement des lignes de sortie en une seule transaction. */
const OUTPUT_FLUSH_MS = 100;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || "erreur";

/** Code d'échec (non réessayable) d'une tâche qui n'a pas pu démarrer. */
function preparationFailureCode(e: unknown): string {
  const code = e instanceof DomainError ? e.code : undefined;
  if (code === "unavailable") return "connector_unavailable";
  if (code === "not_found") return "agent_not_found";
  if (code === "policy_denied") return "policy_denied";
  if (code === "invalid_request") return "invalid_task";
  return "preparation_failed";
}

export type RunOutcome = { runId: string; status: RunStatus; failureCode?: string; resumeMode: ResumeMode };

export class RunService {
  readonly #store: EventStore;
  readonly #clock: Clock;
  readonly #missions: MissionService;
  readonly #env: ExecutionEnvironment;
  /** Identifie ce processus : un run `running` d'une autre instance est forcément interrompu. */
  readonly runnerInstanceId = randomUUID();
  readonly #active = new Map<string, ActiveRun>();

  constructor(store: EventStore, clock: Clock, missions: MissionService, env: ExecutionEnvironment) {
    this.#store = store;
    this.#clock = clock;
    this.#missions = missions;
    this.#env = env;
  }

  isActive(taskId: string): boolean {
    return this.#active.has(taskId);
  }

  /**
   * Réparation au démarrage (UC-05) : tout run `running` qui n'appartient pas à cette instance est interrompu,
   * ainsi que sa tâche. À appeler avant d'accepter de nouvelles exécutions.
   */
  async recoverInterrupted(): Promise<string[]> {
    const stale = await this.#store.prisma.agentRun.findMany({
      where: { status: "running", NOT: { runnerInstanceId: this.runnerInstanceId } },
    });
    const tasks: string[] = [];
    for (const run of stale) {
      const v = await this.#store.currentVersion(run.id);
      await this.#store.append([
        domainEvent(
          "agent_run",
          run.id,
          v + 1,
          "run.finished",
          { status: "interrupted", reason: "runner_not_alive" },
          { actor: SYSTEM, clock: this.#clock },
        ),
      ]);
      const task = await this.#store.prisma.task.findUnique({ where: { id: run.taskId } });
      if (task && ["running", "queued", "waiting_input"].includes(task.status)) {
        await this.#missions.transition(run.taskId, "interrupted", SYSTEM, { reason: "app_restarted" });
        tasks.push(run.taskId);
      }
    }
    // Tâches restées `running`/`queued` sans aucun run vivant (ex. crash entre deux écritures).
    const orphans = await this.#store.prisma.task.findMany({ where: { status: { in: ["running", "queued"] } } });
    for (const t of orphans) {
      if (tasks.includes(t.id) || this.#active.has(t.id)) continue;
      await this.#missions.transition(t.id, "interrupted", SYSTEM, { reason: "no_live_runner" });
      tasks.push(t.id);
    }
    return tasks;
  }

  /** Exécute une tâche jusqu'à son terme (ou annulation). Retourne l'issue du run. */
  /**
   * `prompt` : consigne de relance (session de suivi). Avec `resume`, la session native du CLI est reprise si possible,
   * et la nouvelle consigne lui est envoyée telle quelle.
   */
  /**
   * `forceReview` : la tâche passe en revue (`waiting_review`) même en mode autonome — utilisé par le chef d'orchestre,
   * qui relit chaque résultat avant de débloquer les tâches suivantes.
   *
   * Une tâche qui ne peut pas démarrer (connecteur indisponible, agent introuvable, politique refusée, dossier de
   * travail impossible…) passe en `failed` avec un code non réessayable et la raison : elle ne reste jamais `ready` ou
   * `queued` (sinon l'ordonnanceur la relancerait en boucle).
   */
  async execute(
    taskId: string,
    actor: Actor,
    opts: { resume?: boolean; prompt?: string; forceReview?: boolean } = {},
  ): Promise<RunOutcome> {
    if (this.#active.has(taskId)) throw new DomainError("conflict", "Tâche déjà en cours d'exécution");
    // Réservation immédiate : deux appels concurrents ne peuvent pas lancer la même tâche.
    const active: ActiveRun = { abort: new AbortController(), missionId: "" };
    this.#active.set(taskId, active);
    try {
      return await this.#execute(taskId, actor, opts, active);
    } finally {
      this.#active.delete(taskId);
    }
  }

  async #execute(
    taskId: string,
    actor: Actor,
    opts: { resume?: boolean; prompt?: string; forceReview?: boolean },
    active: ActiveRun,
  ): Promise<RunOutcome> {
    const task = await this.#missions.getTask(taskId);
    active.missionId = task.missionId;
    const ac = active.abort;
    let agent: NonNullable<Awaited<ReturnType<EventStore["prisma"]["agentProfile"]["findUnique"]>>>;
    let connector: AgentConnector;
    let mode: PermissionMode;
    try {
      if (!task.assignedAgentId) throw new DomainError("invalid_request", "Tâche non assignée");
      const found = await this.#store.prisma.agentProfile.findUnique({ where: { id: task.assignedAgentId } });
      if (!found) throw new DomainError("not_found", "Agent introuvable");
      agent = found;
      const c = this.#env.connectorFor(agent.connectorId);
      if (!c) throw new DomainError("unavailable", `Connecteur ${agent.connectorId} indisponible`);
      connector = c;
      mode = agent.permissionMode as PermissionMode;
      const decision = evaluatePolicy("command_exec", {
        mode,
        sandboxAvailable: this.#env.sandboxAvailable,
        authMode: agent.authMode as "vendor-login" | "api-key" | "local-none",
      });
      if (decision.effect === "deny") throw new DomainError("policy_denied", decision.rule);
    } catch (e) {
      await this.failTask(taskId, preparationFailureCode(e), errorMessage(e));
      throw e;
    }

    // Préparation : la tâche passe par `queued` puis `running` (transitions validées par le contrat).
    let status = task.status;
    if (status === "draft") {
      await this.#missions.transition(taskId, "ready", actor);
      status = "ready";
    }
    if (["ready", "interrupted", "failed", "waiting_review", "completed", "cancelled"].includes(status)) {
      await this.#missions.transition(taskId, "queued", actor, opts.resume ? { reason: "resume" } : {});
    } else if (status !== "queued") {
      throw new DomainError("conflict", `Exécution impossible depuis l'état ${status}`);
    }

    // Tout échec entre `queued` et le lancement remet la tâche en `failed` (jamais bloquée en file).
    let req: AgentTaskRequest;
    let session: string;
    let resumeMode: ResumeMode;
    let canNative: boolean;
    let previous: { nativeSessionId: string | null; connectorId: string } | null;
    try {
      const mission = await this.#missions.get(task.missionId);
      previous = opts.resume
        ? await this.#store.prisma.agentRun.findFirst({ where: { taskId }, orderBy: { startedAt: "desc" } })
        : null;
      canNative = Boolean(
        opts.resume && previous?.nativeSessionId && connector.resume && previous.connectorId === agent.connectorId,
      );
      resumeMode = !opts.resume ? "fresh" : canNative ? "native-resume" : "reconstructed";
      session = await this.#sessionFor(mission.projectId, agent.id);

      let prompt = opts.prompt ?? buildTaskPrompt(task.title, task.description, task.acceptance, task.allowedPaths);
      if (resumeMode === "reconstructed") prompt = `${await this.#reconstructedContext(taskId)}\n\n${prompt}`;

      req = {
        taskId,
        projectId: mission.projectId,
        sessionId: session,
        agentProfileId: agent.id,
        workspacePath: await this.#env.workspaceFor(taskId),
        prompt,
        contextRefs: [],
        permissionsPolicyId: mode,
        timeoutMs: this.#env.defaultTimeoutMs ?? 30 * 60_000,
      };
      const mcp = this.#env.mcpFor?.(taskId, agent.connectorId);
      if (mcp?.length) req.mcpServers = mcp;
    } catch (e) {
      await this.failTask(taskId, "preparation_failed", errorMessage(e));
      throw e;
    }

    const runId = randomUUID();
    const attempt = task.attempt + 1;
    let version = 1;
    let started = false;
    let finished = false;
    // Sorties regroupées (≤ OUTPUT_FLUSH_MS) en une seule transaction ; tout autre événement est écrit aussitôt.
    let pending: NewDomainEvent[] = [];
    let writes: Promise<unknown> = Promise.resolve();
    let writeError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): Promise<unknown> => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (pending.length) {
        const batch = pending;
        pending = [];
        writes = writes.then(() => this.#store.append(batch));
        // Écriture impossible : le CLI est arrêté au plus vite (aucune sortie ne doit être perdue en silence).
        writes.catch((e: unknown) => {
          writeError ??= e;
          ac.abort();
        });
      }
      return writes;
    };
    try {
      // Passage en `running` et création du run dans le MÊME lot atomique : jamais l'un sans l'autre.
      await this.#store.append([
        await this.#missions.transitionEvent(taskId, "running", actor, { attempt }),
        domainEvent(
          "agent_run",
          runId,
          1,
          "run.started",
          {
            taskId,
            sessionId: session,
            connectorId: agent.connectorId,
            connectorVersion: connector.manifest.version,
            runnerInstanceId: this.runnerInstanceId,
            resumeMode,
            ...(resumeMode === "reconstructed" && {
              warning: "Contexte reconstruit : les actions non idempotentes déjà effectuées peuvent être rejouées",
            }),
            ...(canNative && previous?.nativeSessionId && { nativeSessionId: previous.nativeSessionId }),
          },
          { actor, clock: this.#clock },
        ),
      ]);
      started = true;

      const stream = canNative
        ? connector.resume!(previous!.nativeSessionId!, req, ac.signal)
        : connector.start(req, ac.signal);
      let terminal: AgentEvent | undefined;
      for await (const ev of stream) {
        if (writeError) throw writeError;
        version++;
        pending.push(
          domainEvent(
            "agent_run",
            runId,
            version,
            "run.event",
            { event: ev },
            { actor: { actorType: "agent", actorId: agent.id }, clock: this.#clock },
          ),
        );
        if (ev.kind !== "output" || pending.length >= 64) await flush();
        else timer ??= setTimeout(() => void flush(), OUTPUT_FLUSH_MS);
        if (ev.kind === "completed" || ev.kind === "failed") terminal = ev;
      }
      await flush();
      const status: RunStatus =
        terminal?.kind === "completed"
          ? "completed"
          : terminal?.kind === "failed" && terminal.code === "cancelled"
            ? "cancelled"
            : "failed";
      const failureCode =
        terminal?.kind === "failed" ? terminal.code : terminal ? undefined : "stream_ended_without_result";
      await this.#store.append([
        domainEvent(
          "agent_run",
          runId,
          version + 1,
          "run.finished",
          { status, ...(failureCode && { failureCode }) },
          { actor: SYSTEM, clock: this.#clock },
        ),
      ]);
      finished = true;

      if (status === "completed") {
        await this.#missions.transition(
          taskId,
          // Mode autonome (choix du propriétaire) : l'agent a travaillé directement dans le projet, pas d'étape de revue.
          !opts.forceReview && (this.#env.requireReview === false || mode === "autonomous")
            ? "completed"
            : "waiting_review",
          SYSTEM,
        );
      } else if (status === "cancelled") {
        if ((await this.#missions.getTask(taskId)).status !== "cancelled")
          await this.#missions.transition(taskId, "cancelled", SYSTEM, { reason: "cancelled" });
      } else {
        await this.#missions.transition(taskId, "failed", SYSTEM, { failureCode: failureCode ?? "cli_reported_error" });
      }
      return { runId, status, ...(failureCode && { failureCode }), resumeMode };
    } catch (e) {
      // Journal indisponible ou erreur interne : le CLI est arrêté, le run et la tâche sont clos (au mieux).
      if (timer) clearTimeout(timer);
      ac.abort();
      if (started && !finished) {
        try {
          const v = await this.#store.currentVersion(runId);
          await this.#store.append([
            domainEvent(
              "agent_run",
              runId,
              v + 1,
              "run.finished",
              { status: "failed", failureCode: "internal_error" },
              { actor: SYSTEM, clock: this.#clock },
            ),
          ]);
        } catch {
          /* au mieux : la réparation au démarrage clora ce run */
        }
      }
      await this.failTask(taskId, "internal_error", errorMessage(e)).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Met en échec (code non réessayable + raison) une tâche qui n'a pas pu démarrer ou dont l'exécution a été
   * interrompue par une erreur interne. Sans effet sur une tâche terminée, en revue ou déjà annulée.
   */
  async failTask(taskId: string, failureCode: string, reason: string): Promise<boolean> {
    try {
      const status = (await this.#missions.getTask(taskId)).status;
      const details = { failureCode, reason: reason.slice(0, 500) };
      if (status === "queued" || status === "running" || status === "waiting_input") {
        await this.#missions.transition(taskId, "failed", SYSTEM, details);
      } else if (status === "ready" || status === "interrupted" || status === "failed") {
        await this.#missions.transition(taskId, "queued", SYSTEM, { reason: "preparation" });
        await this.#missions.transition(taskId, "failed", SYSTEM, details);
      } else return false;
      return true;
    } catch {
      return false;
    }
  }

  /** Annule une tâche en cours (le connecteur reçoit l'AbortSignal ; le processus est tué par sa frontière). */
  cancel(taskId: string): boolean {
    const a = this.#active.get(taskId);
    if (!a) return false;
    a.abort.abort();
    return true;
  }

  /** Annule les seules exécutions d'une mission (arrêt d'un orchestre) ; les autres missions continuent. */
  cancelMission(missionId: string): string[] {
    const ids: string[] = [];
    for (const [taskId, a] of this.#active) {
      if (a.missionId !== missionId) continue;
      a.abort.abort();
      ids.push(taskId);
    }
    return ids;
  }

  /** Arrêt d'urgence global (FR-023) : annule toutes les exécutions de cette instance. Action explicite uniquement. */
  emergencyStop(): string[] {
    const ids = [...this.#active.keys()];
    for (const a of this.#active.values()) a.abort.abort();
    return ids;
  }

  async #sessionFor(projectId: string, agentProfileId: string): Promise<string> {
    const existing = await this.#store.prisma.session.findFirst({ where: { projectId, agentProfileId } });
    if (existing) return existing.id;
    const id = randomUUID();
    await this.#store.prisma.session.create({
      data: { id, projectId, agentProfileId, title: "Session", createdAt: this.#clock(), updatedAt: this.#clock() },
    });
    return id;
  }

  /** Contexte reconstruit à partir des dernières sorties journalisées (borné, signalé comme tel). */
  async #reconstructedContext(taskId: string): Promise<string> {
    const runs = await this.#store.prisma.agentRun.findMany({
      where: { taskId },
      orderBy: { startedAt: "asc" },
      select: { id: true },
    });
    const outputs: string[] = [];
    for (const r of runs) {
      for (const e of await this.#store.loadAggregate(r.id)) {
        const ev = (e.payload as { event?: AgentEvent }).event;
        // Messages structurés (Claude, Codex) et sortie texte des CLI génériques (canal stdout).
        if (ev?.kind === "output" && ev.channel !== "stderr") outputs.push(ev.text);
      }
    }
    const tail = outputs.join("\n").slice(-4000);
    return [
      "[CONTEXTE RECONSTRUIT PAR NEXUS — la session précédente n'a pas pu être reprise nativement]",
      "Vérifie l'état actuel des fichiers avant d'agir : des actions ont peut-être déjà été effectuées.",
      tail ? `Dernières sorties de l'agent :\n${tail}` : "Aucune sortie précédente enregistrée.",
    ].join("\n");
  }
}

/** Contexte déterministe d'une tâche (§10) : objectif, critères, fichiers autorisés. */
export function buildTaskPrompt(
  title: string,
  description: string,
  acceptance: readonly string[],
  allowedPaths: readonly string[],
): string {
  return [
    `# Tâche : ${title}`,
    description,
    "## Critères d'acceptation",
    ...acceptance.map((a) => `- ${a}`),
    "## Chemins autorisés en écriture (relatifs au dossier de travail)",
    ...allowedPaths.map((p) => `- ${p}`),
    "N'écris pas en dehors de ces chemins. N'essaie pas de lire de secrets, de clés ni de fichiers d'authentification.",
  ].join("\n");
}
