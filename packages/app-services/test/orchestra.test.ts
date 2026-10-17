// Orchestre de bout en bout avec de fausses CLI : plan du chef, exécution en parallèle dans une copie commune,
// transmission du travail entre agents, revue avec corrections, synthèse, validation du plan, arrêt.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ipcChannels, type IpcChannel, type IpcPushEvent, type IpcRequest, type IpcResponse } from "@nexus/contracts";
import { GenericCliConnector } from "@nexus/connectors";
import type { Cipher } from "@nexus/secrets";
import { AppServices, createAppHandlers } from "../src/index.ts";

const NODE_DIR = dirname(process.execPath);

// Faux chef : plan (2 tâches, ui après api), revue (corrections demandées tant que l'API n'est pas en « v2 »), synthèse.
const LEAD = `#!/usr/bin/env node
const fs=require('fs');if(process.argv[2]==='--version'){console.log('fakelead 1.0.0');process.exit(0)}
const p=fs.readFileSync(0,'utf8');
if(p.includes('Découpe la mission')){
  const extra=p.includes('Chemin absent')?['docs-absent']:[];
  const t=(key,title,paths,deps)=>({key,title,description:title,allowedPaths:[...paths,...extra],dependsOn:deps,acceptance:[paths[0]+'/done.txt existe'],requiredCapabilities:['edit'],suggestedRole:p.includes('« Fake Bad »')?'Fake Bad':'Fake Work',risk:'low'});
  console.log(JSON.stringify({schemaVersion:1,summary:'API puis interface',tasks:[t('api','API',['api'],[]),t('ui','Interface',['ui'],['api'])]}));
} else if(p.includes('Relis le travail')){
  const isApi=p.includes('Tâche (Fake Work) : API');
  if(p.includes('Revue invalide')) console.log('réponse non structurée');
  else if(p.includes('Chemin absent') && !p.includes('\`\`\`diff')) console.log(JSON.stringify({verdict:'changes',feedback:'diff absent'}));
  else if(isApi && !p.includes('v2')) console.log(JSON.stringify({verdict:'changes',feedback:'Passe la version à v2'}));
  else console.log(JSON.stringify({verdict:'approve',feedback:'OK'}));
} else if(p.includes('Rédige pour l')){ console.log('Synthèse : API et interface livrées.'); }
else console.log('?');
`;
// Faux agent : écrit <chemin>/done.txt ; en correction, passe en v2 ; recopie le travail transmis dans handoff.txt.
const WORK = `#!/usr/bin/env node
const fs=require('fs');if(process.argv[2]==='--version'){console.log('fakework 1.0.0');process.exit(0)}
const p=fs.readFileSync(0,'utf8');
if(p.includes('demande des corrections')){
  const dir=fs.existsSync('api/done.txt')?'api':'ui';fs.writeFileSync(dir+'/done.txt','v2\\n');console.log('Corrigé en v2');process.exit(0);
}
const m=/## Chemins où tu peux écrire\\n- ([^\\n]+)/.exec(p);const dir=m?m[1]:'x';fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(dir+'/done.txt','v1\\n');
if(p.includes('Travail déjà fait par l')) fs.writeFileSync(dir+'/handoff.txt',p.slice(p.indexOf('Travail déjà fait')));
console.log('Compte rendu : '+dir+'/done.txt créé');
`;

function cipher(): Cipher {
  const key = randomBytes(32);
  return {
    backend: "test",
    isSecure: true,
    encrypt: (p) => {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, c.getAuthTag?.() ?? Buffer.alloc(0), c.update(p, "utf8"), c.final()]);
    },
    decrypt: () => "",
  };
}

async function setup(t: TestContext, opts: { sandbox?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-orch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const d of [repo, home, bin]) mkdirSync(d);
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "/usr/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "# Projet\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(bin, "fakelead"), LEAD);
  writeFileSync(join(bin, "fakework"), WORK);
  chmodSync(join(bin, "fakelead"), 0o755);
  chmodSync(join(bin, "fakework"), 0o755);
  const svcRef: { svc?: AppServices } = {};
  const mk = (id: string, name: string, binName: string, readOnly = true) =>
    new GenericCliConnector(
      {
        signature: {
          connectorId: id,
          displayName: name,
          binaryNames: [binName],
          versionArgs: ["--version"],
          versionPattern: /(\d+\.\d+\.\d+)/,
          probeTimeoutMs: 3000,
          agent: true,
        },
        args: [],
        promptVia: "stdin",
        // Fausses CLI : la lecture seule est respectée (le faux chef n'écrit rien).
        ...(readOnly && { readOnlyArgs: [] }),
      },
      {
        probeContext: { pathEnv: `${bin}:${NODE_DIR}:/usr/bin:/bin` },
        baseEnv: { PATH: `${NODE_DIR}:/usr/bin:/bin` },
        runner: (o, ctx) => svcRef.svc!.runFor(o, ctx),
      },
    );
  writeFileSync(
    join(bin, "fakebad"),
    '#!/bin/sh\n[ "$1" = --version ] && { echo fakebad 1.0.0; exit 0; }\necho "Erreur : non connecté" >&2\nexit 41\n',
  );
  chmodSync(join(bin, "fakebad"), 0o755);
  const bad = mk("fake-bad", "Fake Bad", "fakebad", false);
  await bad.probe();
  const lead = mk("fake-lead", "Fake Lead", "fakelead");
  const work = mk("fake-work", "Fake Work", "fakework");
  await lead.probe();
  await work.probe();
  const events: IpcPushEvent[] = [];
  const open = async () => {
    const svc = await AppServices.open({
      userDataDir: join(root, "ud"),
      cipher: cipher(),
      pathEnv: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      home,
      sandboxCapabilities: {
        platform: "linux",
        bwrap: Boolean(opts.sandbox),
        pidNamespace: true,
        seccomp: Boolean(opts.sandbox),
        cgroups: false,
        reasons: ["test"],
      },
      extraConnectors: [lead, work, bad],
      push: (e) => events.push(e),
    });
    svcRef.svc = svc;
    const handlers = createAppHandlers(svc, {
      appVersion: "0",
      electron: "0",
      node: process.versions.node,
      platform: "linux",
    });
    const call = async <C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>> => {
      const spec = ipcChannels[channel];
      const h = handlers[channel] as (r: unknown) => unknown;
      return spec.response.parse(await h(spec.request.parse(payload))) as IpcResponse<C>;
    };
    return { svc, call };
  };
  let current = await open();
  t.after(() => current.svc.close());
  /** Fermeture puis réouverture de l'application (même dossier de données). */
  const reopen = async () => {
    await current.svc.close();
    current = await open();
    return current;
  };
  return { repo, root, call: current.call, svc: current.svc, events, reopen };
}

async function until(pred: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("délai dépassé");
}

test("Orchestre autonome : plan, parallèle, transmission entre agents, revue avec corrections, synthèse", async (t) => {
  const { repo, call, events } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const { missionId } = await call("orchestra.start", {
    projectId: p.projectId,
    goal: "Construire une API puis son interface",
    leadConnectorId: "fake-lead",
    memberConnectorIds: ["fake-work"],
    mode: "supervised",
    autonomy: "full",
  });
  await until(async () => ["done", "failed"].includes((await call("orchestra.get", { missionId })).phase), 60_000);
  const d = await call("orchestra.get", { missionId });
  const apiEv =
    d.phase === "done"
      ? []
      : (await call("tasks.events", { taskId: d.tasks.find((x) => x.key === "api")!.taskId, afterSequence: 0 })).map(
          (e) =>
            e.event.kind === "output"
              ? e.event.text
              : e.event.kind === "failed"
                ? `FAILED ${e.event.message}`
                : e.event.kind,
        );
  assert.equal(
    d.phase,
    "done",
    JSON.stringify({
      apiEv,
      tasks: d.tasks.map((x) => [x.key, x.status]),
      feed: d.feed.map((f) => `${f.kind}:${f.text.slice(0, 80)}`),
    }),
  );
  assert.deepEqual(d.tasks.map((x) => [x.key, x.status]).sort(), [
    ["api", "completed"],
    ["ui", "completed"],
  ]);
  assert.equal(d.tasks.find((x) => x.key === "api")!.reviewRounds, 1, "une correction demandée par le chef");
  assert.ok(d.members.some((m) => m.lead && m.connectorId === "fake-lead"));
  const ws = d.workspacePath!;
  assert.notEqual(ws, repo, "copie de travail commune isolée");
  assert.equal(readFileSync(join(ws, "api", "done.txt"), "utf8"), "v2\n", "correction appliquée");
  assert.match(
    readFileSync(join(ws, "ui", "handoff.txt"), "utf8"),
    /api\/done\.txt créé|Corrigé en v2/,
    "l'interface a reçu le travail de l'API",
  );
  assert.equal(existsSync(join(repo, "api")), false, "dépôt principal intact");
  assert.match(d.finalSummary ?? "", /API et interface livrées/);
  const kinds = new Set(d.feed.map((f) => f.kind));
  for (const k of ["plan", "assign", "start", "handoff", "review", "summary"])
    assert.ok(kinds.has(k as never), `fil : ${k}`);
  assert.ok(events.some((e) => e.type === "orchestra" && e.missionId === missionId));
  const log = execFileSync("git", ["-C", ws, "log", "--format=%s"], { encoding: "utf8" });
  assert.match(log, /API/);
  assert.match(log, /Interface/);
  assert.deepEqual(
    (await call("orchestra.list", { projectId: p.projectId })).map((x) => x.missionId),
    [missionId],
  );
});

test("Orchestre : plan à valider par l'utilisateur, message au chef, arrêt", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const { missionId } = await call("orchestra.start", {
    projectId: p.projectId,
    goal: "Objectif à valider",
    leadConnectorId: "fake-lead",
    memberConnectorIds: ["fake-work"],
    mode: "supervised",
    autonomy: "approve-plan",
  });
  await until(async () => (await call("orchestra.get", { missionId })).phase === "awaiting_approval");
  assert.equal((await call("orchestra.get", { missionId })).tasks.length, 0, "rien ne s'exécute avant validation");
  await call("orchestra.message", { missionId, text: "Utilise TypeScript" });
  await call("orchestra.approvePlan", { missionId });
  await until(async () => ["done", "failed"].includes((await call("orchestra.get", { missionId })).phase), 60_000);
  const d = await call("orchestra.get", { missionId });
  assert.equal(d.phase, "done");
  assert.ok(d.feed.some((f) => f.kind === "message" && f.from === "Vous"));

  const second = await call("orchestra.start", {
    projectId: p.projectId,
    goal: "À arrêter",
    leadConnectorId: "fake-lead",
    memberConnectorIds: ["fake-work"],
    mode: "supervised",
    autonomy: "approve-plan",
  });
  await until(async () => (await call("orchestra.get", { missionId: second.missionId })).phase === "awaiting_approval");
  await call("orchestra.stop", { missionId: second.missionId });
  await until(async () =>
    ["stopped", "failed"].includes((await call("orchestra.get", { missionId: second.missionId })).phase),
  );
});

test("bus de l'équipe : serveur MCP réel (stdio JSON-RPC) → socket → messages, question au chef, jeton requis", async (t) => {
  const { spawn } = await import("node:child_process");
  const { TeamBus } = await import("../src/team-bus.ts");
  const dir = mkdtempSync(join(tmpdir(), "nexus-bus-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const bus = new TeamBus({
    status: async (id) => `statut pour ${id.role}`,
    send: async (id, to, text) => (sent.push(`${id.role}->${to}:${text}`), "ok"),
    read: async () => "Aucun nouveau message.",
    ask: async (_id, q) => `réponse du chef à « ${q} »`,
  });
  await bus.start(dir);
  t.after(() => bus.close());
  const spec = bus.register({ missionId: "m", taskId: "t1", role: "Codex CLI" })!;
  const child = spawn(spec.command, spec.args, {
    env: { ...spec.env, PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill());
  let buf = "";
  const pending = new Map<number, (v: any) => void>();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(m.id)?.(m);
    }
  });
  let n = 0;
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const id = ++n;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(init.result.serverInfo.name, "nexus-team");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools = await rpc("tools/list");
  assert.deepEqual(
    tools.result.tools.map((x: { name: string }) => x.name),
    ["team_status", "send_message", "read_messages", "ask_lead"],
  );
  const status = await rpc("tools/call", { name: "team_status", arguments: {} });
  assert.equal(status.result.content[0].text, "statut pour Codex CLI");
  await rpc("tools/call", { name: "send_message", arguments: { to: "Claude Code", text: "L'API expose GET /items" } });
  assert.deepEqual(sent, ["Codex CLI->Claude Code:L'API expose GET /items"]);
  const ask = await rpc("tools/call", { name: "ask_lead", arguments: { question: "Quel port ?" } });
  assert.equal(ask.result.content[0].text, "réponse du chef à « Quel port ? »");
  // Jeton révoqué : refus.
  bus.revokeMission("m");
  const denied = await rpc("tools/call", { name: "read_messages", arguments: {} });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /jeton/);
});

test("Orchestre : fichiers modifiés par l'équipe puis intégration au projet (merge)", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const { missionId } = await call("orchestra.start", {
    projectId: p.projectId,
    goal: "API et interface",
    leadConnectorId: "fake-lead",
    memberConnectorIds: ["fake-work"],
    mode: "supervised",
    autonomy: "full",
  });
  await until(async () => ["done", "failed"].includes((await call("orchestra.get", { missionId })).phase), 60_000);
  const changes = await call("orchestra.changes", { missionId });
  assert.deepEqual(
    changes
      .map((c) => c.path)
      .filter((x) => x.endsWith("done.txt"))
      .sort(),
    ["api/done.txt", "ui/done.txt"],
  );
  assert.equal(existsSync(join(repo, "api", "done.txt")), false);
  const ws = (await call("orchestra.get", { missionId })).workspacePath!;
  assert.ok(existsSync(ws));
  await call("orchestra.merge", { missionId });
  assert.equal(readFileSync(join(repo, "api", "done.txt"), "utf8"), "v2\n", "travail intégré dans le projet");
  // M9 : travail intégré → copie de travail et branche (fusionnée) supprimées.
  assert.equal(existsSync(ws), false, "copie de travail supprimée après intégration");
  const branches = execFileSync("git", ["-C", repo, "branch", "--list", "nexus/*"], { encoding: "utf8" });
  assert.equal(branches.trim(), "", "branche fusionnée supprimée");
  assert.equal((await call("orchestra.get", { missionId })).workspacePath, undefined);
});

test("Orchestre : agent défaillant → raison affichée, tâches réattribuées à un autre agent, objectif atteint", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const { missionId } = await call("orchestra.start", {
    projectId: p.projectId,
    goal: "Avec un agent en panne",
    leadConnectorId: "fake-lead",
    memberConnectorIds: ["fake-bad", "fake-work"],
    mode: "supervised",
    autonomy: "full",
  });
  await until(async () => ["done", "failed"].includes((await call("orchestra.get", { missionId })).phase), 90_000);
  const d = await call("orchestra.get", { missionId });
  assert.equal(d.phase, "done", JSON.stringify(d.feed.map((f) => f.kind + ":" + f.text.slice(0, 120))));
  const work = d.members.find((m) => m.connectorId === "fake-work")!;
  assert.ok(
    d.tasks.every((x) => x.status === "completed" && x.agentId === work.agentId),
    "toutes les tâches finies par l'agent valide",
  );
  assert.ok(
    d.feed.some(
      (f) => f.kind === "assign" && /a échoué avec Fake Bad .*non connecté.*confiée à Fake Work/.test(f.text),
    ),
    "raison et réattribution dans le fil",
  );
});

test("Orchestre : une revue invalide échoue la tâche, sans approbation implicite", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const { missionId } = await call("orchestra.start", {
    projectId: p.projectId,
    goal: "Revue invalide",
    leadConnectorId: "fake-lead",
    memberConnectorIds: ["fake-work"],
    mode: "supervised",
    autonomy: "full",
  });
  await until(async () => ["done", "failed"].includes((await call("orchestra.get", { missionId })).phase), 60_000);
  const d = await call("orchestra.get", { missionId });
  assert.equal(d.phase, "failed");
  assert.ok(d.tasks.some((task) => task.status === "failed"));
  assert.ok(!d.feed.some((entry) => entry.kind === "review" && entry.verdict === "approved"));
});

test("H4 : orchestre interrompu par la fermeture → « arrêté » au redémarrage, arrêt sans erreur, relance sur la même copie", async (t) => {
  const { repo, call, reopen } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const { missionId } = await call("orchestra.start", {
    projectId: p.projectId,
    goal: "Interrompu puis relancé",
    leadConnectorId: "fake-lead",
    memberConnectorIds: ["fake-work"],
    mode: "supervised",
    autonomy: "approve-plan",
  });
  await until(async () => (await call("orchestra.get", { missionId })).phase === "awaiting_approval");
  const ws = (await call("orchestra.get", { missionId })).workspacePath!;
  const next = await reopen();
  const d = await next.call("orchestra.get", { missionId });
  assert.equal(d.phase, "stopped");
  assert.ok(
    d.feed.some((f) => /interrompu/i.test(f.text)),
    "raison affichée",
  );
  assert.ok(
    d.feed.some((f) => f.kind === "plan"),
    "fil conservé (JSONL)",
  );
  await next.call("orchestra.stop", { missionId }); // ne lève pas
  await next.call("orchestra.resume", { missionId });
  await until(async () => (await next.call("orchestra.get", { missionId })).phase === "awaiting_approval");
  await next.call("orchestra.approvePlan", { missionId });
  await until(async () => ["done", "failed"].includes((await next.call("orchestra.get", { missionId })).phase), 60_000);
  const done = await next.call("orchestra.get", { missionId });
  assert.equal(done.phase, "done");
  assert.equal(done.workspacePath, ws, "même copie de travail");
  assert.equal(readFileSync(join(ws, "api", "done.txt"), "utf8"), "v2\n");
});

test("M2 : un chemin autorisé jamais créé n'empêche pas le diff de la revue", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const { missionId } = await call("orchestra.start", {
    projectId: p.projectId,
    goal: "Chemin absent dans le plan",
    leadConnectorId: "fake-lead",
    memberConnectorIds: ["fake-work"],
    mode: "supervised",
    autonomy: "full",
  });
  await until(async () => ["done", "failed"].includes((await call("orchestra.get", { missionId })).phase), 60_000);
  const d = await call("orchestra.get", { missionId });
  assert.equal(d.phase, "done", JSON.stringify(d.feed.map((f) => `${f.kind}:${f.text.slice(0, 80)}`)));
});

test("start : sandbox indisponible refusée côté serveur ; chef sans mode lecture seule refusé", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const base = {
    projectId: p.projectId,
    goal: "x",
    leadConnectorId: "fake-lead",
    memberConnectorIds: ["fake-work"],
    mode: "sandboxed" as const,
    autonomy: "full" as const,
  };
  await assert.rejects(call("orchestra.start", base), /sandbox/i);
  await assert.rejects(
    call("orchestra.start", { ...base, mode: "supervised", leadConnectorId: "fake-bad" }),
    /lecture seule/,
  );
});

test("M7 : mode d'exécution choisi par tâche, même si deux tâches partagent un dossier", async (t) => {
  const { repo, call, svc } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const { core } = svc;
  const team = await core.teams.create(
    { projectId: p.projectId, name: "T", governanceMode: "MANUAL" },
    { actorType: "user", actorId: "owner" },
  );
  const owner = { actorType: "user" as const, actorId: "owner" };
  const agent = (permissionMode: "sandbox-auto" | "manual") =>
    core.teams.addAgent(
      team.teamId,
      {
        role: permissionMode,
        displayName: "W",
        connectorId: "fake-work",
        permissionMode,
        authMode: "vendor-login",
        capabilities: ["edit"],
      },
      owner,
    );
  const sandboxed = await agent("sandbox-auto");
  const manual = await agent("manual");
  const mission = await core.missions.create(
    { projectId: p.projectId, teamId: team.teamId, title: "m", prompt: "m" },
    owner,
  );
  const [tS, tM] = await core.missions.addTasks(
    mission.missionId,
    [
      {
        title: "s",
        description: "",
        allowedPaths: ["s"],
        acceptance: ["x"],
        dependsOn: [],
        assignedAgentId: sandboxed,
      },
      { title: "m", description: "", allowedPaths: ["m"], acceptance: ["x"], dependsOn: [], assignedAgentId: manual },
    ],
    owner,
  );
  svc.setMissionWorkspace(mission.missionId, repo);
  const ws = await svc.workspaceFor(tS!);
  assert.equal(await svc.workspaceFor(tM!), ws, "dossier partagé");
  const run = (taskId: string) =>
    svc.runFor({ file: "/bin/true", args: [], cwd: ws, env: {}, timeoutMs: 5000 }, { taskId });
  assert.equal(
    (await run(tS!)).spawnError,
    "sandbox_unavailable",
    "la tâche en sandbox n'est jamais lancée hors sandbox",
  );
  assert.equal((await run(tM!)).exitCode, 0);
});

test("bus de l'équipe : tous les agents CLI le reçoivent (Codex et Hermes compris)", async () => {
  const { BUS_CONNECTORS } = await import("../src/orchestra.ts");
  assert.deepEqual([...BUS_CONNECTORS].sort(), [
    "claude-cli",
    "codex-cli",
    "gemini-cli",
    "hermes-cli",
    "opencode-cli",
    "qwen-cli",
  ]);
});
