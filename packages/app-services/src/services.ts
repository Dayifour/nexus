// Câblage applicatif (Node pur, sans Electron) : ouvert par le main Electron et par les tests d'intégration.
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentConnector, AgentEvent, IpcPushEvent, PermissionMode, ProbeResult } from "@nexus/contracts";
import {
  ClaudeCliConnector,
  CLI_SIGNATURES,
  CodexCliConnector,
  ConnectorRegistry,
  GENERIC_INVOCATIONS,
  GenericCliConnector,
  type ProbeContext,
  type Runner,
} from "@nexus/connectors";
import {
  AnthropicApiConnector,
  GoogleAiStudioConnector,
  OpenAiApiConnector,
  OpenRouterApiConnector,
} from "@nexus/connectors-api";
import { DomainError, NexusCore } from "@nexus/core";
import { GitBroker, locateGit } from "@nexus/git";
import { GitHubBroker, locateGh } from "@nexus/github";
import { runProcess, type RunOptions } from "@nexus/process-supervisor";
import { probeSandbox, sandboxUsable, type SandboxCapabilities } from "@nexus/sandbox";
import { SecretBroker, SecretVault, type Cipher } from "@nexus/secrets";
import { VoiceController } from "./voice.ts";
import { DEFAULT_SETTINGS, SettingsStore } from "./settings.ts";
import { TerminalManager } from "./terminals.ts";
import { InteractiveSessions } from "./interactive.ts";
import { Orchestra } from "./orchestra.ts";
import { ProjectWatcher } from "./watch.ts";
import { runInSandbox } from "./sandbox-run.ts";
import type { AppSettings } from "@nexus/contracts";

export type AppServicesOptions = {
  userDataDir: string;
  /** Chiffrement adossé au coffre de l'OS (Electron safeStorage). `undefined` = coffre indisponible. */
  cipher?: Cipher;
  /** PATH de l'utilisateur, utilisé pour détecter les CLI (jamais modifié silencieusement). */
  pathEnv: string;
  /** HOME de l'utilisateur : nécessaire aux CLI pour retrouver LEUR propre session (jamais lue par Nexus). */
  home: string;
  /** Notifie l'interface (déjà expurgé). */
  push?: (event: IpcPushEvent) => void;
  /** Tests : capacités de sandbox imposées (sinon sondées). */
  sandboxCapabilities?: SandboxCapabilities;
  /** Tests : connecteurs supplémentaires (ex. factices). */
  extraConnectors?: AgentConnector[];
  /** Boîtes de dialogue natives (Electron) : le renderer ne fournit jamais lui-même un chemin d'écriture. */
  pickSavePath?: (defaultName: string) => Promise<string | null>;
  pickOpenPath?: () => Promise<string | null>;
  pickFolder?: () => Promise<string | null>;
  /** Corbeille du système (Electron shell.trashItem). Sans elle, la suppression depuis l'interface est indisponible. */
  trash?: (absolutePath: string) => Promise<void>;
  /** Confirmation native (boîte de dialogue du processus principal), hors d'atteinte du renderer. */
  confirm?: (message: string, detail: string) => Promise<boolean>;
  /** Environnement complet de l'utilisateur pour SES terminaux interactifs (pas pour les agents). */
  userEnv?: Record<string, string>;
};

type WorkspaceMode = { mode: PermissionMode; protectEnvFiles: boolean; connectorId: string; taskId: string };

export class AppServices {
  readonly core: NexusCore;
  readonly registry: ConnectorRegistry;
  readonly vault: SecretVault | undefined;
  readonly broker: SecretBroker | undefined;
  readonly secretsBackend: string;
  readonly sandbox: SandboxCapabilities;
  /** Sessions d'agent interactives (TUI dans un terminal). */
  readonly interactive: InteractiveSessions;
  /** Chef d'orchestre autonome (équipes multi-agents). */
  readonly orchestra: Orchestra;
  readonly git: GitBroker | undefined;
  readonly probeContext: ProbeContext;
  readonly voice: VoiceController;
  readonly github: GitHubBroker | undefined;
  /** Copie de travail commune d'une mission (Orchestre), réenregistrée au démarrage depuis l'état persistant. */
  readonly #missionWorkspaces = new Map<string, string>();
  /** Mode de permission par TÂCHE (plusieurs tâches de modes différents peuvent partager un dossier). */
  readonly #taskModes = new Map<string, WorkspaceMode>();
  /** Repli par dossier pour les lancements hors tâche (questions au chef dans la copie commune). */
  readonly #workspaceModes = new Map<string, WorkspaceMode>();
  readonly settings: SettingsStore;
  readonly terminals: TerminalManager;
  readonly watcher: ProjectWatcher;
  #apiConnectorIds: string[] = [];
  readonly #runToTask = new Map<string, string>();
  #inventory: ProbeResult[] = [];
  readonly #opts: AppServicesOptions;
  get homeDir(): string {
    return this.#opts.home;
  }
  /** Événement poussé vers l'interface (validé par le main avant envoi). */
  pushEvent(e: IpcPushEvent): void {
    this.#opts.push?.(e);
  }

  get userDataDir(): string {
    return this.#opts.userDataDir;
  }
  get dialogs() {
    return {
      save: this.#opts.pickSavePath,
      open: this.#opts.pickOpenPath,
      folder: this.#opts.pickFolder,
      trash: this.#opts.trash,
      confirm: this.#opts.confirm,
    };
  }

  private constructor(
    opts: AppServicesOptions,
    parts: {
      core: NexusCore;
      registry: ConnectorRegistry;
      vault: SecretVault | undefined;
      broker: SecretBroker | undefined;
      sandbox: SandboxCapabilities;
      git: GitBroker | undefined;
      probeContext: ProbeContext;
      secretsBackend: string;
    },
  ) {
    this.#opts = opts;
    this.core = parts.core;
    this.registry = parts.registry;
    this.vault = parts.vault;
    this.broker = parts.broker;
    this.sandbox = parts.sandbox;
    this.git = parts.git;
    this.probeContext = parts.probeContext;
    this.secretsBackend = parts.secretsBackend;
    this.settings = new SettingsStore(opts.userDataDir);
    this.voice = new VoiceController(opts.userDataDir, opts.pathEnv, parts.broker, this.settings.get());
    const push = opts.push ?? (() => {});
    this.terminals = new TerminalManager({
      env: opts.userEnv ?? { HOME: opts.home, PATH: opts.pathEnv },
      onData: (terminalId, data) => push({ type: "terminal", terminalId, data }),
      onExit: (terminalId, exitCode) => push({ type: "terminal-exit", terminalId, exitCode }),
    });
    this.interactive = new InteractiveSessions({
      core: this.core,
      terminals: this.terminals,
      settings: this.settings,
      sandbox: this.sandbox,
      home: opts.home,
      userEnv: () => opts.userEnv ?? { HOME: opts.home, PATH: opts.pathEnv },
      pathEnv: opts.pathEnv,
      push,
      transcriptsDir: join(opts.userDataDir, "transcripts"),
    });
    this.orchestra = new Orchestra(this);
    this.watcher = new ProjectWatcher((projectId, changes) => push({ type: "fs", projectId, changes }));
    this.settings.onChange((s) => this.#applySettings(s));
    const gitPath = locateGit(opts.pathEnv);
    const ghPath = locateGh(opts.pathEnv);
    this.github = gitPath
      ? new GitHubBroker({
          gitPath,
          ...(ghPath && { ghPath }),
          home: opts.home,
          pathEnv: opts.pathEnv,
          approvals: parts.core.approvals,
        })
      : undefined;
  }

  static async open(opts: AppServicesOptions): Promise<AppServices> {
    mkdirSync(opts.userDataDir, { recursive: true });
    const sandbox = opts.sandboxCapabilities ?? (await probeSandbox());

    let vault: SecretVault | undefined;
    let broker: SecretBroker | undefined;
    let secretsBackend = "unavailable";
    if (opts.cipher) {
      secretsBackend = opts.cipher.backend;
      try {
        vault = new SecretVault(join(opts.userDataDir, "secrets.json"), opts.cipher);
        broker = new SecretBroker(vault);
      } catch {
        // Backend non sûr : coffre désactivé (InsecureBackendError), jamais de stockage en clair.
        vault = undefined;
      }
    }

    const gitPath = locateGit(opts.pathEnv);
    const git = gitPath
      ? new GitBroker({ gitPath, home: opts.home, worktreesRoot: join(opts.userDataDir, "worktrees") })
      : undefined;

    const probeContext: ProbeContext = {
      pathEnv: opts.pathEnv,
      home: opts.home,
      ...(opts.userEnv && { env: opts.userEnv }),
    };
    const registry = new ConnectorRegistry();
    // L'objet services n'existe pas encore : runner et résolution de mode passent par une référence tardive.
    const ref: { svc?: AppServices } = {};
    const runner: Runner = (o, ctx) => ref.svc!.runFor(o, ctx);
    const resolveMode = (policyId: string): PermissionMode =>
      (["read-only", "manual", "notify", "sandbox-auto", "autonomous"] as const).includes(policyId as PermissionMode)
        ? (policyId as PermissionMode)
        : "manual";
    // Environnement minimal des CLI : HOME (leur propre session) et PATH. Aucune autre variable de l'utilisateur.
    const baseEnv = { HOME: opts.home, PATH: opts.pathEnv, LANG: "C.UTF-8", NO_COLOR: "1" };

    registry.register(
      new ClaudeCliConnector({
        probeContext,
        authMode: "vendor-login",
        baseEnv,
        resolvePermissionMode: resolveMode,
        runner,
      }),
    );
    // Dossier de configuration choisi par l'utilisateur (CODEX_HOME, HERMES_HOME) : le CLI y retrouve sa connexion.
    const homeVar = (name: string): Record<string, string> =>
      opts.userEnv?.[name] ? { [name]: opts.userEnv[name] } : {};
    // Fichiers de configuration temporaires des agents (serveur MCP de l'équipe, jeton) : dossier privé de Nexus.
    const runtimeDir = join(opts.userDataDir, "agent-runtime");
    registry.register(
      new CodexCliConnector({
        probeContext,
        baseEnv: { ...baseEnv, ...homeVar("CODEX_HOME") },
        resolvePermissionMode: resolveMode,
        runner,
      }),
    );
    for (const id of ["gemini-cli", "hermes-cli", "opencode-cli", "qwen-cli"]) {
      const signature = CLI_SIGNATURES.find((s) => s.connectorId === id)!;
      registry.register(
        new GenericCliConnector(
          { signature, ...GENERIC_INVOCATIONS[id]! },
          {
            probeContext,
            baseEnv: id === "hermes-cli" ? { ...baseEnv, ...homeVar("HERMES_HOME") } : baseEnv,
            runner,
            runtimeDir,
          },
        ),
      );
    }
    for (const c of opts.extraConnectors ?? []) registry.register(c);

    const execution = {
      connectorFor: (id: string) => registry.get(id),
      workspaceFor: (taskId: string) => ref.svc!.workspaceFor(taskId),
      mcpFor: (taskId: string, connectorId: string) => ref.svc?.orchestra.mcpFor(taskId, connectorId),
      sandboxAvailable: sandboxUsable(sandbox),
    };
    const core = await NexusCore.open({
      dbFile: join(opts.userDataDir, "nexus.db"),
      execution,
      knownSecrets: () => broker?.knownSecrets() ?? [],
    });
    const svc = new AppServices(opts, { core, registry, vault, broker, sandbox, git, probeContext, secretsBackend });
    ref.svc = svc;
    core.store.subscribe((events) => svc.#forward(events));
    svc.#applySettings(svc.settings.get());
    // Orchestres interrompus par la fermeture précédente : marqués arrêtés (relançables), copies communes retrouvées.
    svc.orchestra.recover();
    return svc;
  }

  async close(): Promise<void> {
    await this.orchestra.closeAll();
    this.terminals.killAll();
    this.watcher.closeAll();
    await this.core.close();
  }

  /** Applique les réglages : connecteurs API (reconfigurés à chaud) et dictée. */
  #applySettings(s: AppSettings): void {
    for (const id of this.#apiConnectorIds) this.registry.unregister(id);
    this.#apiConnectorIds = [];
    if (this.broker) {
      for (const c of apiConnectors(s.apiConnectors, this.broker)) {
        if (this.registry.get(c.manifest.id)) continue;
        this.registry.register(c);
        this.#apiConnectorIds.push(c.manifest.id);
      }
    }
    this.voice.configure(s);
    this.#inventory = [];
  }

  /** Inventaire des CLI et outils (FR-003), mis en cache jusqu'au prochain rafraîchissement. */
  async inventory(refresh = false): Promise<ProbeResult[]> {
    if (refresh || this.#inventory.length === 0) this.#inventory = await this.registry.inventory(this.probeContext);
    return this.#inventory;
  }

  /**
   * Dossier de travail d'une tâche (ADR-008) : worktree isolé et branche dédiée pour toute tâche qui écrit ;
   * le projet principal n'est jamais modifié directement par un agent.
   */
  /** Copie de travail commune à toutes les tâches d'une mission (Orchestre). */
  setMissionWorkspace(missionId: string, path: string | undefined): void {
    if (path) this.#missionWorkspaces.set(missionId, path);
    else this.#missionWorkspaces.delete(missionId);
  }

  async workspaceFor(taskId: string): Promise<string> {
    const task = await this.core.missions.getTask(taskId);
    const mission = await this.core.missions.get(task.missionId);
    const project = await this.core.store.prisma.project.findUnique({ where: { id: mission.projectId } });
    if (!project) throw new DomainError("not_found", "Projet introuvable");
    const agent = task.assignedAgentId
      ? await this.core.store.prisma.agentProfile.findUnique({ where: { id: task.assignedAgentId } })
      : null;
    const mode = (agent?.permissionMode ?? "manual") as PermissionMode;
    let workspace: string;
    // Autonome : l'agent agit directement dans le projet (choix du propriétaire). Lecture seule : rien à isoler.
    const shared = this.#missionWorkspaces.get(task.missionId);
    if (shared) workspace = shared;
    else if (mode === "read-only" || mode === "autonomous") workspace = project.rootPath;
    else {
      if (!project.isGitRepository || !this.git) {
        throw new DomainError("policy_denied", "Une tâche qui écrit exige un dépôt Git (worktree isolé, ADR-008)");
      }
      const existing = (await this.git.listTaskWorktrees(project.rootPath)).find(
        (w) => w.branch === `nexus/task-${taskId}`,
      );
      workspace = existing?.path ?? (await this.git.createTaskWorktree(project.rootPath, taskId, "HEAD")).path;
    }
    workspace = realpathSync(workspace);
    const entry = { mode, protectEnvFiles: project.protectEnvFiles, connectorId: agent?.connectorId ?? "", taskId };
    this.#taskModes.set(taskId, entry);
    this.#workspaceModes.set(workspace, entry);
    return workspace;
  }

  /**
   * Runner des connecteurs CLI. « Autonome en sandbox » (`sandbox-auto`) passe par la sandbox vérifiée, avec la session
   * du CLI et un réseau limité à son fournisseur ; si la sandbox est indisponible, l'exécution est refusée (jamais
   * simulée). Les autres modes s'exécutent directement (frontière PID namespace pour l'arrêt).
   */
  async runFor(o: RunOptions, ctx?: { taskId?: string }) {
    const ws = (ctx?.taskId && this.#taskModes.get(ctx.taskId)) || this.#workspaceModes.get(o.cwd);
    if (ws?.mode !== "sandbox-auto") return runProcess(o);
    if (!sandboxUsable(this.sandbox)) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        outputLimitExceeded: false,
        spawnError: "sandbox_unavailable",
        durationMs: 0,
      };
    }
    // Plusieurs agents peuvent partager un dossier (Orchestre) : le profil réseau est celui du binaire lancé.
    const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
    const byBinary = this.#inventory.find((r) => r.path && real(r.path) === real(o.file))?.connectorId;
    return runInSandbox(o, {
      caps: this.sandbox,
      connectorId: byBinary ?? ws.connectorId,
      home: this.#opts.home,
      protectEnvFiles: ws.protectEnvFiles,
      extraAllow: this.settings.get().sandboxExtraAllow,
      onDenied: (target, reason) => this.#opts.push?.({ type: "sandbox-denied", taskId: ws.taskId, target, reason }),
      pathEnv: this.#opts.pathEnv,
    });
  }

  #forward(events: Awaited<ReturnType<NexusCore["store"]["readFrom"]>>): void {
    const push = this.#opts.push;
    for (const e of events) {
      if (e.eventType === "run.started")
        this.#runToTask.set(e.aggregateId, String((e.payload as { taskId: string }).taskId));
      if (e.eventType === "run.event") {
        const taskId = this.#runToTask.get(e.aggregateId);
        const ev = (e.payload as { event: AgentEvent }).event;
        if (taskId) push?.({ type: "run", taskId, runId: e.aggregateId, event: ev });
        continue; // les sorties ne déclenchent pas de rafraîchissement global
      }
      if (e.eventType === "run.finished") {
        // Fin du run : correspondances devenues inutiles (mémoire bornée sur une longue session).
        const taskId = this.#runToTask.get(e.aggregateId);
        this.#runToTask.delete(e.aggregateId);
        if (taskId) this.#taskModes.delete(taskId);
      }
      push?.({
        type: "domain",
        globalSequence: e.globalSequence,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        eventType: e.eventType,
      });
    }
  }
}

function apiConnectors(list: AppSettings["apiConnectors"], broker: SecretBroker): AgentConnector[] {
  const out: AgentConnector[] = [];
  for (const s of list) {
    const id = s.id ?? `${s.provider}-api`;
    const common = {
      id,
      ...(s.accountLabel && { accountLabel: s.accountLabel }),
      model: s.model,
      getApiKey: broker.apiKeyProvider(s.secretRef, `connector:${id}`),
    };
    if (s.provider === "openai") out.push(new OpenAiApiConnector(common));
    else if (s.provider === "anthropic") out.push(new AnthropicApiConnector(common));
    else if (s.provider === "google") out.push(new GoogleAiStudioConnector(common));
    else if (s.provider === "openrouter") out.push(new OpenRouterApiConnector(common));
  }
  return out;
}

export { DEFAULT_SETTINGS };
