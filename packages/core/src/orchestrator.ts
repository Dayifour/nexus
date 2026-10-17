// Orchestrateur de mission (UC-02, UC-03, FR-009, FR-010) : plan -> validation -> approbation -> exécution du DAG.
import { randomUUID } from "node:crypto";
import type {
  AgentConnector,
  AgentEvent,
  Capability,
  GovernanceMode,
  MissionPlan,
  PermissionMode,
} from "@nexus/contracts";
import type { EventStore } from "@nexus/event-store";
import { schedule, type ScheduleDecision } from "./dag.ts";
import { DomainError, domainEvent, SYSTEM, type Actor, type Clock } from "./events.ts";
import type { MissionService } from "./missions.ts";
import { planFingerprint } from "./policy.ts";
import {
  extractJsonObject,
  planNeedsHumanApproval,
  routeTasks,
  validatePlan,
  type PlanValidation,
  type RoutableAgent,
  type RoutingDecision,
} from "./planning.ts";
import type { RunService } from "./runs.ts";

export type PlanProposal = {
  validation: PlanValidation;
  routing: RoutingDecision[];
  fingerprint?: string;
  needsApproval: boolean;
  rawText: string;
};

const PLANNING_INSTRUCTIONS = `Tu es le superviseur d'une équipe d'agents de développement. Découpe la mission en tâches.
Réponds UNIQUEMENT par un objet JSON conforme à ce schéma (aucun texte hors JSON n'est requis) :
{"schemaVersion":1,"summary":"...","tasks":[{"key":"kebab-case","title":"...","description":"...",
"allowedPaths":["chemins/relatifs"],"dependsOn":["clé"],"acceptance":["critère vérifiable"],
"requiredCapabilities":["edit"],"suggestedRole":"Backend","risk":"low|medium|high"}]}
Règles : chemins relatifs au projet sans "..", tâches parallélisables sur des chemins disjoints, critères testables.`;

export class MissionOrchestrator {
  readonly #store: EventStore;
  readonly #clock: Clock;
  readonly #missions: MissionService;
  readonly #runs: RunService;
  readonly #connectorFor: (id: string) => AgentConnector | undefined;
  readonly #proposals = new Map<string, PlanProposal>();

  constructor(
    store: EventStore,
    clock: Clock,
    missions: MissionService,
    runs: RunService,
    connectorFor: (id: string) => AgentConnector | undefined,
  ) {
    this.#store = store;
    this.#clock = clock;
    this.#missions = missions;
    this.#runs = runs;
    this.#connectorFor = connectorFor;
  }

  async #team(missionId: string) {
    const mission = await this.#missions.get(missionId);
    const team = await this.#store.prisma.team.findUnique({
      where: { id: mission.teamId },
      include: { members: true },
    });
    if (!team) throw new DomainError("not_found", "Équipe introuvable");
    return { mission, team };
  }

  async routableAgents(missionId: string): Promise<RoutableAgent[]> {
    const { team } = await this.#team(missionId);
    return team.members.map((m) => ({
      agentId: m.id,
      role: m.role,
      connectorId: m.connectorId,
      capabilities: JSON.parse(m.capabilitiesJson) as Capability[],
      permissionMode: m.permissionMode as PermissionMode,
      available: Boolean(this.#connectorFor(m.connectorId)),
    }));
  }

  /**
   * Analyse un plan (fourni par l'humain ou extrait de la réponse du superviseur). Le plan est journalisé avec son
   * empreinte ; selon la gouvernance il attend l'approbation humaine (`awaiting_plan_approval`).
   */
  async proposePlan(
    missionId: string,
    rawPlanOrText: unknown,
    actor: Actor,
    overrides: Record<string, string> = {},
  ): Promise<PlanProposal> {
    const { mission, team } = await this.#team(missionId);
    const rawText = typeof rawPlanOrText === "string" ? rawPlanOrText : JSON.stringify(rawPlanOrText);
    const raw = typeof rawPlanOrText === "string" ? extractJsonObject(rawPlanOrText) : rawPlanOrText;
    const agents = await this.routableAgents(missionId);
    const validation = validatePlan(raw, agents);
    const routing = validation.plan ? routeTasks(validation.plan.tasks, agents, overrides) : [];
    const unrouted = routing.filter((r) => !r.agentId).map((r) => r.taskKey);
    if (unrouted.length) {
      validation.valid = false;
      validation.checks.push({ rule: "routing", ok: false, detail: `tâches sans agent : ${unrouted.join(", ")}` });
    }
    const needsApproval = validation.plan
      ? planNeedsHumanApproval(team.governanceMode as GovernanceMode, validation.plan)
      : true;
    const proposal: PlanProposal = {
      validation,
      routing,
      needsApproval,
      rawText: rawText.slice(0, 20_000),
      ...(validation.valid && validation.plan && { fingerprint: planFingerprint({ plan: validation.plan, routing }) }),
    };
    const m = await this.#store.prisma.mission.findUnique({ where: { id: missionId } });
    await this.#store.append([
      domainEvent(
        "mission",
        missionId,
        m!.version + 1,
        "mission.plan_proposed",
        {
          valid: validation.valid,
          checks: validation.checks,
          routing,
          needsApproval,
          ...(proposal.fingerprint && { fingerprint: proposal.fingerprint }),
        },
        { actor, clock: this.#clock },
      ),
    ]);
    this.#proposals.set(missionId, proposal);
    if (validation.valid) {
      if (needsApproval) await this.#missions.setStatus(mission.missionId, "awaiting_plan_approval", SYSTEM);
      else await this.acceptPlan(missionId, proposal.fingerprint!, SYSTEM);
    }
    return proposal;
  }

  /** Demande un plan au superviseur IA de l'équipe (lecture seule), puis le soumet à `proposePlan`. */
  async planWithSupervisor(
    missionId: string,
    workspacePath: string,
    actor: Actor,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PlanProposal> {
    const { mission, team } = await this.#team(missionId);
    if (team.governanceMode === "MANUAL" || !team.supervisorId)
      throw new DomainError("invalid_request", "Aucun superviseur IA désigné pour cette équipe");
    const sup = team.members.find((m) => m.id === team.supervisorId);
    const connector = sup && this.#connectorFor(sup.connectorId);
    if (!sup || !connector) throw new DomainError("unavailable", "Connecteur du superviseur indisponible");
    const taskId = randomUUID();
    let text = "";
    let failure: AgentEvent | undefined;
    for await (const ev of connector.start(
      {
        taskId,
        projectId: mission.projectId,
        sessionId: randomUUID(),
        agentProfileId: sup.id,
        workspacePath,
        prompt: `${PLANNING_INSTRUCTIONS}\n\n# Mission\n${mission.prompt}`,
        contextRefs: [],
        // Planification : aucune écriture.
        permissionsPolicyId: "read-only",
        timeoutMs: 10 * 60_000,
      },
      signal,
    )) {
      // Messages structurés (Claude, Codex) ou sortie texte (CLI génériques : Hermes, OpenCode…).
      if (ev.kind === "output" && ev.channel !== "stderr") text += `${ev.text}\n`;
      if (ev.kind === "failed") failure = ev;
    }
    if (failure?.kind === "failed")
      throw new DomainError("unavailable", `Le superviseur n'a pas produit de plan (${failure.code})`);
    return this.proposePlan(missionId, text, actor);
  }

  /** Accepte le plan exact proposé (empreinte) : crée les tâches assignées. Humain requis si la gouvernance l'exige. */
  async acceptPlan(missionId: string, fingerprint: string, actor: Actor): Promise<string[]> {
    const proposal = this.#proposals.get(missionId);
    if (!proposal?.validation.valid || !proposal.validation.plan)
      throw new DomainError("conflict", "Aucun plan valide en attente");
    if (proposal.fingerprint !== fingerprint)
      throw new DomainError("policy_denied", "Le plan a changé depuis sa présentation");
    if (proposal.needsApproval && actor.actorType !== "user")
      throw new DomainError("policy_denied", "Ce plan doit être approuvé par l'utilisateur");
    const plan: MissionPlan = proposal.validation.plan;
    const agentOf = new Map(proposal.routing.map((r) => [r.taskKey, r.agentId]));
    const ids = await this.#missions.addTasks(
      missionId,
      plan.tasks.map((t) => ({
        key: t.key,
        title: t.title,
        description: t.description,
        allowedPaths: t.allowedPaths,
        acceptance: t.acceptance,
        dependsOn: t.dependsOn,
        ...(agentOf.get(t.key) && { assignedAgentId: agentOf.get(t.key)! }),
      })),
      actor,
    );
    for (const id of ids) await this.#missions.transition(id, "ready", actor);
    await this.#missions.setStatus(missionId, "active", actor);
    this.#proposals.delete(missionId);
    return ids;
  }

  /**
   * Exécute le DAG : démarre les tâches prêtes (parallélisme borné, chemins disjoints), relance les échecs
   * réessayables, et s'arrête quand tout est terminé ou qu'un blocage définitif est détecté (expliqué).
   */
  async runMission(
    missionId: string,
    actor: Actor,
    opts: {
      maxParallel?: number;
      budgetAvailable?: () => boolean;
      signal?: AbortSignal;
      /** Consigne complète d'une tâche (contexte de l'équipe, travail des dépendances…) au lieu de la consigne par défaut. */
      promptFor?: (taskId: string) => Promise<string>;
      /** Chaque résultat passe en revue avant de débloquer la suite (chef d'orchestre). */
      forceReview?: boolean;
      /** Tâche qui n'a pas pu démarrer (déjà mise en échec avec sa raison) : pour l'afficher. */
      onTaskError?: (taskId: string, error: Error) => void;
    } = {},
  ): Promise<ScheduleDecision> {
    const running = new Map<string, Promise<unknown>>();
    // Garde-fou : une tâche qui n'a pas pu démarrer n'est pas relancée dans ce même passage (jamais de boucle chaude).
    const errored = new Set<string>();
    // L'arrêt réveille la boucle aussitôt (sans attendre la fin d'une tâche en cours).
    const stopped = new Promise<void>((resolve) =>
      opts.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    for (;;) {
      if (opts.signal?.aborted) {
        // Seules les exécutions de CETTE mission sont annulées (les autres orchestres continuent).
        this.#runs.cancelMission(missionId);
        await Promise.allSettled(running.values());
        return { start: [], retry: [], blocked: [], deadlock: null, done: false };
      }
      const tasks = await this.#missions.dagTasks(missionId);
      const decision = schedule({
        tasks,
        maxParallel: opts.maxParallel ?? 2,
        budgetAvailable: opts.budgetAvailable?.() ?? true,
        isPermitted: () => ({ ok: true }),
      });
      const statusOf = new Map(tasks.map((t) => [t.id, t.status]));
      for (const id of [...decision.retry, ...decision.start]) {
        if (running.has(id) || errored.has(id) || this.#runs.isActive(id)) continue;
        // Tâche interrompue (redémarrage) : reprise de la session native si possible.
        const resume = statusOf.get(id) === "interrupted";
        const p = (opts.promptFor ? opts.promptFor(id) : Promise.resolve(undefined))
          .then(
            (prompt) =>
              this.#runs.execute(id, actor, {
                ...(prompt !== undefined && { prompt }),
                ...(opts.forceReview && { forceReview: true }),
                ...(resume && { resume: true }),
              }),
            async (e: unknown) => {
              // Consigne impossible à construire : la tâche ne doit pas rester `ready` (boucle de relance).
              await this.#runs.failTask(id, "preparation_failed", (e as Error)?.message ?? String(e));
              throw e;
            },
          )
          .catch((e: unknown) => {
            // `execute` a déjà mis la tâche en échec (code non réessayable + raison) : on le signale, sans boucle.
            errored.add(id);
            const err = e instanceof Error ? e : new Error(String(e));
            if (opts.onTaskError) opts.onTaskError(id, err);
            else console.warn(`[nexus] tâche ${id} non démarrée : ${err.message}`);
          })
          .finally(() => running.delete(id));
        running.set(id, p);
      }
      if (running.size === 0) {
        if (decision.done) {
          const tasks = await this.#missions.listTasks(missionId);
          await this.#missions.setStatus(
            missionId,
            tasks.every((t) => t.status === "completed") ? "completed" : "failed",
            SYSTEM,
          );
          return decision;
        }
        // Rien ne tourne et rien ne peut démarrer : soit revue humaine en attente, soit blocage définitif.
        return decision;
      }
      await Promise.race([...running.values(), stopped]);
    }
  }
}
