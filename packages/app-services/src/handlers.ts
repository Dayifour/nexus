// Handlers IPC : traduisent chaque canal du contrat en appel aux services. Les erreurs métier deviennent des
// erreurs IPC contrôlées ; les réponses sont ensuite validées par le dispatcher du main (aucun champ imprévu).
import {
  CONTRACTS_VERSION,
  type AgentEvent,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from "@nexus/contracts";
import { readFileSync, writeFileSync } from "node:fs";
import { createPayloadRedactor, DomainError, exportProject, importProject, OWNER } from "@nexus/core";
import { isGitError } from "@nexus/git";
import { isGitHubError } from "@nexus/github";
import { sandboxUsable } from "@nexus/sandbox";
import { describeQuota, UsageLedger } from "@nexus/usage";
import { ProjectFiles } from "./files.ts";
import type { AppServices } from "./services.ts";
import { createWorkspaceHandlers } from "./workspace-handlers.ts";
import { createDeployHandlers } from "./deploy-handlers.ts";
import { localizeMessage } from "./messages.ts";

export type AppHandlers = {
  [C in IpcChannel]?: (request: IpcRequest<C>) => Promise<IpcResponse<C>> | IpcResponse<C>;
};

/** Erreur exposable au renderer (code stable + message contrôlé). Le main la convertit en IpcHandlerError. */
export class ExposedError extends Error {
  readonly code: "invalid_request" | "not_found" | "conflict" | "policy_denied" | "approval_required" | "unavailable";
  constructor(code: ExposedError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError) throw new ExposedError(e.code, e.message);
    if (isGitError(e)) throw new ExposedError("conflict", `Git : ${e.message}`);
    // Erreurs des brokers distants : messages déjà bornés et expurgés par leurs packages.
    if (isGitHubError(e)) throw new ExposedError("policy_denied", `GitHub : ${e.message}`);
    // Erreurs système courantes (fichier supprimé hors de Nexus, droits…) : message clair au lieu d'une erreur interne.
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") throw new ExposedError("not_found", "Élément introuvable");
    if (code === "EACCES" || code === "EPERM") throw new ExposedError("policy_denied", "Accès refusé par le système");
    if (code === "EISDIR") throw new ExposedError("invalid_request", "Pas un fichier");
    if (code === "ENOTDIR") throw new ExposedError("invalid_request", "Pas un dossier");
    if (code === "EEXIST" || code === "ENOTEMPTY") throw new ExposedError("conflict", "Un élément porte déjà ce nom");
    if (code === "ENOSPC") throw new ExposedError("unavailable", "Disque plein");
    throw e;
  }
}

export function createAppHandlers(
  svc: AppServices,
  appInfo: { appVersion: string; electron: string; node: string; platform: string },
): AppHandlers {
  const { core } = svc;
  const files = async (projectId: string) => {
    const p = await core.store.prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw new ExposedError("not_found", "Projet introuvable");
    return new ProjectFiles(p.rootPath, p.protectEnvFiles);
  };
  const vault = () => {
    if (!svc.vault)
      throw new ExposedError("unavailable", `Coffre de secrets indisponible (backend ${svc.secretsBackend})`);
    return svc.vault;
  };
  const projectOfMission = async (missionId: string) => (await core.missions.get(missionId)).projectId;
  const handlers: AppHandlers = {
    ...createWorkspaceHandlers(svc, (code, message) => new ExposedError(code, message), guard),
    ...createDeployHandlers(svc, (code, message) => new ExposedError(code, message), guard),
    "app.info": () => ({ ...appInfo, contractsVersion: CONTRACTS_VERSION }),
    "app.capabilities": () => ({
      platform: appInfo.platform,
      sandbox: {
        usable: sandboxUsable(svc.sandbox),
        bwrap: svc.sandbox.bwrap,
        pidNamespace: svc.sandbox.pidNamespace,
        seccomp: svc.sandbox.seccomp,
        cgroups: svc.sandbox.cgroups,
        reasons: svc.sandbox.reasons,
      },
      secrets: { available: Boolean(svc.vault), backend: svc.secretsBackend },
    }),
    "app.emergencyStop": () =>
      guard(async () => {
        const cancelledTaskIds = core.runs?.emergencyStop() ?? [];
        return { cancelledTaskIds };
      }),

    "agents.inventory": () => guard(() => svc.inventory(true)),

    "projects.list": () => guard(() => core.projects.list()),
    "projects.create": (req) => guard(() => core.projects.create(req, OWNER)),
    "projects.get": (req) =>
      guard(async () => ({
        ...(await core.projects.get(req.projectId)),
        protectEnvFiles: await core.projects.isEnvProtected(req.projectId),
      })),
    "projects.setEnvProtection": (req) =>
      guard(async () => {
        await core.projects.setEnvProtection(req.projectId, req.protect, OWNER);
        return { ok: true as const };
      }),

    "projects.export": (req) =>
      guard(async () => {
        const project = await core.projects.get(req.projectId);
        const archive = await exportProject(
          core.store,
          req.projectId,
          createPayloadRedactor(() => svc.broker?.knownSecrets() ?? []),
          () => new Date().toISOString(),
        );
        const path = await svc.dialogs.save?.(`${project.name.replace(/[^\w.-]+/g, "_")}.nexus.json`);
        if (!path) return { path: null, events: archive.events.length };
        writeFileSync(path, JSON.stringify(archive), { mode: 0o600 });
        return { path, events: archive.events.length };
      }),
    "projects.import": () =>
      guard(async () => {
        const path = await svc.dialogs.open?.();
        if (!path) return { projectId: null, events: 0 };
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(path, "utf8"));
        } catch {
          throw new ExposedError("invalid_request", "Fichier d'archive illisible");
        }
        return importProject(core.store, raw);
      }),

    "tasks.cancel": (req) =>
      guard(() => {
        if (!core.runs?.cancel(req.taskId))
          throw new ExposedError("conflict", "Aucune exécution active pour cette tâche");
        return { ok: true as const };
      }),
    "tasks.review": (req) =>
      guard(async () => {
        if (req.decision === "approve")
          await core.missions.transition(req.taskId, "completed", OWNER, { reason: "review_approved" });
        else
          await core.missions.transition(req.taskId, "failed", OWNER, {
            failureCode: "changes_requested",
            reason: "review_changes_requested",
          });
        return core.missions.getTask(req.taskId);
      }),
    "tasks.events": (req) =>
      guard(async () => {
        const runs = await core.store.prisma.agentRun.findMany({
          where: { taskId: req.taskId },
          orderBy: { startedAt: "asc" },
          select: { id: true },
        });
        // Filtre et limite appliqués dans la base (les 2000 derniers après la séquence demandée).
        const events = await core.store.queryEvents({
          aggregateIds: runs.map((r) => r.id),
          eventType: "run.event",
          afterGlobalSequence: req.afterSequence,
          limit: 2000,
          last: true,
        });
        const out = events.map((e) => ({
          globalSequence: e.globalSequence,
          runId: e.aggregateId,
          occurredAt: e.occurredAt,
          event: (e.payload as { event: AgentEvent }).event,
        }));
        return out.slice(-2000);
      }),
    "tasks.diff": (req) =>
      guard(async () => {
        if (!svc.git) throw new ExposedError("unavailable", "Git introuvable");
        const task = await core.missions.getTask(req.taskId);
        const project = await core.projects.get(await projectOfMission(task.missionId));
        const worktree = (await svc.git.listTaskWorktrees(project.rootPath)).find(
          (w) => w.branch === `nexus/task-${req.taskId}`,
        );
        if (!worktree) throw new ExposedError("not_found", "Aucun worktree pour cette tâche");
        // Le travail de l'agent (fichiers nouveaux compris) est commité sur la branche de la tâche, puis comparé à la
        // branche du projet : la revue voit exactement ce qui serait fusionné. Le dépôt principal n'est pas touché.
        const st = await svc.git.status(worktree.path);
        if (!st.clean) {
          await svc.git.commitAll(worktree.path, `Nexus : travail de la tâche « ${task.title} »`, {
            name: "Nexus Agent",
            email: "agent@nexus.invalid",
          });
        }
        const base = (await svc.git.currentBranch(project.rootPath)) ?? "HEAD";
        const d = await svc.git.diff(worktree.path, { base, head: `nexus/task-${req.taskId}` });
        return {
          files: d.files.map((f) => ({ path: f.path, status: f.status })),
          unified: d.unified,
          truncated: d.truncated,
          secretFindings: d.secrets.map((s) => ({
            file: s.file,
            ...(s.line > 0 && { line: s.line }),
            kind: String(s.rule),
            masked: s.masked,
          })),
        };
      }),

    "secrets.list": () => guard(() => vault().list()),
    "secrets.set": (req) => guard(() => vault().set(req.ref, req.value, { label: req.label, purposes: req.purposes })),
    "secrets.delete": (req) =>
      guard(() => {
        if (!vault().delete(req.ref)) throw new ExposedError("not_found", "Secret introuvable");
        return { ok: true as const };
      }),

    "files.list": (req) => guard(async () => (await files(req.projectId)).list(req.dir)),
    "files.read": (req) => guard(async () => (await files(req.projectId)).read(req.path)),
    "files.write": (req) =>
      guard(async () => {
        (await files(req.projectId)).write(req.path, req.content);
        return { ok: true as const };
      }),

    "git.status": (req) =>
      guard(async () => {
        const project = await core.projects.get(req.projectId);
        if (!svc.git) return { available: false, files: [], reason: "git introuvable dans le PATH" };
        if (!project.isGitRepository)
          return { available: false, files: [], reason: "le projet n'est pas un dépôt Git" };
        const s = await svc.git.status(project.rootPath);
        return {
          available: true,
          ...(s.branch && { branch: s.branch }),
          files: s.entries.slice(0, 2000).map((e) => ({ path: e.path, status: `${e.index}${e.worktree}` })),
        };
      }),

    "voice.status": () => ({ state: svc.voice.state, engines: svc.voice.engines.map((e) => e.status()) }),
    "voice.arm": () => ({ windowMs: svc.voice.arm() }),
    "voice.transcribe": (req) =>
      guard(async () => {
        try {
          return {
            text: await svc.voice.transcribe(
              req.engineId,
              req.language,
              req.mimeType,
              Buffer.from(req.audioBase64, "base64"),
            ),
          };
        } catch (e) {
          throw new ExposedError("unavailable", `Transcription impossible : ${(e as Error).message}`.slice(0, 500));
        }
      }),
    "voice.commit": (req) =>
      guard(() => {
        try {
          return { text: svc.voice.commit(req.editedText) };
        } catch (e) {
          throw new ExposedError("conflict", (e as Error).message);
        }
      }),
    "voice.discard": () => {
      svc.voice.discard();
      return { ok: true as const };
    },

    "usage.summary": (req) =>
      guard(async () => {
        const ledger = new UsageLedger();
        // Trois requêtes au lieu d'une par mission, tâche et run : tâches du projet, leurs runs, événements d'usage.
        const missions = await core.store.prisma.mission.findMany({
          where: { projectId: req.projectId },
          select: { id: true },
        });
        const tasks = await core.store.prisma.task.findMany({
          where: { missionId: { in: missions.map((m) => m.id) } },
          select: { id: true, assignedAgentId: true },
        });
        const agentOf = new Map(tasks.map((t) => [t.id, t.assignedAgentId ?? "unknown"]));
        const runs = await core.store.prisma.agentRun.findMany({
          where: { taskId: { in: tasks.map((t) => t.id) } },
          select: { id: true, taskId: true, connectorId: true },
        });
        const runOf = new Map(runs.map((r) => [r.id, r]));
        for (const e of await core.store.queryEvents({ aggregateIds: runs.map((r) => r.id), eventType: "run.event" })) {
          const ev = (e.payload as { event?: AgentEvent }).event;
          const r = runOf.get(e.aggregateId);
          if (ev?.kind === "usage" && r)
            ledger.record(ev, {
              projectId: req.projectId,
              agentId: agentOf.get(r.taskId) ?? "unknown",
              observedAt: e.occurredAt,
              origin: r.connectorId,
            });
        }
        const totals = ledger.byProject(req.projectId);
        const source =
          totals.reported.events > 0 ? "reported" : totals.estimated.events > 0 ? "estimated" : "unavailable";
        const bucket = source === "estimated" ? totals.estimated : totals.reported;
        const quotas = (
          await core.store.prisma.usageSnapshot.findMany({ orderBy: { observedAt: "desc" }, take: 20 })
        ).map((q) => {
          const snapshot = {
            observedAt: q.observedAt,
            source: q.source as "vendor" | "cli" | "local-estimate" | "unavailable",
            ...(q.remaining !== null && { remaining: q.remaining }),
            ...(q.consumed !== null && { consumed: q.consumed }),
            ...(q.unit && { unit: q.unit as "tokens" | "requests" | "usd" | "percent" }),
            ...(q.windowEnd && { windowEnd: q.windowEnd }),
            ...(q.caveat && { caveat: q.caveat }),
          };
          return { connectorId: q.connectorId, snapshot, label: describeQuota(snapshot).labelFr };
        });
        return {
          projectId: req.projectId,
          inputTokens: bucket.tokens.input,
          outputTokens: bucket.tokens.output,
          source,
          ...(bucket.cost.indicativeUsd > 0 && {
            indicativeUsd: bucket.cost.indicativeUsd,
            caveat: "Coût indicatif calculé par le CLI ; pas une facturation",
          }),
          quotas,
        };
      }),
  };
  // Messages d'erreur dans la langue choisie par l'utilisateur (les services écrivent en français).
  const localized = Object.fromEntries(
    Object.entries(handlers).map(([channel, fn]) => [
      channel,
      async (req: unknown) => {
        try {
          return await (fn as (r: unknown) => unknown)(req);
        } catch (e) {
          if (e instanceof ExposedError)
            throw new ExposedError(e.code, localizeMessage(e.message, svc.settings.get().language));
          throw e;
        }
      },
    ]),
  );
  return localized as AppHandlers;
}
