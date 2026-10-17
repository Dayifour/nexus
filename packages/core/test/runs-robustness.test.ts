// Robustesse de l'exécution : échecs de préparation (jamais de tâche bloquée ni de boucle de relance), journal en
// échec pendant le flux, arrêt limité à une mission, reprise des tâches interrompues.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusCore, OWNER, SYSTEM, schedule, type ExecutionEnvironment } from "../src/index.ts";
import { FakeConnector } from "./fixtures/fake-connector.ts";

async function setup(t: TestContext, connectors: FakeConnector[], extra: Partial<ExecutionEnvironment> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-runs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const core = await NexusCore.open({
    dbFile: join(dir, "nexus.db"),
    execution: {
      connectorFor: (id) => connectors.find((c) => c.manifest.id === id),
      workspaceFor: async () => repo,
      sandboxAvailable: true,
      requireReview: false,
      ...extra,
    },
  });
  t.after(() => core.close());
  const project = await core.projects.create({ name: "P", rootPath: repo }, OWNER);
  const team = await core.teams.create({ projectId: project.projectId, name: "T", governanceMode: "MANUAL" }, OWNER);
  const agent = async (connectorId: string) =>
    core.teams.addAgent(
      team.teamId,
      {
        role: connectorId,
        displayName: connectorId,
        connectorId,
        permissionMode: "manual",
        authMode: "api-key",
        capabilities: ["edit", "chat"],
      },
      OWNER,
    );
  const mission = async () =>
    (
      await core.missions.create(
        { projectId: project.projectId, teamId: team.teamId, title: "M", prompt: "objectif" },
        OWNER,
      )
    ).missionId;
  const task = async (missionId: string, agentId: string, path = "a") => {
    const [id] = await core.missions.addTasks(
      missionId,
      [
        {
          title: `T ${path}`,
          description: "",
          allowedPaths: [path],
          acceptance: ["x"],
          dependsOn: [],
          assignedAgentId: agentId,
        },
      ],
      OWNER,
    );
    await core.missions.transition(id!, "ready", OWNER);
    return id!;
  };
  return { core, agent, mission, task };
}

test("C2 : connecteur indisponible → tâche en échec non réessayable avec raison, pas de boucle de relance", async (t) => {
  const { core, agent, mission, task } = await setup(t, []);
  const missing = await agent("absent-cli");
  const m = await mission();
  const id = await task(m, missing);
  let starts = 0;
  const errors: string[] = [];
  const decision = await core.orchestrator!.runMission(m, OWNER, {
    promptFor: async () => {
      starts++;
      return "consigne";
    },
    onTaskError: (_id, e) => errors.push(e.message),
  });
  const t1 = await core.missions.getTask(id);
  assert.deepEqual([t1.status, t1.lastFailureCode], ["failed", "connector_unavailable"]);
  assert.equal(starts, 1, "une seule tentative (code non réessayable)");
  assert.match(errors[0] ?? "", /indisponible/);
  assert.equal(decision.done, true);
  const events = await core.store.loadAggregate(id);
  const reason = events.at(-1)!.payload as { reason?: string };
  assert.match(String(reason.reason), /absent-cli/, "raison journalisée");
  assert.equal((await core.missions.get(m)).status, "failed");
});

test("C2 : consigne impossible à construire → tâche en échec, pas laissée `ready`", async (t) => {
  const a = new FakeConnector("fake-a", { kind: "complete" });
  const { core, agent, mission, task } = await setup(t, [a]);
  const m = await mission();
  const id = await task(m, await agent("fake-a"));
  await core.orchestrator!.runMission(m, OWNER, {
    promptFor: async () => {
      throw new Error("contexte illisible");
    },
    onTaskError: () => undefined,
  });
  const t1 = await core.missions.getTask(id);
  assert.deepEqual([t1.status, t1.lastFailureCode], ["failed", "preparation_failed"]);
  assert.equal(a.requests.length, 0);
});

test("H1 : dossier de travail impossible après `queued` → tâche en échec (jamais bloquée en file)", async (t) => {
  const a = new FakeConnector("fake-a", { kind: "complete" });
  const { core, agent, mission, task } = await setup(t, [a], {
    workspaceFor: async () => {
      throw new Error("worktree impossible");
    },
  });
  const m = await mission();
  const id = await task(m, await agent("fake-a"));
  await assert.rejects(core.runs!.execute(id, OWNER), /worktree impossible/);
  const t1 = await core.missions.getTask(id);
  assert.deepEqual([t1.status, t1.lastFailureCode], ["failed", "preparation_failed"]);
  assert.equal(core.runs!.isActive(id), false);
  assert.equal(a.requests.length, 0, "aucun agent lancé");
});

test("H2 : écriture du journal en échec pendant le flux → CLI arrêtée, run clos en échec, tâche en échec", async (t) => {
  const a = new FakeConnector("fake-a", { kind: "hang" });
  const { core, agent, mission, task } = await setup(t, [a]);
  const m = await mission();
  const id = await task(m, await agent("fake-a"));
  const append = core.store.append.bind(core.store);
  let broken = true;
  core.store.append = (async (events, extra) => {
    if (broken && events.some((e) => e.eventType === "run.event")) {
      broken = false;
      throw new Error("disque plein");
    }
    return append(events, extra);
  }) as typeof core.store.append;
  await assert.rejects(core.runs!.execute(id, OWNER), /disque plein/);
  assert.equal(a.requests[0]?.req && a.requests.length, 1);
  const t1 = await core.missions.getTask(id);
  assert.deepEqual([t1.status, t1.lastFailureCode], ["failed", "internal_error"]);
  const run = await core.store.prisma.agentRun.findFirst({ where: { taskId: id } });
  assert.equal(run?.status, "failed", "run.finished écrit au mieux");
  assert.equal(core.runs!.isActive(id), false);
});

test("H3 : l'arrêt d'une mission n'annule que SES exécutions", async (t) => {
  const a = new FakeConnector("fake-a", { kind: "hang" });
  const { core, agent, mission, task } = await setup(t, [a]);
  const ag = await agent("fake-a");
  const m1 = await mission();
  const m2 = await mission();
  const t1 = await task(m1, ag, "a");
  const t2 = await task(m2, ag, "b");
  const stop1 = new AbortController();
  const run1 = core.orchestrator!.runMission(m1, OWNER, { signal: stop1.signal });
  const other = core.runs!.execute(t2, OWNER);
  while (!core.runs!.isActive(t1) || !core.runs!.isActive(t2)) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 30));
  stop1.abort();
  await run1;
  assert.equal((await core.missions.getTask(t1)).status, "cancelled");
  assert.equal(core.runs!.isActive(t2), true, "l'autre mission continue");
  assert.deepEqual(core.runs!.cancelMission(m2), [t2]);
  assert.equal((await other).status, "cancelled");
});

for (const sessionAtEnd of [false, true])
  test(`tâche interrompue (redémarrage) : reprogrammée par l'ordonnanceur, reprise de la session native${sessionAtEnd ? " (identifiant donné à la fin, comme Hermes)" : ""}`, async (t) => {
    const a = new FakeConnector("fake-a", { kind: "complete", nativeSessionId: "n-1", sessionAtEnd });
    const { core, agent, mission, task } = await setup(t, [a]);
    const m = await mission();
    const id = await task(m, await agent("fake-a"));
    await core.runs!.execute(id, OWNER);
    await core.missions.transition(id, "queued", OWNER);
    await core.missions.transition(id, "interrupted", SYSTEM, { reason: "app_restarted" });
    const dag = await core.missions.dagTasks(m);
    assert.deepEqual(
      schedule({ tasks: dag, maxParallel: 2, budgetAvailable: true, isPermitted: () => ({ ok: true }) }).retry,
      [id],
    );
    await core.orchestrator!.runMission(m, OWNER);
    assert.equal((await core.missions.getTask(id)).status, "completed");
    assert.equal(a.requests.at(-1)?.resumedFrom, "n-1", "session native reprise");
  });

test("M5 : sorties regroupées sans perte ni désordre (séquences de run continues)", async (t) => {
  const a = new FakeConnector("fake-a", { kind: "complete" });
  const { core, agent, mission, task } = await setup(t, [a]);
  const m = await mission();
  const id = await task(m, await agent("fake-a"));
  const r = await core.runs!.execute(id, OWNER);
  const events = await core.store.loadAggregate(r.runId);
  assert.deepEqual(
    events.map((e) => e.aggregateVersion),
    events.map((_, i) => i + 1),
  );
  assert.equal(events.at(-1)?.eventType, "run.finished");
});
