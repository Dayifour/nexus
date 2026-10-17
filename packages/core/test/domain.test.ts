import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError, NexusCore, OWNER, SYSTEM, evaluatePolicy, type ExecutionEnvironment } from "../src/index.ts";
import { FakeConnector } from "./fixtures/fake-connector.ts";

type Env = { dir: string; db: string; repo: string };

function env(t: TestContext): Env {
  const dir = mkdtempSync(join(tmpdir(), "nexus-domain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  return { dir, db: join(dir, "nexus.db"), repo };
}

function execution(
  connectors: FakeConnector[],
  repo: string,
  extra: Partial<ExecutionEnvironment> = {},
): ExecutionEnvironment {
  return {
    connectorFor: (id) => connectors.find((c) => c.manifest.id === id),
    workspaceFor: async () => repo,
    sandboxAvailable: true,
    ...extra,
  };
}

async function open(t: TestContext, e: Env, exec?: ExecutionEnvironment): Promise<NexusCore> {
  const core = await NexusCore.open({ dbFile: e.db, ...(exec && { execution: exec }) });
  t.after(() => core.close());
  return core;
}

const isCode = (code: string) => (err: unknown) => err instanceof DomainError && err.code === code;

/** Projet + équipe à deux agents de fournisseurs différents + mission. */
async function seed(core: NexusCore, e: Env, governance: "MANUAL" | "ASSISTED" | "AI_SUPERVISED" = "MANUAL") {
  const project = await core.projects.create({ name: "Stock", rootPath: e.repo }, OWNER);
  const team = await core.teams.create(
    { projectId: project.projectId, name: "Produit", governanceMode: governance },
    OWNER,
  );
  const backend = await core.teams.addAgent(
    team.teamId,
    {
      role: "Backend",
      displayName: "Claude",
      connectorId: "fake-a",
      permissionMode: "manual",
      authMode: "api-key",
      capabilities: ["edit", "chat"],
    },
    OWNER,
  );
  const frontend = await core.teams.addAgent(
    team.teamId,
    {
      role: "Frontend",
      displayName: "Codex",
      connectorId: "fake-b",
      permissionMode: "manual",
      authMode: "api-key",
      capabilities: ["edit", "chat"],
    },
    OWNER,
  );
  const mission = await core.missions.create(
    { projectId: project.projectId, teamId: team.teamId, title: "Stock", prompt: "Application de stock" },
    OWNER,
  );
  return { project, team, backend, frontend, mission };
}

test("équipes : 2 équipes configurées, agent sous abonnement en sandbox autorisé (choix de l'utilisateur), gouvernance changée (T-010)", async (t) => {
  const e = env(t);
  const core = await open(t, e);
  const { project, team, backend } = await seed(core, e);
  await core.teams.create({ projectId: project.projectId, name: "QA", governanceMode: "MANUAL" }, OWNER);
  assert.equal(await core.store.prisma.team.count({ where: { projectId: project.projectId } }), 2);
  // L'ancienne règle D-1 est levée : activer la sandbox pour Claude sous abonnement est un choix de l'utilisateur.
  const sandboxed = await core.teams.addAgent(
    team.teamId,
    {
      role: "x",
      displayName: "x",
      connectorId: "claude-cli",
      permissionMode: "sandbox-auto",
      authMode: "vendor-login",
    },
    OWNER,
  );
  assert.ok(sandboxed);
  await assert.rejects(
    core.teams.setGovernance(team.teamId, "AI_SUPERVISED", undefined, OWNER),
    isCode("invalid_request"),
  );
  await assert.rejects(
    core.teams.setGovernance(team.teamId, "AI_SUPERVISED", backend, { actorType: "agent", actorId: backend }),
    isCode("policy_denied"),
  );
  await core.teams.setGovernance(team.teamId, "AI_SUPERVISED", backend, OWNER);
  const after = await core.teams.get(team.teamId);
  assert.equal(after.governanceMode, "AI_SUPERVISED");
  assert.equal(after.supervisorAgentId, backend);
});

test("missions : DAG validé à l'ajout, cycle refusé, agent hors équipe refusé, chemins absolus refusés", async (t) => {
  const e = env(t);
  const core = await open(t, e);
  const { mission, backend } = await seed(core, e);
  const ids = await core.missions.addTasks(
    mission.missionId,
    [
      {
        key: "api",
        title: "API",
        description: "d",
        allowedPaths: ["backend"],
        acceptance: ["tests"],
        dependsOn: [],
        assignedAgentId: backend,
      },
      { key: "qa", title: "QA", description: "d", allowedPaths: ["tests"], acceptance: ["vert"], dependsOn: ["api"] },
    ],
    OWNER,
  );
  const qa = await core.missions.getTask(ids[1]!);
  assert.deepEqual(qa.dependsOn, [ids[0]]);
  assert.equal(qa.status, "draft");
  await assert.rejects(
    core.missions.addTasks(
      mission.missionId,
      [{ key: "x", title: "x", description: "", allowedPaths: ["a"], acceptance: ["a"], dependsOn: ["x"] }],
      OWNER,
    ),
    isCode("invalid_request"),
  );
  await assert.rejects(
    core.missions.addTasks(
      mission.missionId,
      [
        {
          title: "x",
          description: "",
          allowedPaths: ["a"],
          acceptance: ["a"],
          dependsOn: [],
          assignedAgentId: "00000000-0000-4000-8000-000000000000",
        },
      ],
      OWNER,
    ),
    isCode("invalid_request"),
  );
  await assert.rejects(
    core.missions.addTasks(
      mission.missionId,
      [{ title: "x", description: "", allowedPaths: ["/etc"], acceptance: ["a"], dependsOn: [] }],
      OWNER,
    ),
    isCode("invalid_request"),
  );
  await assert.rejects(
    core.missions.transition(ids[0]!, "running", OWNER),
    isCode("conflict"),
    "draft -> running interdit",
  );
});

test("approbations AC-08 : utilisateur seul, empreinte du plan, expiration, usage unique", async (t) => {
  const e = env(t);
  let now = Date.parse("2026-10-11T10:00:00.000Z");
  const core = await NexusCore.open({ dbFile: e.db, clock: () => new Date(now).toISOString() });
  t.after(() => core.close());
  const { project } = await seed(core, e);
  const plan = { remote: "origin", branch: "feature/x", commits: ["abc"] };
  const req = await core.approvals.request(
    { action: "git_push", projectId: project.projectId, summary: "Push feature/x", plan, ttlMs: 60_000 },
    SYSTEM,
  );
  await assert.rejects(
    core.approvals.respond(req.approvalId, "allow", { actorType: "agent", actorId: "a" }),
    isCode("policy_denied"),
  );
  await assert.rejects(
    core.approvals.consume(req.approvalId, "git_push", plan, SYSTEM),
    isCode("policy_denied"),
    "pas encore accordée",
  );
  await core.approvals.respond(req.approvalId, "allow", OWNER);
  await assert.rejects(
    core.approvals.consume(req.approvalId, "git_push", { ...plan, branch: "main" }, SYSTEM),
    isCode("policy_denied"),
    "plan modifié",
  );
  await assert.rejects(
    core.approvals.consume(req.approvalId, "vercel_deploy_production", plan, SYSTEM),
    isCode("policy_denied"),
  );
  await core.approvals.consume(req.approvalId, "git_push", plan, SYSTEM);
  await assert.rejects(
    core.approvals.consume(req.approvalId, "git_push", plan, SYSTEM),
    isCode("policy_denied"),
    "usage unique",
  );
  const late = await core.approvals.request(
    { action: "git_push", projectId: project.projectId, summary: "x", plan, ttlMs: 1000 },
    SYSTEM,
  );
  now += 5000;
  await assert.rejects(core.approvals.respond(late.approvalId, "allow", OWNER), isCode("conflict"));
  assert.equal((await core.approvals.get(late.approvalId)).status, "expired");
});

test("politique : matrice des permissions, mode autonome, sandbox", () => {
  const ctx = { sandboxAvailable: true, authMode: "api-key" as const };
  assert.equal(evaluatePolicy("git_force_push", { ...ctx, mode: "sandbox-auto" }).effect, "deny");
  assert.equal(evaluatePolicy("git_push", { ...ctx, mode: "sandbox-auto" }).effect, "require_approval");
  const prod = evaluatePolicy("vercel_deploy_production", { ...ctx, mode: "manual" });
  assert.ok(prod.effect === "require_approval" && prod.approvalKind === "confirm_distinct");
  assert.equal(evaluatePolicy("file_write", { ...ctx, mode: "sandbox-auto" }).effect, "allow");
  assert.equal(evaluatePolicy("file_write", { ...ctx, mode: "read-only" }).effect, "deny");
  assert.equal(
    evaluatePolicy("command_exec", { ...ctx, mode: "sandbox-auto", sandboxAvailable: false }).effect,
    "deny",
  );
  assert.equal(
    evaluatePolicy("command_exec", { mode: "sandbox-auto", sandboxAvailable: true, authMode: "vendor-login" }).effect,
    "allow",
    "sandbox activée par l'utilisateur, même sous abonnement",
  );
  for (const action of ["file_write", "command_exec", "network_egress", "dependency_install"] as const) {
    assert.equal(evaluatePolicy(action, { ...ctx, mode: "autonomous" }).effect, "allow", action);
  }
  assert.equal(evaluatePolicy("git_force_push", { ...ctx, mode: "autonomous" }).effect, "deny", "jamais de force-push");
  assert.equal(evaluatePolicy("command_exec", { ...ctx, mode: "manual" }).effect, "require_approval");
});

test("exécution : tâche terminée -> revue humaine ; usage et sorties journalisés ; secret expurgé du journal", async (t) => {
  const e = env(t);
  const secretLike = "sk-ant-" + "x".repeat(30);
  const a = new FakeConnector("fake-a", {
    kind: "complete",
    text: `résultat ${secretLike}`,
    nativeSessionId: "native-1",
  });
  const core = await open(t, e, execution([a], e.repo));
  const { mission, backend } = await seed(core, e);
  const [taskId] = await core.missions.addTasks(
    mission.missionId,
    [
      {
        title: "API",
        description: "Écrire l'API",
        allowedPaths: ["backend"],
        acceptance: ["tests verts"],
        dependsOn: [],
        assignedAgentId: backend,
      },
    ],
    OWNER,
  );
  const outcome = await core.runs!.execute(taskId!, OWNER);
  assert.equal(outcome.status, "completed");
  const task = await core.missions.getTask(taskId!);
  assert.equal(task.status, "waiting_review");
  assert.equal(task.attempt, 1);
  assert.match(a.requests[0]!.req.prompt, /Critères d'acceptation/);
  const runEvents = await core.store.loadAggregate(outcome.runId);
  assert.deepEqual(
    runEvents.map((x) => x.eventType),
    ["run.started", "run.event", "run.event", "run.event", "run.event", "run.finished"],
  );
  const journal = JSON.stringify(await core.store.readFrom(0, 10_000));
  assert.ok(!journal.includes(secretLike), "AC-09 : motif de jeton expurgé avant écriture");
  const run = await core.store.prisma.agentRun.findUnique({ where: { id: outcome.runId } });
  assert.equal(run?.nativeSessionId, "native-1");
  await core.missions.transition(taskId!, "completed", OWNER);
});

test("exécution : échec -> failed avec code ; réessai seulement si réessayable", async (t) => {
  const e = env(t);
  const a = new FakeConnector("fake-a", { kind: "fail", code: "auth_required" });
  const core = await open(t, e, execution([a], e.repo));
  const { mission, backend } = await seed(core, e);
  const [taskId] = await core.missions.addTasks(
    mission.missionId,
    [
      {
        title: "API",
        description: "",
        allowedPaths: ["b"],
        acceptance: ["x"],
        dependsOn: [],
        assignedAgentId: backend,
      },
    ],
    OWNER,
  );
  const r = await core.runs!.execute(taskId!, OWNER);
  assert.deepEqual([r.status, r.failureCode], ["failed", "auth_required"]);
  const task = await core.missions.getTask(taskId!);
  assert.deepEqual([task.status, task.lastFailureCode], ["failed", "auth_required"]);
});

test("annulation et arrêt d'urgence FR-023 : run annulé, tâche cancelled, aucune tâche running", async (t) => {
  const e = env(t);
  const a = new FakeConnector("fake-a", { kind: "hang" });
  const core = await open(t, e, execution([a], e.repo));
  const { mission, backend } = await seed(core, e);
  const [taskId] = await core.missions.addTasks(
    mission.missionId,
    [
      {
        title: "Long",
        description: "",
        allowedPaths: ["b"],
        acceptance: ["x"],
        dependsOn: [],
        assignedAgentId: backend,
      },
    ],
    OWNER,
  );
  const p = core.runs!.execute(taskId!, OWNER);
  while (!core.runs!.isActive(taskId!)) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(core.runs!.emergencyStop(), [taskId]);
  const outcome = await p;
  assert.equal(outcome.status, "cancelled");
  assert.equal((await core.missions.getTask(taskId!)).status, "cancelled");
  assert.equal(await core.store.prisma.task.count({ where: { status: "running" } }), 0);
});

test("UC-05/AC-04/AC-05 : redémarrage -> interrupted ; reprise native si possible, sinon contexte reconstruit signalé", async (t) => {
  const e = env(t);
  // 1re instance : tâche lancée puis « crash » (fermeture du store sans fin de run).
  const hang = new FakeConnector("fake-a", { kind: "hang", nativeSessionId: "native-42" });
  const first = await NexusCore.open({ dbFile: e.db, execution: execution([hang], e.repo) });
  const { mission, backend, frontend } = await seed(first, e);
  const [t1, t2] = await first.missions.addTasks(
    mission.missionId,
    [
      { title: "A", description: "", allowedPaths: ["a"], acceptance: ["x"], dependsOn: [], assignedAgentId: backend },
      { title: "B", description: "", allowedPaths: ["b"], acceptance: ["x"], dependsOn: [], assignedAgentId: frontend },
    ],
    OWNER,
  );
  void first.runs!.execute(t1!, OWNER).catch(() => {});
  while ((await first.store.prisma.agentRun.count({ where: { taskId: t1!, nativeSessionId: "native-42" } })) === 0)
    await new Promise((r) => setTimeout(r, 5));
  await first.store.close(); // arrêt brutal simulé : le run reste « running » dans la base

  // 2e instance : la réparation au démarrage marque la tâche interrompue (jamais « running » sans processus).
  const native = new FakeConnector("fake-a", { kind: "complete" });
  const noResume = new FakeConnector("fake-b", { kind: "complete" }, { withResume: false });
  const second = await open(t, e, execution([native, noResume], e.repo));
  assert.equal((await second.missions.getTask(t1!)).status, "interrupted");
  const staleRun = await second.store.prisma.agentRun.findFirst({ where: { taskId: t1! } });
  assert.equal(staleRun?.status, "interrupted");

  const resumed = await second.runs!.execute(t1!, OWNER, { resume: true });
  assert.equal(resumed.resumeMode, "native-resume");
  assert.equal(native.requests[0]?.resumedFrom, "native-42");

  // Tâche B : jamais démarrée, son connecteur ne sait pas reprendre -> contexte reconstruit et avertissement.
  await second.missions.transition(t2!, "ready", OWNER);
  await second.missions.transition(t2!, "queued", OWNER);
  await second.missions.transition(t2!, "interrupted", SYSTEM);
  const rec = await second.runs!.execute(t2!, OWNER, { resume: true });
  assert.equal(rec.resumeMode, "reconstructed");
  assert.match(noResume.requests[0]!.req.prompt, /CONTEXTE RECONSTRUIT/);
  const started = (await second.store.loadAggregate(rec.runId))[0]!;
  assert.match(String((started.payload as { warning?: string }).warning), /non idempotentes/);
});

test("FR-025 : export du projet (secrets expurgés), import dans une base vierge, archive altérée refusée", async (t) => {
  const { exportProject, importProject, createPayloadRedactor } = await import("../src/index.ts");
  const e = env(t);
  const secret = "valeur-secrete-de-test-0123456789";
  const core = await open(t, e);
  const { project, mission, backend } = await seed(core, e);
  await core.missions.addTasks(
    mission.missionId,
    [
      {
        title: "API",
        description: `note ${secret}`,
        allowedPaths: ["b"],
        acceptance: ["x"],
        dependsOn: [],
        assignedAgentId: backend,
      },
    ],
    OWNER,
  );
  const archive = await exportProject(
    core.store,
    project.projectId,
    createPayloadRedactor(() => [secret]),
    () => "2026-10-11T00:00:00.000Z",
  );
  assert.ok(archive.events.length >= 5);
  assert.ok(!JSON.stringify(archive).includes(secret), "aucun secret dans l'archive");

  const other = mkdtempSync(join(tmpdir(), "nexus-import-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const target = await NexusCore.open({ dbFile: join(other, "nexus.db") });
  t.after(() => target.close());
  const tampered = structuredClone(archive);
  (tampered.events[0]!.payload as Record<string, unknown>).name = "altéré";
  await assert.rejects(
    importProject(target.store, tampered),
    (err: unknown) => err instanceof DomainError && /Intégrité/.test(err.message),
  );
  const r = await importProject(target.store, archive);
  assert.equal(r.events, archive.events.length);
  assert.equal((await target.projects.get(project.projectId)).name, "Stock");
  assert.equal((await target.missions.listTasks(mission.missionId)).length, 1);
  await assert.rejects(
    importProject(target.store, archive),
    (err: unknown) => err instanceof DomainError && err.code === "conflict",
    "pas de double import",
  );
});
