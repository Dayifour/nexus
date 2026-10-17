// Contrat IPC renderer <-> main. Chaque canal déclare son schéma de requête et de réponse ; la requête est
// validée dans le preload ET dans le main (contrats_ipc_evenements.md). Le renderer est non fiable.
import { z } from "zod";
import { AbsolutePath, Id, ShortText } from "./common.ts";
import { AgentEvent, ProbeResult, UsageSnapshot } from "./connector.ts";
import { ProjectRelativePath, TaskSummary } from "./planning.ts";
import { DeploymentPlan } from "./deploy-plan.ts";
import { OrchestraDetail, OrchestraFeedEntry, OrchestraSummary } from "./orchestra.ts";

export const IPC_INVOKE_CHANNEL = "nexus:invoke";
export const IPC_EVENT_CHANNEL = "nexus:event";

export const IpcErrorCode = z.enum([
  "invalid_request",
  "unknown_channel",
  "not_found",
  "conflict",
  "policy_denied",
  "approval_required",
  "unavailable",
  "internal_error",
]);
export type IpcErrorCode = z.infer<typeof IpcErrorCode>;

export const IpcError = z.strictObject({ code: IpcErrorCode, message: z.string().max(2000) });
export type IpcError = z.infer<typeof IpcError>;

export const IpcEnvelope = z.strictObject({
  requestId: Id,
  channel: z
    .string()
    .regex(/^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/)
    .max(80),
  payload: z.unknown(),
});
export type IpcEnvelope = z.infer<typeof IpcEnvelope>;

export type IpcResult<T> = { requestId: string; ok: true; data: T } | { requestId: string; ok: false; error: IpcError };

const Empty = z.strictObject({});

export const ProjectSummary = z.strictObject({
  projectId: Id,
  name: ShortText,
  rootPath: AbsolutePath,
  createdAt: z.string(),
  isGitRepository: z.boolean(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

// --- DTO spécifiques à l'interface ---------------------------------------------------------------

export const ProjectDetail = ProjectSummary.extend({ protectEnvFiles: z.boolean() });

export const Capabilities = z.strictObject({
  platform: z.string(),
  sandbox: z.strictObject({
    usable: z.boolean(),
    bwrap: z.boolean(),
    pidNamespace: z.boolean(),
    seccomp: z.boolean(),
    cgroups: z.boolean(),
    reasons: z.array(z.string()),
  }),
  secrets: z.strictObject({ available: z.boolean(), backend: z.string() }),
});

export const SecretMetadataDto = z.strictObject({
  ref: z.string(),
  label: z.string(),
  purposes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const FileEntry = z.strictObject({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory", "symlink"]),
  size: z.number().int().nonnegative().optional(),
  /** Fichier d'identifiants ou .env protégé : contenu non servi à l'interface. */
  protected: z.boolean(),
});

export const GitStatusDto = z.strictObject({
  available: z.boolean(),
  branch: z.string().optional(),
  files: z.array(z.strictObject({ path: z.string(), status: z.string() })),
  reason: z.string().optional(),
});

export const DiffDto = z.strictObject({
  files: z.array(z.strictObject({ path: z.string(), status: z.string() })),
  unified: z.string(),
  truncated: z.boolean(),
  secretFindings: z.array(
    z.strictObject({ file: z.string(), line: z.number().int().optional(), kind: z.string(), masked: z.string() }),
  ),
});

export const RunEventDto = z.strictObject({
  globalSequence: z.number().int(),
  runId: Id,
  occurredAt: z.string(),
  event: AgentEvent,
});

export const UsageSummaryDto = z.strictObject({
  projectId: Id,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  source: z.enum(["reported", "estimated", "unavailable"]),
  indicativeUsd: z.number().nonnegative().optional(),
  caveat: z.string().optional(),
  quotas: z.array(z.strictObject({ connectorId: z.string(), snapshot: UsageSnapshot, label: z.string() })),
});

export const IpcPushEvent = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("domain"),
    globalSequence: z.number().int(),
    aggregateType: z.string(),
    aggregateId: Id,
    eventType: z.string(),
  }),
  z.strictObject({ type: z.literal("run"), taskId: Id, runId: Id, event: AgentEvent }),
  /** Sortie d'un terminal interactif (PTY). */
  z.strictObject({ type: z.literal("terminal"), terminalId: z.string().max(64), data: z.string() }),
  z.strictObject({
    type: z.literal("terminal-exit"),
    terminalId: z.string().max(64),
    exitCode: z.number().int().nullable(),
  }),
  /** État en direct d'un agent, fourni par ses hooks (jamais déduit de son texte). */
  z.strictObject({
    type: z.literal("agent-status"),
    taskId: Id,
    status: z.enum(["starting", "working", "idle", "needs_input", "done", "error"]),
  }),
  /** Connexion réseau refusée par la sandbox (domaine hors liste) : l'utilisateur peut l'autoriser dans les réglages. */
  z.strictObject({
    type: z.literal("sandbox-denied"),
    taskId: Id.optional(),
    target: z.string().max(300),
    reason: z.string().max(200),
  }),
  /** Fil de l'Orchestre (plan, répartition, transmissions, revues, messages entre agents). */
  z.strictObject({ type: z.literal("orchestra"), missionId: Id, entry: OrchestraFeedEntry }),
  /** Journal en direct d'une étape de déploiement (expurgé des secrets). */
  z.strictObject({
    type: z.literal("deploy-log"),
    projectId: Id,
    stepId: z.string().max(80),
    line: z.string().max(2000),
  }),
  /** Demande d'ouverture d'une session (ex. clic sur une notification). */
  z.strictObject({ type: z.literal("navigate"), taskId: Id }),
  /** Changements dans l'arborescence d'un projet surveillé. */
  z.strictObject({
    type: z.literal("fs"),
    projectId: Id,
    changes: z.array(z.strictObject({ path: z.string(), kind: z.enum(["added", "changed", "removed"]) })).max(500),
  }),
]);
export type IpcPushEvent = z.infer<typeof IpcPushEvent>;

const Ok = z.strictObject({ ok: z.literal(true) });

export const AppSettings = z.strictObject({
  theme: z.enum(["dark", "light", "system"]),
  language: z.enum(["fr", "en"]),
  /** Mode proposé par défaut pour une nouvelle session. */
  defaultMode: z.enum(["autonomous", "sandboxed", "supervised"]),
  apiConnectors: z
    .array(
      z.strictObject({
        provider: z.enum(["openai", "anthropic", "google", "openrouter"]),
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
          .optional(),
        accountLabel: z.string().max(60).optional(),
        model: z.string().min(1).max(120),
        secretRef: z.string().max(101),
      }),
    )
    .max(20),
  voice: z.strictObject({
    localWhisperPath: z.string().max(1000).optional(),
    localModelPath: z.string().max(1000).optional(),
    cloudOptIn: z.boolean(),
    cloudModel: z.string().max(120).optional(),
    cloudSecretRef: z.string().max(101).optional(),
  }),
  /** Domaines supplémentaires autorisés en sandbox (format exact hôte:port). */
  sandboxExtraAllow: z.array(z.string().regex(/^[a-z0-9.-]{1,253}:\d{1,5}$/)).max(100),
});
export type AppSettings = z.infer<typeof AppSettings>;

/**
 * Registre des canaux. Ajouter un canal = ajouter une entrée ici (le preload et le main la reprennent
 * automatiquement). Les réponses sont validées dans le main avant envoi (pas de fuite de champ non prévu).
 */
export const ipcChannels = {
  "app.info": {
    request: Empty,
    response: z.strictObject({
      appVersion: z.string(),
      contractsVersion: z.string(),
      platform: z.string(),
      electron: z.string(),
      node: z.string(),
    }),
  },
  "app.capabilities": { request: Empty, response: Capabilities },
  "app.emergencyStop": { request: Empty, response: z.strictObject({ cancelledTaskIds: z.array(Id) }) },

  "agents.inventory": { request: Empty, response: z.array(ProbeResult) },

  "projects.list": { request: Empty, response: z.array(ProjectSummary) },
  "projects.create": {
    request: z.strictObject({ name: ShortText, rootPath: AbsolutePath }),
    response: ProjectSummary,
  },
  "projects.get": { request: z.strictObject({ projectId: Id }), response: ProjectDetail },
  "projects.setEnvProtection": { request: z.strictObject({ projectId: Id, protect: z.boolean() }), response: Ok },
  /** Export local (FR-025) : le chemin est choisi par l'utilisateur dans une boîte de dialogue native du main. */
  "projects.export": {
    request: z.strictObject({ projectId: Id }),
    response: z.strictObject({ path: z.string().nullable(), events: z.number().int() }),
  },
  "projects.import": {
    request: Empty,
    response: z.strictObject({ projectId: Id.nullable(), events: z.number().int() }),
  },

  // --- Espace de travail façon IDE -----------------------------------------------------------------
  /** Dialogue natif de choix de dossier (le renderer ne fournit pas lui-même un chemin arbitraire). */
  "app.pickFolder": { request: Empty, response: z.strictObject({ path: z.string().nullable() }) },
  /** Ouvre (ou crée) le projet d'un dossier : glisser-déposer, dialogue ou projet récent. */
  "projects.open": { request: z.strictObject({ rootPath: AbsolutePath }), response: ProjectSummary },
  "projects.recent": {
    request: Empty,
    response: z.array(ProjectSummary.extend({ lastOpenedAt: z.string().optional() })),
  },
  "files.create": {
    request: z.strictObject({ projectId: Id, path: ProjectRelativePath, kind: z.enum(["file", "directory"]) }),
    response: Ok,
  },
  "files.rename": {
    request: z.strictObject({ projectId: Id, from: ProjectRelativePath, to: ProjectRelativePath }),
    response: Ok,
  },
  /** Suppression vers la corbeille du système (récupérable). */
  "files.delete": { request: z.strictObject({ projectId: Id, path: ProjectRelativePath }), response: Ok },
  /** Active la surveillance de l'arborescence : les changements arrivent en événements `fs`. */
  "files.watch": { request: z.strictObject({ projectId: Id }), response: Ok },
  "files.search": {
    request: z.strictObject({
      projectId: Id,
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(500),
    }),
    response: z.array(z.strictObject({ path: z.string(), score: z.number() })),
  },

  /** Terminal interactif réel (PTY) dans le dossier du projet (ou d'une tâche). */
  /** Terminal utilisateur : toujours dans un projet ouvert (jamais le HOME), voir modèle de menace M20. */
  "terminal.create": {
    request: z.strictObject({
      projectId: Id,
      cwd: z.string().max(1000).optional(),
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(1).max(500),
    }),
    response: z.strictObject({ terminalId: z.string(), shell: z.string(), cwd: z.string() }),
  },
  "terminal.write": {
    request: z.strictObject({ terminalId: z.string().max(64), data: z.string().max(100_000) }),
    response: Ok,
  },
  "terminal.resize": {
    request: z.strictObject({
      terminalId: z.string().max(64),
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(1).max(500),
    }),
    response: Ok,
  },
  "terminal.kill": { request: z.strictObject({ terminalId: z.string().max(64) }), response: Ok },

  /** Session d'agent en un clic : un agent, une consigne, un mode simple. Équipe et mission créées implicitement. */
  "sessions.start": {
    request: z.strictObject({
      projectId: Id,
      connectorId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
      prompt: z.string().min(1).max(50_000),
      mode: z.enum(["autonomous", "sandboxed", "supervised"]),
      title: ShortText.optional(),
    }),
    response: z.strictObject({ taskId: Id, missionId: Id }),
  },
  /**
   * Session INTERACTIVE : la vraie interface (TUI) de l'agent dans un terminal PTY où l'utilisateur tape directement.
   * Dans le mode « sandboxed », le terminal tourne dans la sandbox. L'état arrive par événements `agent-status`.
   */
  "sessions.startInteractive": {
    request: z.strictObject({
      projectId: Id,
      connectorId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
      mode: z.enum(["autonomous", "sandboxed", "supervised"]),
      prompt: z.string().max(50_000).optional(),
      title: ShortText.optional(),
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(1).max(500),
    }),
    response: z.strictObject({ taskId: Id, missionId: Id, terminalId: z.string(), workspacePath: z.string() }),
  },
  /**
   * Même consigne envoyée à plusieurs agents, chacun dans SA copie isolée (modes sandbox ou validation), pour comparer
   * leurs résultats. Le mode Autonome est refusé ici : plusieurs agents écriraient dans le même dossier.
   */
  "sessions.startMany": {
    request: z.strictObject({
      projectId: Id,
      connectorIds: z
        .array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/))
        .min(2)
        .max(6),
      mode: z.enum(["sandboxed", "supervised"]),
      prompt: z.string().min(1).max(50_000),
      title: ShortText.optional(),
      /** Terminaux interactifs (TUI) plutôt que conversations. */
      interactive: z.boolean().default(false),
      cols: z.number().int().min(2).max(1000).default(100),
      rows: z.number().int().min(1).max(500).default(30),
    }),
    response: z.array(
      z.strictObject({
        connectorId: z.string(),
        taskId: Id.optional(),
        terminalId: z.string().optional(),
        workspacePath: z.string().optional(),
        error: z.string().max(300).optional(),
      }),
    ),
  },
  /** Supprime une session (copie isolée et historique local du terminal compris). Refusé tant qu'elle tourne. */
  "sessions.delete": { request: z.strictObject({ taskId: Id }), response: Ok },
  /** Sortie enregistrée du terminal d'une session interactive (pour la relire après coup). */
  "sessions.transcript": {
    request: z.strictObject({ taskId: Id }),
    response: z.strictObject({ data: z.string(), truncated: z.boolean() }),
  },
  /** Rouvre la TUI d'une session existante (reprise de la conversation native si le CLI le permet). */
  "sessions.resumeInteractive": {
    request: z.strictObject({
      taskId: Id,
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(1).max(500),
    }),
    response: z.strictObject({ terminalId: z.string() }),
  },
  "sessions.list": {
    request: z.strictObject({ projectId: Id }),
    response: z.array(
      z.strictObject({
        taskId: Id,
        missionId: Id,
        title: z.string(),
        connectorId: z.string(),
        mode: z.enum(["autonomous", "sandboxed", "supervised", "other"]),
        status: z.string(),
        updatedAt: z.string(),
        /** Dossier de travail isolé (worktree) de la session, s'il existe. */
        workspacePath: z.string().optional(),
        /** Session interactive ouverte : terminal de l'agent et dernier état connu. */
        terminalId: z.string().optional(),
        agentStatus: z.enum(["starting", "working", "idle", "needs_input", "done", "error"]).optional(),
        /** Consigne initiale de la session (prompt de sa mission). */
        prompt: z.string().optional(),
        /** Code de la dernière erreur d'exécution, si la tâche a échoué. */
        lastFailureCode: z.string().optional(),
      }),
    ),
  },
  /** Relance une session terminée avec une nouvelle consigne (reprise native si possible). */
  "sessions.followUp": { request: z.strictObject({ taskId: Id, prompt: z.string().min(1).max(50_000) }), response: Ok },

  /**
   * Pull request GitHub en une action confirmée dans l'interface (via `gh`, s'il est installé et connecté).
   * Branche source : celle de la session (`taskId`) ou la branche courante du projet ; elle doit être déjà poussée.
   */
  "git.createPr": {
    request: z.strictObject({
      projectId: Id,
      taskId: Id.optional(),
      title: z.string().min(1).max(256),
      body: z.string().max(60_000).default(""),
      base: z.string().min(1).max(200).default("main"),
      draft: z.boolean().default(false),
    }),
    response: z.strictObject({ url: z.string().url() }),
  },
  /** Commit du travail (projet ou worktree de tâche) puis push en une action confirmée dans l'interface. */
  "git.commit": {
    request: z.strictObject({ projectId: Id, message: z.string().min(1).max(5000), taskId: Id.optional() }),
    response: z.strictObject({ commit: z.string(), branch: z.string() }),
  },
  "git.pushNow": {
    request: z.strictObject({ projectId: Id, branch: z.string().max(200), remote: z.string().max(100) }),
    response: z.strictObject({
      ok: z.boolean(),
      blockedReasons: z.array(z.string()),
      remoteBranch: z.string().optional(),
    }),
  },
  "git.fileDiff": {
    request: z.strictObject({ projectId: Id, path: ProjectRelativePath, taskId: Id.optional() }),
    response: z.strictObject({ original: z.string(), modified: z.string() }),
  },

  /** Réglages utilisateur (fichiers de configuration gérés depuis l'interface). */
  "settings.get": { request: Empty, response: AppSettings },
  "settings.set": { request: AppSettings, response: AppSettings },

  "tasks.cancel": { request: z.strictObject({ taskId: Id }), response: Ok },
  "tasks.review": {
    request: z.strictObject({ taskId: Id, decision: z.enum(["approve", "request_changes"]) }),
    response: TaskSummary,
  },
  "tasks.events": {
    request: z.strictObject({ taskId: Id, afterSequence: z.number().int().nonnegative() }),
    response: z.array(RunEventDto),
  },
  "tasks.diff": { request: z.strictObject({ taskId: Id }), response: DiffDto },

  "secrets.list": { request: Empty, response: z.array(SecretMetadataDto) },
  "secrets.set": {
    request: z.strictObject({
      ref: z.string().regex(/^[a-z0-9][a-z0-9:._-]{1,100}$/),
      label: ShortText,
      purposes: z
        .array(z.string().regex(/^[a-z]+:[a-z0-9._-]{1,80}$/))
        .min(1)
        .max(10),
      value: z.string().min(1).max(16_384),
    }),
    // La valeur n'est jamais renvoyée.
    response: SecretMetadataDto,
  },
  "secrets.delete": { request: z.strictObject({ ref: z.string().max(101) }), response: Ok },

  "files.list": { request: z.strictObject({ projectId: Id, dir: z.string().max(1000) }), response: z.array(FileEntry) },
  "files.read": {
    request: z.strictObject({ projectId: Id, path: ProjectRelativePath }),
    response: z.strictObject({ content: z.string(), size: z.number().int(), truncated: z.boolean() }),
  },
  "files.write": {
    request: z.strictObject({ projectId: Id, path: ProjectRelativePath, content: z.string().max(5_000_000) }),
    response: Ok,
  },

  "git.status": { request: z.strictObject({ projectId: Id }), response: GitStatusDto },
  /**
   * Orchestre : un objectif, un chef d'orchestre (agent IA) et une équipe d'agents. Le chef découpe, répartit, transmet
   * le travail entre agents, relit chaque résultat et intègre. `full` : tout est autonome ; `approve-plan` : le plan
   * attend la validation de l'utilisateur avant l'exécution.
   */
  "orchestra.start": {
    request: z.strictObject({
      projectId: Id,
      goal: z.string().min(1).max(20_000),
      leadConnectorId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
      memberConnectorIds: z
        .array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/))
        .min(1)
        .max(6),
      mode: z.enum(["autonomous", "sandboxed", "supervised"]),
      autonomy: z.enum(["full", "approve-plan"]),
      maxParallel: z.number().int().min(1).max(6).optional(),
    }),
    response: z.strictObject({ missionId: Id }),
  },
  "orchestra.list": { request: z.strictObject({ projectId: Id }), response: z.array(OrchestraSummary) },
  "orchestra.get": { request: z.strictObject({ missionId: Id }), response: OrchestraDetail },
  /** Valide le plan proposé par le chef (autonomie « approve-plan »). */
  "orchestra.approvePlan": { request: z.strictObject({ missionId: Id }), response: Ok },
  "orchestra.stop": { request: z.strictObject({ missionId: Id }), response: Ok },
  /** Relance un orchestre arrêté ou interrompu (redémarrage de l'application) sur la même mission et la même copie. */
  "orchestra.resume": { request: z.strictObject({ missionId: Id }), response: Ok },
  /** Fichiers modifiés par l'équipe (branche de l'orchestre comparée au projet). */
  "orchestra.changes": {
    request: z.strictObject({ missionId: Id }),
    response: z.array(
      z.strictObject({
        path: z.string(),
        status: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    ),
  },
  /** Intègre le travail de l'équipe dans la branche courante du projet (merge --no-ff, confirmé par boîte native). */
  "orchestra.merge": { request: z.strictObject({ missionId: Id }), response: z.strictObject({ summary: z.string() }) },
  /** Message de l'utilisateur au chef d'orchestre (ou à toute l'équipe) : pris en compte dans les consignes suivantes. */
  "orchestra.message": {
    request: z.strictObject({ missionId: Id, text: z.string().min(1).max(8000) }),
    response: Ok,
  },
  /** Plan de déploiement du projet (null s'il n'a jamais été analysé). */
  "deployPlan.get": { request: z.strictObject({ projectId: Id }), response: DeploymentPlan.nullable() },
  /** Analyse le projet (lecture seule) et produit les propositions du catalogue ; conserve les paramètres déjà saisis. */
  "deployPlan.analyze": { request: z.strictObject({ projectId: Id }), response: DeploymentPlan },
  /** L'IA qui pilote relit et ajuste les propositions (sans rien modifier ni exécuter), avec la demande éventuelle. */
  "deployPlan.askLead": {
    request: z.strictObject({
      projectId: Id,
      connectorId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
      request: z.string().max(4000).optional(),
    }),
    response: DeploymentPlan,
  },
  /** Valide une proposition (ou annule la validation avec null). */
  "deployPlan.choose": {
    request: z.strictObject({ projectId: Id, proposalId: z.string().max(80).nullable() }),
    response: DeploymentPlan,
  },
  /** Paramètres non secrets (dépôt, branche, hôte SSH, chemin de clé, identifiants de projet…). */
  "deployPlan.setInputs": {
    request: z.strictObject({ projectId: Id, inputs: z.record(z.string().max(80), z.string().max(500)) }),
    response: DeploymentPlan,
  },
  /** Range un jeton ou une valeur de variable dans le coffre. La valeur n'est jamais renvoyée. */
  "deployPlan.setSecret": {
    request: z.strictObject({
      projectId: Id,
      ref: z.string().regex(/^deploy\.(vercel|render|railway|atlas|env\.[a-z0-9-]{1,60}\.[a-z0-9_]{1,100})$/),
      value: z.string().min(1).max(16_384),
    }),
    response: Ok,
  },
  /** Références de secrets de déploiement présentes dans le coffre (jamais les valeurs). */
  "deployPlan.secretStatus": { request: z.strictObject({ projectId: Id }), response: z.array(z.string()) },
  /** Exécute une étape automatique (confirmée par une boîte de dialogue native). */
  "deployPlan.runStep": {
    request: z.strictObject({ projectId: Id, stepId: z.string().max(80) }),
    response: DeploymentPlan,
  },
  /** Marque une étape manuelle comme faite, ignorée ou à refaire. */
  "deployPlan.markStep": {
    request: z.strictObject({
      projectId: Id,
      stepId: z.string().max(80),
      status: z.enum(["pending", "done", "skipped"]),
    }),
    response: DeploymentPlan,
  },
  "usage.summary": { request: z.strictObject({ projectId: Id }), response: UsageSummaryDto },

  "voice.status": {
    request: Empty,
    response: z.strictObject({
      state: z.enum(["idle", "armed", "recording", "transcribing", "review", "sent", "discarded", "error"]),
      engines: z.array(
        z.strictObject({
          id: z.string(),
          kind: z.enum(["local", "cloud"]),
          available: z.boolean(),
          reason: z.string().optional(),
        }),
      ),
    }),
  },
  /** Clic explicite sur le micro avec consentement : ouvre une fenêtre courte pendant laquelle l'OS peut accorder l'audio. */
  "voice.arm": {
    request: z.strictObject({ consent: z.literal(true) }),
    response: z.strictObject({ windowMs: z.number().int() }),
  },
  "voice.transcribe": {
    request: z.strictObject({
      engineId: z.string().max(80),
      language: z.enum(["fr", "en"]),
      mimeType: z.enum(["audio/webm", "audio/webm;codecs=opus", "audio/ogg", "audio/wav"]),
      audioBase64: z.string().max(14_000_000),
    }),
    response: z.strictObject({ text: z.string() }),
  },
  /** Envoi de la transcription RELUE et éventuellement corrigée par l'utilisateur. */
  "voice.commit": {
    request: z.strictObject({ editedText: z.string().min(1).max(20_000) }),
    response: z.strictObject({ text: z.string() }),
  },
  "voice.discard": { request: Empty, response: Ok },
} as const satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export type IpcChannel = keyof typeof ipcChannels;
export type IpcRequest<C extends IpcChannel> = z.input<(typeof ipcChannels)[C]["request"]>;
export type IpcResponse<C extends IpcChannel> = z.output<(typeof ipcChannels)[C]["response"]>;

export function isIpcChannel(name: string): name is IpcChannel {
  return Object.hasOwn(ipcChannels, name);
}
