import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConnector, AgentEvent, AgentTaskRequest, ConnectorManifest, ProbeResult } from "@nexus/contracts";
import {
  DomainError,
  NexusCore,
  OWNER,
  extractJsonObject,
  routeTasks,
  validatePlan,
  type RoutableAgent,
} from "../src/index.ts";
import { FakeConnector } from "./fixtures/fake-connector.ts";

const PLAN = {
  schemaVersion: 1,
  summary: "Application de stock",
  tasks: [
    {
      key: "api",
      title: "API produits",
      description: "CRUD",
      allowedPaths: ["backend"],
      dependsOn: [],
      acceptance: ["tests API verts"],
      requiredCapabilities: ["edit"],
      suggestedRole: "Backend",
      risk: "low",
    },
    {
      key: "ui",
      title: "Écran produits",
      description: "liste",
      allowedPaths: ["frontend"],
      dependsOn: [],
      acceptance: ["E2E vert"],
      requiredCapabilities: ["edit"],
      suggestedRole: "Frontend",
      risk: "low",
    },
    {
      key: "qa",
      title: "Tests",
      description: "intégration",
      allowedPaths: ["tests"],
      dependsOn: ["api", "ui"],
      acceptance: ["suite verte"],
      requiredCapabilities: ["edit"],
      suggestedRole: "Backend",
      risk: "medium",
    },
  ],
};

const agents: RoutableAgent[] = [
  {
    agentId: "a-back",
    role: "Backend",
    connectorId: "x",
    capabilities: ["edit", "chat"],
    permissionMode: "manual",
    available: true,
    relativeCost: 2,
  },
  {
    agentId: "a-front",
    role: "Frontend",
    connectorId: "y",
    capabilities: ["edit"],
    permissionMode: "manual",
    available: true,
  },
  {
    agentId: "a-down",
    role: "Backend",
    connectorId: "z",
    capabilities: ["edit"],
    permissionMode: "manual",
    available: false,
  },
];

test("validatePlan : règles expliquées ; schéma, cycle et capacité manquante refusés", () => {
  const ok = validatePlan(PLAN, agents);
  assert.equal(ok.valid, true);
  assert.deepEqual(
    ok.checks.map((c) => c.rule),
    ["schema", "dag", "unique_keys", "capabilities_available", "risk_review"],
  );
  assert.equal(validatePlan({ ...PLAN, schemaVersion: 2 }, agents).checks[0]?.ok, false);
  const cyclic = structuredClone(PLAN);
  cyclic.tasks[0]!.dependsOn = ["qa"];
  assert.equal(validatePlan(cyclic, agents).checks.find((c) => c.rule === "dag")?.ok, false);
  const traversal = structuredClone(PLAN);
  traversal.tasks[0]!.allowedPaths = ["../../etc"];
  assert.equal(validatePlan(traversal, agents).valid, false, "chemin traversant refusé par le schéma");
  const needsTerminal = structuredClone(PLAN);
  needsTerminal.tasks[0]!.requiredCapabilities = ["terminal"];
  const r = validatePlan(needsTerminal, agents);
  assert.equal(r.valid, false);
  assert.match(String(r.checks.find((c) => c.rule === "capabilities_available")?.detail), /terminal/);
});

test("routage : rôle préféré, agent indisponible écarté, choix manuel prioritaire, raisons fournies", () => {
  const routing = routeTasks(PLAN.tasks as never, agents, { qa: "a-front" });
  assert.deepEqual(
    routing.map((r) => [r.taskKey, r.agentId]),
    [
      ["api", "a-back"],
      ["ui", "a-front"],
      ["qa", "a-front"],
    ],
  );
  assert.ok(routing[0]!.reasons.some((x) => x.includes("Backend")));
  assert.deepEqual(routing[2]!.reasons, ["choix manuel de l'utilisateur"]);
});

test("extractJsonObject : JSON entouré de texte, accolades dans les chaînes, rien d'exécuté", () => {
  assert.deepEqual(extractJsonObject('Voici le plan : {"a":"}{","b":{"c":1}} fin'), { a: "}{", b: { c: 1 } });
  assert.equal(extractJsonObject("pas de json"), undefined);
  assert.equal(extractJsonObject("{ cassé"), undefined);
});

/** Superviseur factice : répond un plan JSON entouré de texte (comme un vrai modèle). */
class PlanningConnector implements AgentConnector {
  readonly manifest: ConnectorManifest = {
    id: "fake-sup",
    version: "t",
    kind: "cli",
    displayName: "sup",
    capabilities: ["chat"],
    supportedPlatforms: ["linux"],
    authModes: ["api-key"],
    maturity: "fixture-only",
  };
  lastRequest: AgentTaskRequest | undefined;
  readonly answer: string;
  constructor(answer: string) {
    this.answer = answer;
  }
  async probe(): Promise<ProbeResult> {
    return { connectorId: "fake-sup", installed: true, probedAt: new Date().toISOString() };
  }
  async *start(req: AgentTaskRequest): AsyncIterable<AgentEvent> {
    this.lastRequest = req;
    yield { kind: "started", taskId: req.taskId, sequence: 1 };
    yield { kind: "output", taskId: req.taskId, sequence: 2, text: this.answer, channel: "message" };
    yield { kind: "completed", taskId: req.taskId, sequence: 3, resultRef: "r" };
  }
}

async function setup(
  t: TestContext,
  governance: "ASSISTED" | "AI_SUPERVISED",
  answer = `Plan proposé :\n${JSON.stringify(PLAN)}\nBonne chance.`,
) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-orch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const sup = new PlanningConnector(answer);
  const back = new FakeConnector("fake-a", { kind: "complete" });
  const front = new FakeConnector("fake-b", { kind: "complete" });
  const core = await NexusCore.open({
    dbFile: join(dir, "nexus.db"),
    execution: {
      connectorFor: (id) => [sup, back, front].find((c) => c.manifest.id === id),
      workspaceFor: async () => repo,
      sandboxAvailable: true,
      requireReview: false,
    },
  });
  t.after(() => core.close());
  const project = await core.projects.create({ name: "Stock", rootPath: repo }, OWNER);
  const team = await core.teams.create(
    { projectId: project.projectId, name: "Équipe", governanceMode: "MANUAL" },
    OWNER,
  );
  const supId = await core.teams.addAgent(
    team.teamId,
    {
      role: "Superviseur",
      displayName: "Sup",
      connectorId: "fake-sup",
      permissionMode: "read-only",
      authMode: "api-key",
      capabilities: ["chat"],
    },
    OWNER,
  );
  await core.teams.addAgent(
    team.teamId,
    {
      role: "Backend",
      displayName: "B",
      connectorId: "fake-a",
      permissionMode: "manual",
      authMode: "api-key",
      capabilities: ["edit", "chat"],
    },
    OWNER,
  );
  await core.teams.addAgent(
    team.teamId,
    {
      role: "Frontend",
      displayName: "F",
      connectorId: "fake-b",
      permissionMode: "manual",
      authMode: "api-key",
      capabilities: ["edit"],
    },
    OWNER,
  );
  await core.teams.setGovernance(team.teamId, governance, supId, OWNER);
  const mission = await core.missions.create(
    { projectId: project.projectId, teamId: team.teamId, title: "Stock", prompt: "Construis une application de stock" },
    OWNER,
  );
  return { core, repo, sup, back, front, mission };
}

test("UC-03 ASSISTED : plan du superviseur (lecture seule) validé, approbation humaine requise, puis DAG exécuté", async (t) => {
  const { core, repo, sup, back, front, mission } = await setup(t, "ASSISTED");
  const proposal = await core.orchestrator!.planWithSupervisor(mission.missionId, repo, OWNER);
  assert.equal(sup.lastRequest?.permissionsPolicyId, "read-only", "la planification n'écrit rien");
  assert.equal(proposal.validation.valid, true);
  assert.equal(proposal.needsApproval, true);
  assert.equal((await core.missions.get(mission.missionId)).status, "awaiting_plan_approval");
  await assert.rejects(
    core.orchestrator!.acceptPlan(mission.missionId, proposal.fingerprint!, { actorType: "agent", actorId: "sup" }),
    (e: unknown) => e instanceof DomainError && e.code === "policy_denied",
  );
  await assert.rejects(
    core.orchestrator!.acceptPlan(mission.missionId, "0".repeat(64), OWNER),
    (e: unknown) => e instanceof DomainError && e.code === "policy_denied",
  );
  const ids = await core.orchestrator!.acceptPlan(mission.missionId, proposal.fingerprint!, OWNER);
  assert.equal(ids.length, 3);
  const decision = await core.orchestrator!.runMission(mission.missionId, OWNER, { maxParallel: 2 });
  assert.equal(decision.done, true);
  assert.equal((await core.missions.get(mission.missionId)).status, "completed");
  assert.ok((await core.missions.listTasks(mission.missionId)).every((x) => x.status === "completed"));
  assert.equal(back.requests.length + front.requests.length, 3);
  // qa dépend de api et ui : il a forcément démarré après eux.
  const qaPrompt = [...back.requests, ...front.requests].find((r) => r.req.prompt.includes("Tests"));
  assert.ok(qaPrompt);
});

test("AI_SUPERVISED : plan sans risque élevé accepté automatiquement ; plan à risque élevé renvoyé à l'humain", async (t) => {
  const auto = await setup(t, "AI_SUPERVISED");
  const p = await auto.core.orchestrator!.planWithSupervisor(auto.mission.missionId, auto.repo, OWNER);
  assert.equal(p.needsApproval, false);
  assert.equal((await auto.core.missions.get(auto.mission.missionId)).status, "active");
  const risky = structuredClone(PLAN);
  risky.tasks[2]!.risk = "high";
  const manual = await setup(t, "AI_SUPERVISED", JSON.stringify(risky));
  const q = await manual.core.orchestrator!.planWithSupervisor(manual.mission.missionId, manual.repo, OWNER);
  assert.equal(q.needsApproval, true);
  assert.equal((await manual.core.missions.get(manual.mission.missionId)).status, "awaiting_plan_approval");
});

test("plan invalide du superviseur : refusé avec explication, aucune tâche créée", async (t) => {
  const { core, repo, mission } = await setup(t, "ASSISTED", "Je ne sais pas faire de JSON aujourd'hui.");
  const p = await core.orchestrator!.planWithSupervisor(mission.missionId, repo, OWNER);
  assert.equal(p.validation.valid, false);
  assert.equal(p.validation.checks[0]?.rule, "schema");
  assert.equal((await core.missions.listTasks(mission.missionId)).length, 0);
  const events = await core.store.loadAggregate(mission.missionId);
  assert.ok(
    events.some((e) => e.eventType === "mission.plan_proposed" && (e.payload as { valid: boolean }).valid === false),
    "proposition refusée journalisée",
  );
});

test("M1 : extractJsonObject(accept) trouve l'objet du verdict malgré un objet ou des accolades avant/après", () => {
  const isVerdict = (v: unknown) => typeof v === "object" && v !== null && "verdict" in v;
  const answer =
    'Exemple {"a":1} puis {pas du json} et enfin {"verdict":"approve","feedback":"ok {x}"} — fin {"autre":2}';
  assert.deepEqual(extractJsonObject(answer, isVerdict), { verdict: "approve", feedback: "ok {x}" });
  // Sans prédicat : comportement inchangé (premier objet seulement).
  assert.deepEqual(extractJsonObject(answer), { a: 1 });
  assert.equal(extractJsonObject("rien {cassé", isVerdict), undefined);
});
