// Handlers de l'espace de travail façon IDE : projets, fichiers, terminaux, sessions d'agent simples, Git, réglages.
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type { Capability, PermissionMode } from "@nexus/contracts";
import { OWNER } from "@nexus/core";
import { locateGit } from "@nexus/git";
import { locateGh } from "@nexus/github";
import { runProcess } from "@nexus/process-supervisor";
import { ProjectWorkspace } from "./files.ts";
import type { AppHandlers } from "./handlers.ts";
import type { AppServices } from "./services.ts";

type Exposed = (
  code: "invalid_request" | "not_found" | "conflict" | "policy_denied" | "unavailable",
  message: string,
) => Error;

const MODE_OF: Record<"autonomous" | "sandboxed" | "supervised", PermissionMode> = {
  autonomous: "autonomous",
  sandboxed: "sandbox-auto",
  supervised: "manual",
};
const SESSION_MODE: Partial<Record<PermissionMode, "autonomous" | "sandboxed" | "supervised">> = {
  autonomous: "autonomous",
  "sandbox-auto": "sandboxed",
  manual: "supervised",
};
const SESSIONS_TEAM = "Agents";

export function createWorkspaceHandlers(
  svc: AppServices,
  exposed: Exposed,
  guard: <T>(fn: () => Promise<T> | T) => Promise<T>,
): AppHandlers {
  const { core } = svc;
  const project = async (projectId: string) => {
    const p = await core.store.prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw exposed("not_found", "Projet introuvable");
    return p;
  };
  const workspace = async (projectId: string) => {
    const p = await project(projectId);
    return new ProjectWorkspace(p.rootPath, p.protectEnvFiles);
  };
  const git = (cwd: string, args: string[], stdin?: string) => {
    const gitPath = locateGit(svc.probeContext.pathEnv);
    if (!gitPath) throw exposed("unavailable", "git introuvable");
    // Sortie brute (et non ligne par ligne) : `git show` doit restituer le contenu exact, saut de ligne final compris.
    let out = "";
    const err: string[] = [];
    return runProcess({
      file: gitPath,
      args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      cwd,
      env: { HOME: svc.homeDir, PATH: svc.probeContext.pathEnv, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 60_000,
      ...(stdin !== undefined && { stdin }),
      maxOutputBytes: 32 * 1024 * 1024,
      onChunk: (c, ch) => {
        if (ch === "stdout") out += c;
      },
      onLine: (l, ch) => ch === "stderr" && err.push(l),
    }).then((r) => ({ code: r.exitCode, out, err: err.join("\n") }));
  };
  /** Dossier de travail d'une session : worktree s'il existe, sinon dossier du projet. */
  const sessionDir = async (taskId: string, rootPath: string) => {
    const wt = svc.git
      ? (await svc.git.listTaskWorktrees(rootPath)).find((w) => w.branch === `nexus/task-${taskId}`)
      : undefined;
    return wt?.path ?? rootPath;
  };

  // Sessions supprimées par l'utilisateur : masquées partout. Le journal d'événements, en ajout seul, garde la trace
  // (audit) ; la copie isolée et l'enregistrement du terminal sont effacés.
  const deletedFile = join(svc.userDataDir, "deleted-sessions.json");
  const deleted = (): Set<string> => {
    try {
      return new Set(JSON.parse(readFileSync(deletedFile, "utf8")) as string[]);
    } catch {
      return new Set();
    }
  };
  const transcriptOf = (taskId: string) => join(svc.userDataDir, "transcripts", `${taskId}.log`);

  /** Crée la tâche d'une session (équipe « Agents », profil d'agent et mission implicites). */
  const createSession = async (req: {
    projectId: string;
    connectorId: string;
    mode: "autonomous" | "sandboxed" | "supervised";
    prompt?: string | undefined;
    title?: string | undefined;
  }) => {
    const connector = svc.registry.get(req.connectorId);
    if (!connector) throw exposed("not_found", `Agent ${req.connectorId} indisponible`);
    // Les connecteurs CLI ne connaissent leur binaire qu'après la sonde (mise en cache) : on la garantit ici.
    const inventory = await svc.inventory();
    const p = await project(req.projectId);
    const mode = MODE_OF[req.mode];
    if (mode !== "autonomous" && !p.isGitRepository) {
      throw exposed(
        "invalid_request",
        "Les modes sandbox et validation travaillent sur une copie Git : initialisez d'abord un dépôt Git (ou choisissez Autonome).",
      );
    }
    let team = await core.store.prisma.team.findFirst({
      where: { projectId: p.id, name: SESSIONS_TEAM },
      include: { members: true },
    });
    if (!team) {
      await core.teams.create({ projectId: p.id, name: SESSIONS_TEAM, governanceMode: "MANUAL" }, OWNER);
      team = await core.store.prisma.team.findFirst({
        where: { projectId: p.id, name: SESSIONS_TEAM },
        include: { members: true },
      });
    }
    let agent = team!.members.find((m) => m.connectorId === req.connectorId && m.permissionMode === mode);
    if (!agent) {
      const id = await core.teams.addAgent(
        team!.id,
        {
          role: "Agent",
          displayName: connector.manifest.displayName,
          connectorId: req.connectorId,
          permissionMode: mode,
          authMode: connector.manifest.authModes[0] ?? "vendor-login",
          capabilities: connector.manifest.capabilities as Capability[],
        },
        OWNER,
      );
      agent = (await core.store.prisma.agentProfile.findUnique({ where: { id } }))!;
    }
    const prompt = req.prompt ?? "";
    const title =
      req.title ?? ((prompt.split("\n")[0] ?? "").slice(0, 80) || `Session ${connector.manifest.displayName}`);
    const mission = await core.missions.create(
      { projectId: p.id, teamId: team!.id, title, prompt: prompt || title },
      OWNER,
    );
    const [taskId] = await core.missions.addTasks(
      mission.missionId,
      [
        {
          title,
          description: prompt || title,
          allowedPaths: ["."],
          acceptance: ["La consigne est réalisée"],
          dependsOn: [],
          assignedAgentId: agent.id,
        },
      ],
      OWNER,
    );
    await core.missions.setStatus(mission.missionId, "active", OWNER);
    const binary = inventory.find((r) => r.connectorId === req.connectorId)?.path;
    return { taskId: taskId!, missionId: mission.missionId, project: p, mode, binary };
  };

  const handlers: AppHandlers = {
    "app.pickFolder": () => guard(async () => ({ path: (await svc.dialogs.folder?.()) ?? null })),

    "projects.open": (req) =>
      guard(async () => {
        if (!existsSync(req.rootPath) || !statSync(req.rootPath).isDirectory())
          throw exposed("invalid_request", "Ce chemin n'est pas un dossier");
        const real = realpathSync(req.rootPath);
        const existing = await core.store.prisma.project.findUnique({ where: { rootPath: real } });
        const summary = existing
          ? await core.projects.get(existing.id)
          : await core.projects.create({ name: basename(real) || real, rootPath: real }, OWNER);
        svc.settings.touchRecent(summary.projectId, new Date().toISOString());
        return summary;
      }),
    "projects.recent": () =>
      guard(async () => {
        const out = [];
        for (const r of svc.settings.recent()) {
          const p = await core.store.prisma.project.findUnique({ where: { id: r.projectId } });
          if (p && existsSync(p.rootPath))
            out.push({ ...(await core.projects.get(p.id)), lastOpenedAt: r.lastOpenedAt });
        }
        return out;
      }),

    "files.create": (req) =>
      guard(async () => {
        (await workspace(req.projectId)).create(req.path, req.kind);
        return { ok: true as const };
      }),
    "files.rename": (req) =>
      guard(async () => {
        (await workspace(req.projectId)).rename(req.from, req.to);
        return { ok: true as const };
      }),
    "files.delete": (req) =>
      guard(async () => {
        const trash = svc.dialogs.trash;
        if (!trash) throw exposed("unavailable", "Corbeille du système indisponible");
        await (await workspace(req.projectId)).remove(req.path, trash);
        return { ok: true as const };
      }),
    "files.watch": (req) =>
      guard(async () => {
        const p = await project(req.projectId);
        svc.watcher.watch(p.id, realpathSync(p.rootPath));
        return { ok: true as const };
      }),
    "files.search": (req) => guard(async () => (await workspace(req.projectId)).search(req.query, req.limit)),

    "terminal.create": (req) =>
      guard(async () => {
        if (!svc.terminals.available()) throw exposed("unavailable", "Terminal indisponible (module PTY absent)");
        // Toujours dans un projet ouvert : le dossier du projet ou un worktree de session géré par Nexus.
        const ws = await workspace(req.projectId);
        let cwd = ws.root;
        if (req.cwd) {
          if (!req.cwd.startsWith("/")) cwd = ws.resolve(req.cwd);
          else {
            if (!existsSync(req.cwd)) throw exposed("not_found", "Dossier introuvable");
            cwd = realpathSync(req.cwd);
            const inside = (dir: string) => cwd === dir || cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep);
            const worktrees = join(svc.userDataDir, "worktrees");
            if (!inside(ws.root) && !(existsSync(worktrees) && inside(realpathSync(worktrees)))) {
              throw exposed("policy_denied", "Dossier de terminal hors du projet");
            }
          }
        }
        try {
          return svc.terminals.create(cwd, req.cols, req.rows);
        } catch (e) {
          throw exposed("conflict", (e as Error).message);
        }
      }),
    "terminal.write": (req) =>
      guard(() => {
        try {
          svc.terminals.write(req.terminalId, req.data);
        } catch (e) {
          throw exposed("not_found", (e as Error).message);
        }
        return { ok: true as const };
      }),
    "terminal.resize": (req) =>
      guard(() => {
        try {
          svc.terminals.resize(req.terminalId, req.cols, req.rows);
        } catch (e) {
          throw exposed("not_found", (e as Error).message);
        }
        return { ok: true as const };
      }),
    "terminal.kill": (req) =>
      guard(() => {
        svc.terminals.kill(req.terminalId);
        return { ok: true as const };
      }),

    "sessions.start": (req) =>
      guard(async () => {
        if (!core.runs) throw exposed("unavailable", "Exécution indisponible");
        const s = await createSession(req);
        // Exécution en arrière-plan : la consigne est envoyée telle quelle à l'agent.
        core.runs.execute(s.taskId, OWNER, { prompt: req.prompt }).catch(() => undefined);
        return { taskId: s.taskId, missionId: s.missionId };
      }),
    "sessions.startInteractive": (req) =>
      guard(async () => {
        const s = await createSession(req);
        if (!s.binary) throw exposed("unavailable", `${req.connectorId} n'est pas installé`);
        const workspacePath = await svc.workspaceFor(s.taskId);
        try {
          const terminalId = await svc.interactive.start({
            taskId: s.taskId,
            connectorId: req.connectorId,
            binary: s.binary,
            mode: s.mode,
            workspace: workspacePath,
            protectEnvFiles: s.project.protectEnvFiles,
            ...(req.prompt && { prompt: req.prompt }),
            resume: false,
            cols: req.cols,
            rows: req.rows,
          });
          return { taskId: s.taskId, missionId: s.missionId, terminalId, workspacePath };
        } catch (e) {
          throw exposed(
            "unavailable",
            (e as Error).message === "sandbox_unavailable"
              ? "Sandbox indisponible sur cette machine"
              : "Impossible de lancer l'agent",
          );
        }
      }),
    "sessions.startMany": (req) =>
      guard(async () => {
        if (new Set(req.connectorIds).size !== req.connectorIds.length)
          throw exposed("invalid_request", "Agents en double");
        const title = req.title ?? (req.prompt.split("\n")[0] ?? "").slice(0, 70);
        // Lancements en parallèle ; l'échec d'un agent n'empêche pas les autres.
        return Promise.all(
          req.connectorIds.map(async (connectorId) => {
            const one = {
              projectId: req.projectId,
              connectorId,
              mode: req.mode,
              prompt: req.prompt,
              title: `${title} · ${connectorId}`,
            };
            try {
              if (req.interactive) {
                const r = await handlers["sessions.startInteractive"]!({
                  ...one,
                  cols: req.cols ?? 100,
                  rows: req.rows ?? 30,
                });
                return { connectorId, taskId: r.taskId, terminalId: r.terminalId, workspacePath: r.workspacePath };
              }
              const r = await handlers["sessions.start"]!(one);
              return { connectorId, taskId: r.taskId };
            } catch (e) {
              return { connectorId, error: ((e as Error).message || "échec").slice(0, 300) };
            }
          }),
        );
      }),
    "orchestra.start": (req) => guard(async () => ({ missionId: await svc.orchestra.start(req) })),
    "orchestra.list": (req) => guard(() => svc.orchestra.list(req.projectId)),
    "orchestra.get": (req) => guard(() => svc.orchestra.get(req.missionId)),
    "orchestra.approvePlan": (req) =>
      guard(() => {
        svc.orchestra.approvePlan(req.missionId);
        return { ok: true as const };
      }),
    "orchestra.stop": (req) =>
      guard(() => {
        svc.orchestra.stop(req.missionId);
        return { ok: true as const };
      }),
    "orchestra.resume": (req) =>
      guard(async () => {
        await svc.orchestra.resume(req.missionId);
        return { ok: true as const };
      }),
    "orchestra.changes": (req) => guard(() => svc.orchestra.changes(req.missionId)),
    "orchestra.merge": (req) => guard(async () => ({ summary: await svc.orchestra.merge(req.missionId) })),
    "orchestra.message": (req) =>
      guard(() => {
        svc.orchestra.message(req.missionId, req.text);
        return { ok: true as const };
      }),
    "sessions.delete": (req) =>
      guard(async () => {
        const task = await core.missions.getTask(req.taskId);
        if (svc.interactive.get(req.taskId) || ["running", "queued"].includes(task.status)) {
          throw exposed("conflict", "Impossible de supprimer une session en cours : arrêtez-la d'abord");
        }
        const mission = await core.missions.get(task.missionId);
        const p = await project(mission.projectId);
        if (svc.git && p.isGitRepository) {
          const wt = (await svc.git.listTaskWorktrees(p.rootPath)).find((w) => w.branch === `nexus/task-${req.taskId}`);
          if (wt) await svc.git.removeWorktree(p.rootPath, wt.path, { force: true, deleteBranch: true });
        }
        rmSync(transcriptOf(req.taskId), { force: true });
        const set = deleted();
        set.add(req.taskId);
        writeFileSync(deletedFile, JSON.stringify([...set]), { mode: 0o600 });
        return { ok: true as const };
      }),
    "sessions.transcript": (req) =>
      guard(() => {
        const file = transcriptOf(req.taskId);
        if (!existsSync(file)) return { data: "", truncated: false };
        const buf = readFileSync(file);
        const max = 1024 * 1024;
        return { data: buf.subarray(Math.max(0, buf.length - max)).toString("utf8"), truncated: buf.length > max };
      }),
    "sessions.resumeInteractive": (req) =>
      guard(async () => {
        const open = svc.interactive.get(req.taskId);
        if (open) return { terminalId: open.terminalId };
        const task = await core.missions.getTask(req.taskId);
        if (["running", "queued"].includes(task.status)) throw exposed("conflict", "La session est déjà en cours");
        const agent = task.assignedAgentId
          ? await core.store.prisma.agentProfile.findUnique({ where: { id: task.assignedAgentId } })
          : null;
        if (!agent) throw exposed("not_found", "Agent introuvable");
        const binary = (await svc.inventory()).find((r) => r.connectorId === agent.connectorId)?.path;
        if (!binary) throw exposed("unavailable", `${agent.connectorId} n'est pas installé`);
        const mission = await core.missions.get(task.missionId);
        const p = await project(mission.projectId);
        // Session native d'un run non interactif précédent, sinon celle de la session interactive (= identifiant de tâche).
        const lastRun = await core.store.prisma.agentRun.findFirst({
          where: { taskId: req.taskId },
          orderBy: { startedAt: "desc" },
        });
        try {
          const terminalId = await svc.interactive.start({
            taskId: req.taskId,
            connectorId: agent.connectorId,
            binary,
            mode: agent.permissionMode as PermissionMode,
            workspace: await svc.workspaceFor(req.taskId),
            protectEnvFiles: p.protectEnvFiles,
            resume: true,
            ...(lastRun?.nativeSessionId && { sessionId: lastRun.nativeSessionId }),
            cols: req.cols,
            rows: req.rows,
          });
          return { terminalId };
        } catch (e) {
          throw exposed(
            "unavailable",
            (e as Error).message === "sandbox_unavailable"
              ? "Sandbox indisponible sur cette machine"
              : "Impossible de relancer l'agent",
          );
        }
      }),
    "sessions.list": (req) =>
      guard(async () => {
        const p = await project(req.projectId);
        const team = await core.store.prisma.team.findFirst({
          where: { projectId: p.id, name: SESSIONS_TEAM },
          include: { members: true },
        });
        if (!team) return [];
        const agents = new Map(team.members.map((m) => [m.id, m]));
        const missions = await core.store.prisma.mission.findMany({
          where: { teamId: team.id },
          orderBy: { createdAt: "desc" },
          take: 200,
        });
        const tasks = await core.store.prisma.task.findMany({
          where: { missionId: { in: missions.map((m) => m.id) } },
        });
        const prompts = new Map(missions.map((m) => [m.id, m.prompt]));
        const out = [];
        const hidden = deleted();
        for (const t of tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
          if (hidden.has(t.id)) continue;
          const a = t.assignedAgentId ? agents.get(t.assignedAgentId) : undefined;
          const live = svc.interactive.get(t.id);
          const mode: "autonomous" | "sandboxed" | "supervised" | "other" =
            (a && SESSION_MODE[a.permissionMode as PermissionMode]) ?? "other";
          out.push({
            taskId: t.id,
            missionId: t.missionId,
            title: t.title,
            connectorId: a?.connectorId ?? "inconnu",
            mode,
            status: t.status,
            updatedAt: t.updatedAt,
            workspacePath: mode === "autonomous" ? p.rootPath : await sessionDir(t.id, p.rootPath),
            ...(live && { terminalId: live.terminalId, agentStatus: live.status }),
            ...(prompts.get(t.missionId) && { prompt: prompts.get(t.missionId) }),
            ...(t.lastFailureCode && { lastFailureCode: t.lastFailureCode }),
          });
        }
        return out;
      }),
    "sessions.followUp": (req) =>
      guard(async () => {
        if (!core.runs) throw exposed("unavailable", "Exécution indisponible");
        // Session ouverte dans le terminal de l'agent : le message y est tapé, comme si l'utilisateur l'écrivait.
        const live = svc.interactive.get(req.taskId);
        if (live) {
          svc.terminals.write(live.terminalId, `${req.prompt.replace(/\r?\n/g, " ")}\r`);
          return { ok: true as const };
        }
        const task = await core.missions.getTask(req.taskId);
        if (["running", "queued"].includes(task.status)) throw exposed("conflict", "La session est déjà en cours");
        core.runs.execute(req.taskId, OWNER, { resume: true, prompt: req.prompt }).catch(() => undefined);
        return { ok: true as const };
      }),

    "git.commit": (req) =>
      guard(async () => {
        const p = await project(req.projectId);
        if (req.taskId) {
          if (!svc.git) throw exposed("unavailable", "git introuvable");
          const dir = await sessionDir(req.taskId, p.rootPath);
          return svc.git.commitAll(dir, req.message, { name: "Nexus Agent", email: "agent@nexus.invalid" });
        }
        // Commit de l'utilisateur dans son propre dépôt : son identité git habituelle est utilisée.
        // Le dossier a pu être modifié par un agent : une config capable d'exécuter une commande (filtre…) est refusée.
        if (svc.git) await svc.git.assertSafeRepoConfig(p.rootPath);
        const add = await git(p.rootPath, ["add", "-A"]);
        if (add.code !== 0) throw exposed("conflict", `git add : ${add.err.slice(0, 300)}`);
        const c = await git(p.rootPath, ["commit", "-F", "-"], req.message);
        if (c.code !== 0) throw exposed("conflict", `git commit : ${(c.err || c.out).slice(0, 300)}`);
        const head = await git(p.rootPath, ["rev-parse", "HEAD"]);
        const branch = await git(p.rootPath, ["branch", "--show-current"]);
        return { commit: head.out.trim(), branch: branch.out.trim() || "HEAD" };
      }),
    "git.pushNow": (req) =>
      guard(async () => {
        if (!svc.github) throw exposed("unavailable", "git introuvable");
        const p = await project(req.projectId);
        const plan = await svc.github.preparePush(p.rootPath, req.branch, req.remote);
        if (plan.blocked) return { ok: false, blockedReasons: plan.blockedReasons };
        // L'utilisateur a confirmé dans l'interface : l'approbation est créée et accordée en une fois, liée au plan exact.
        const a = await core.approvals.request(
          { action: "git_push", projectId: p.id, summary: plan.summary, plan: plan.approvalPlan },
          OWNER,
        );
        await core.approvals.respond(a.approvalId, "allow", OWNER);
        const r = await svc.github.push(p.rootPath, plan, a.approvalId);
        return { ok: true, blockedReasons: [], remoteBranch: r.remoteBranch };
      }),
    "git.createPr": (req) =>
      guard(async () => {
        if (!svc.github || !locateGh(svc.probeContext.pathEnv)) {
          throw exposed(
            "unavailable",
            "Création de PR indisponible : installez et connectez GitHub CLI (gh auth login)",
          );
        }
        const p = await project(req.projectId);
        const dir = req.taskId ? await sessionDir(req.taskId, p.rootPath) : p.rootPath;
        const head = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
        if (!head || head === "HEAD") throw exposed("invalid_request", "Aucune branche active");
        const input = {
          title: req.title,
          body: req.body ?? "",
          base: req.base ?? "main",
          head,
          draft: req.draft ?? false,
        };
        const plan = await svc.github.preparePullRequest(dir, input);
        // Confirmée dans l'interface : approbation créée et accordée en une fois, liée au plan exact.
        const a = await core.approvals.request(
          { action: "github_pr_create", projectId: p.id, summary: plan.summary, plan: plan.approvalPlan },
          OWNER,
        );
        await core.approvals.respond(a.approvalId, "allow", OWNER);
        try {
          return { url: (await svc.github.createPullRequest(dir, input, a.approvalId)).url };
        } catch (e) {
          throw exposed("unavailable", ((e as Error).message || "Échec de création de la PR").slice(0, 500));
        }
      }),
    "git.fileDiff": (req) =>
      guard(async () => {
        const p = await project(req.projectId);
        const dir = req.taskId ? await sessionDir(req.taskId, p.rootPath) : p.rootPath;
        const ws = new ProjectWorkspace(dir, p.protectEnvFiles);
        if (ws.isProtected(req.path)) throw exposed("policy_denied", "Fichier protégé");
        const orig = await git(dir, ["show", `HEAD:${req.path}`]);
        const full = ws.resolve(req.path);
        return {
          original: orig.code === 0 ? orig.out : "",
          modified: existsSync(full) ? readFileSync(full, "utf8") : "",
        };
      }),

    "settings.get": () => guard(() => svc.settings.get()),
    "settings.set": (req) =>
      guard(async () => {
        // Élargir le réseau de la sandbox est une décision de sécurité : confirmée par une boîte de dialogue native du
        // processus principal, qu'un script du renderer ne peut pas valider à la place de l'utilisateur.
        const before = new Set(svc.settings.get().sandboxExtraAllow);
        const added = (req.sandboxExtraAllow ?? []).filter((d) => !before.has(d));
        if (added.length > 0 && svc.dialogs.confirm) {
          const ok = await svc.dialogs.confirm(
            "Autoriser ces domaines dans la sandbox ?",
            `Les agents en mode « Autonome en sandbox » pourront joindre :\n${added.join("\n")}`,
          );
          if (!ok) throw exposed("policy_denied", "Ajout de domaines refusé");
        }
        return svc.settings.set(req);
      }),
  };
  return handlers;
}
