import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AgentEvent,
  AgentTaskRequest,
  ConnectorManifest,
  IpcEnvelope,
  NewDomainEvent,
  SandboxProfile,
  TASK_TRANSITIONS,
  TaskStatus,
  canTransition,
  ipcChannels,
  isIpcChannel,
} from "../src/index.ts";

const now = () => new Date().toISOString();

test("AgentEvent : chaque variante valide est acceptée, champ inconnu refusé", () => {
  const taskId = randomUUID();
  for (const e of [
    { kind: "started", taskId, sequence: 1, nativeSessionId: "s" },
    { kind: "output", taskId, sequence: 2, text: "x", channel: "message" },
    { kind: "tool-request", taskId, sequence: 3, tool: "Bash", payloadRef: "ref" },
    { kind: "usage", taskId, sequence: 4, source: "estimated", usd: 0.1, caveat: "abonnement" },
    { kind: "completed", taskId, sequence: 5, resultRef: "r" },
    { kind: "failed", taskId, sequence: 6, code: "timeout", message: "m" },
  ]) {
    assert.equal(AgentEvent.safeParse(e).success, true, e.kind);
  }
  assert.equal(
    AgentEvent.safeParse({ kind: "output", taskId, sequence: 1, text: "x", channel: "message", secret: "x" }).success,
    false,
  );
  assert.equal(
    AgentEvent.safeParse({ kind: "failed", taskId, sequence: 1, code: "made_up", message: "m" }).success,
    false,
  );
  assert.equal(
    AgentEvent.safeParse({ kind: "output", taskId, sequence: 0, text: "x", channel: "message" }).success,
    false,
  );
});

test("ConnectorManifest : identifiant contraint et maturité obligatoire", () => {
  const ok = {
    id: "claude-cli",
    version: "1",
    kind: "cli",
    displayName: "Claude Code",
    capabilities: ["stream"],
    supportedPlatforms: ["linux"],
    authModes: ["vendor-login"],
    maturity: "beta",
  };
  assert.equal(ConnectorManifest.safeParse(ok).success, true);
  assert.equal(ConnectorManifest.safeParse({ ...ok, id: "../evil" }).success, false);
  const { maturity: _m, ...noMaturity } = ok;
  assert.equal(ConnectorManifest.safeParse(noMaturity).success, false);
});

test("AgentTaskRequest : chemin relatif et timeout hors bornes refusés", () => {
  const base = {
    taskId: randomUUID(),
    projectId: randomUUID(),
    sessionId: randomUUID(),
    agentProfileId: randomUUID(),
    workspacePath: "/tmp/ws",
    prompt: "fais x",
    contextRefs: [],
    permissionsPolicyId: "manual",
    timeoutMs: 60_000,
  };
  assert.equal(AgentTaskRequest.safeParse(base).success, true);
  assert.equal(AgentTaskRequest.safeParse({ ...base, workspacePath: "ws" }).success, false);
  assert.equal(AgentTaskRequest.safeParse({ ...base, workspacePath: "/tmp/\0x" }).success, false);
  assert.equal(AgentTaskRequest.safeParse({ ...base, timeoutMs: 10 }).success, false);
});

test("machine d'états : sessions finies reprises seulement via queued, interrupted repris via queued, jamais running direct", () => {
  for (const s of TaskStatus.options) assert.ok(Array.isArray(TASK_TRANSITIONS[s]), s);
  // Une session terminée ou annulée peut reprendre (nouveau message), uniquement en repassant par la file.
  assert.deepEqual(TASK_TRANSITIONS.completed, ["queued"]);
  assert.deepEqual(TASK_TRANSITIONS.cancelled, ["queued"]);
  assert.equal(canTransition("completed", "running"), false);
  assert.equal(canTransition("interrupted", "queued"), true);
  assert.equal(canTransition("interrupted", "running"), false);
  assert.equal(canTransition("draft", "running"), false);
  for (const s of TaskStatus.options) {
    if (!["completed", "cancelled", "failed"].includes(s)) assert.equal(canTransition(s, "cancelled"), true, s);
  }
});

test("SandboxProfile : D-4 explicite, réseau proxy exige une allowlist", () => {
  const p = {
    workspace: "/w",
    readOnlyBinds: [],
    protectEnvFiles: false,
    network: { mode: "none" },
    env: { NEXUS_TASK_ID: "x" },
    limits: {},
  };
  assert.equal(SandboxProfile.safeParse(p).success, true);
  const { protectEnvFiles: _p, ...missing } = p;
  assert.equal(SandboxProfile.safeParse(missing).success, false, "le choix D-4 doit être explicite");
  assert.equal(SandboxProfile.safeParse({ ...p, network: { mode: "proxy", allow: [] } }).success, false);
  assert.equal(SandboxProfile.safeParse({ ...p, network: { mode: "proxy", allow: ["api.x.com:443"] } }).success, true);
  assert.equal(SandboxProfile.safeParse({ ...p, env: { lower: "x" } }).success, false);
});

test("NewDomainEvent : enveloppe versionnée", () => {
  const ev = {
    eventId: randomUUID(),
    aggregateType: "task",
    aggregateId: randomUUID(),
    aggregateVersion: 1,
    eventType: "task.created",
    payloadSchemaVersion: 1,
    payload: { title: "x" },
    occurredAt: now(),
    correlationId: randomUUID(),
    actorType: "user",
    actorId: "owner",
  };
  assert.equal(NewDomainEvent.safeParse(ev).success, true);
  assert.equal(NewDomainEvent.safeParse({ ...ev, eventType: "Task Created" }).success, false);
});

test("IPC : enveloppe stricte, canaux connus uniquement, pas de prototype pollution", () => {
  assert.equal(IpcEnvelope.safeParse({ requestId: randomUUID(), channel: "app.info", payload: {} }).success, true);
  assert.equal(IpcEnvelope.safeParse({ requestId: "x", channel: "app.info", payload: {} }).success, false);
  // Domaine en camelCase (ex. deployPlan.*) : accepté par l'enveloppe.
  assert.equal(
    IpcEnvelope.safeParse({ requestId: randomUUID(), channel: "deployPlan.get", payload: {} }).success,
    true,
  );
  assert.equal(
    IpcEnvelope.safeParse({ requestId: randomUUID(), channel: "DeployPlan.get", payload: {} }).success,
    false,
  );
  assert.equal(isIpcChannel("app.info"), true);
  assert.equal(isIpcChannel("__proto__"), false);
  assert.equal(isIpcChannel("constructor"), false);
  assert.equal(ipcChannels["projects.create"].request.safeParse({ name: "x", rootPath: "rel" }).success, false);
  assert.equal(ipcChannels["app.info"].request.safeParse({ extra: 1 }).success, false);
});
