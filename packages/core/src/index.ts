import { EventStore, type PayloadRedactor, type Projector } from "@nexus/event-store";
import { approvalsProjector, ApprovalService } from "./approvals.ts";
import { OWNER, SYSTEM, systemClock, type Clock } from "./events.ts";
import { MissionService, missionsProjector } from "./missions.ts";
import { ProjectService, projectsProjector } from "./projects.ts";
import { RunService, runsProjector, type ExecutionEnvironment } from "./runs.ts";
import { TeamService, teamsProjector } from "./teams.ts";
import { createPayloadRedactor } from "./redaction.ts";
import { MissionOrchestrator } from "./orchestrator.ts";

export { DomainError, domainEvent, OWNER, SYSTEM, systemClock, type Actor, type Clock } from "./events.ts";
export { ProjectService, projectsProjector } from "./projects.ts";
export { TeamService, teamsProjector, type NewAgent } from "./teams.ts";
export { MissionService, missionsProjector, type NewTask } from "./missions.ts";
export { ApprovalService, approvalsProjector } from "./approvals.ts";
export {
  RunService,
  runsProjector,
  buildTaskPrompt,
  type ExecutionEnvironment,
  type ResumeMode,
  type RunOutcome,
} from "./runs.ts";
export { evaluatePolicy, planFingerprint, type PolicyContext, type PolicyDecision } from "./policy.ts";
export {
  pathsOverlap,
  RETRYABLE_FAILURES,
  schedule,
  validateDag,
  type DagIssue,
  type DagTask,
  type ScheduleDecision,
  type ScheduleInput,
} from "./dag.ts";
export {
  extractJsonObject,
  planNeedsHumanApproval,
  routeTasks,
  validatePlan,
  type PlanCheck,
  type PlanValidation,
  type RoutableAgent,
  type RoutingDecision,
} from "./planning.ts";
export { createPayloadRedactor } from "./redaction.ts";
export { MissionOrchestrator, type PlanProposal } from "./orchestrator.ts";
export { ARCHIVE_FORMAT, ARCHIVE_VERSION, exportProject, importProject, type ProjectArchive } from "./archive.ts";

/** Ordre significatif : les projections dépendantes (tâches -> missions) viennent après leurs parents. */
export const coreProjectors: Projector[] = [
  projectsProjector,
  teamsProjector,
  missionsProjector,
  approvalsProjector,
  runsProjector,
];

export type NexusCoreOptions = {
  dbFile: string;
  clock?: Clock;
  /** Valeurs secrètes connues à expurger en plus des motifs de jetons (fournies par le coffre, T-015). */
  knownSecrets?: () => readonly string[];
  redact?: PayloadRedactor;
  execution?: ExecutionEnvironment;
};

/** Point d'entrée du domaine, utilisé par le main Electron et par les tests d'intégration. */
export class NexusCore {
  readonly store: EventStore;
  readonly projects: ProjectService;
  readonly teams: TeamService;
  readonly missions: MissionService;
  readonly approvals: ApprovalService;
  readonly runs: RunService | undefined;
  readonly orchestrator: MissionOrchestrator | undefined;

  private constructor(store: EventStore, clock: Clock, opts: NexusCoreOptions) {
    this.store = store;
    this.projects = new ProjectService(store, clock);
    this.teams = new TeamService(store, clock);
    this.missions = new MissionService(store, clock);
    this.approvals = new ApprovalService(store, clock);
    this.runs = opts.execution ? new RunService(store, clock, this.missions, opts.execution) : undefined;
    this.orchestrator =
      this.runs && opts.execution
        ? new MissionOrchestrator(store, clock, this.missions, this.runs, opts.execution.connectorFor)
        : undefined;
  }

  static async open(opts: NexusCoreOptions): Promise<NexusCore> {
    const clock = opts.clock ?? systemClock;
    const store = await EventStore.open({
      filePath: opts.dbFile,
      projectors: coreProjectors,
      // Expurgation systématique avant écriture du journal (NFR-008, AC-09).
      redact: opts.redact ?? createPayloadRedactor(opts.knownSecrets ?? (() => [])),
      now: clock,
    });
    const core = new NexusCore(store, clock, opts);
    // UC-05 : aucune tâche ne reste `running` sans processus vivant vérifié.
    await core.runs?.recoverInterrupted();
    return core;
  }

  async close(): Promise<void> {
    this.runs?.emergencyStop();
    await this.store.close();
  }
}

export { OWNER as owner, SYSTEM as system };
