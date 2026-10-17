// Espace de travail façon IDE : projets, fichiers, terminaux PTY réels, sessions simples (3 modes), Git, réglages.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ipcChannels, type IpcChannel, type IpcPushEvent, type IpcRequest, type IpcResponse } from "@nexus/contracts";
import { GenericCliConnector } from "@nexus/connectors";
import { probeSandbox, sandboxUsable, type SandboxCapabilities } from "@nexus/sandbox";
import type { Cipher } from "@nexus/secrets";
import { AppServices, createAppHandlers, ExposedError } from "../src/index.ts";

const NODE_DIR = dirname(process.execPath);

function cipher(): Cipher {
  const key = randomBytes(32);
  return {
    backend: "test-aes-gcm",
    isSecure: true,
    encrypt: (p) => {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const b = Buffer.concat([c.update(p, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), b]);
    },
    decrypt: (b) => {
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    },
  };
}

// Fausse CLI agent : écrit la consigne reçue dans agent-output.txt (dans SON dossier de travail) et tente une
// connexion réseau directe (doit échouer en sandbox).
const FAKE_AGENT = `#!/usr/bin/env node
const fs=require('fs');if(process.argv[2]==='--version'){console.log('fakeagent 1.2.3');process.exit(0)}
const p=fs.readFileSync(0,'utf8');fs.writeFileSync('agent-output.txt',p);
const net=require('net');const s=net.connect(443,'1.1.1.1');
s.on('connect',()=>{console.log('NET:CONNECTED');s.destroy();done()}).on('error',e=>{console.log('NET:'+e.code);done()});
function done(){console.log('HTTPS_PROXY='+(process.env.HTTPS_PROXY||''));process.exit(0)}
setTimeout(()=>{console.log('NET:TIMEOUT');done()},3000);
`;

// Fausse TUI d'agent : signale son état via le fichier de hooks ($NEXUS_HOOK_FILE), comme les hooks de Claude.
const FAKE_TUI = `#!/usr/bin/env node
const fs=require('fs');if(process.argv[2]==='--version'){console.log('faketui 2.0.0');process.exit(0)}
const hook=s=>fs.appendFileSync(process.env.NEXUS_HOOK_FILE,s+'\\n');
hook('working');console.log('PROMPT:'+process.argv.slice(2).join(' '));console.log('CWD:'+process.cwd());
const net=require('net');const s=net.connect(443,'1.1.1.1');
s.on('connect',()=>{console.log('NET:CONNECTED');s.destroy();ready()}).on('error',e=>{console.log('NET:'+e.code);ready()});
let r=false;function ready(){if(r)return;r=true;
if(process.env.HTTPS_PROXY){const u=new URL(process.env.HTTPS_PROXY);const c=net.connect(+u.port,u.hostname,()=>c.write('CONNECT interdit.invalid:443 HTTP/1.1\\r\\nHost: interdit.invalid:443\\r\\n\\r\\n'));
c.on('data',d=>{console.log('PROXY:'+d.toString().split('\\r\\n')[0]);c.destroy();hook('idle')}).on('error',e=>{console.log('PROXY:'+e.code);hook('idle')})}else hook('idle')}setTimeout(ready,3000);
process.stdin.setEncoding('utf8');let buf='';
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.search(/[\\r\\n]/))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l)continue;
if(l==='bye'){process.exit(0)}if(!fs.existsSync('tui-output.txt'))fs.writeFileSync('tui-output.txt',l);hook('working');console.log('GOT:'+l);hook('needs_input')}});
`;

// Fausse IA qui pilote : relit les propositions du prompt et les renvoie avec un avis (format attendu par Nexus).
const FAKE_LEAD = `#!/usr/bin/env node
const fs=require('fs');if(process.argv[2]==='--version'){console.log('fakelead 1.0.0');process.exit(0)}
const p=fs.readFileSync(0,'utf8');const a=p.indexOf('Propositions de départ (catalogue) :')+36;const b=p.indexOf('Fournisseurs autorisés');
const props=JSON.parse(p.slice(a,b)).slice(0,1).map(x=>({...x,id:'ia-choix',title:'Choix de l IA'}));
console.log('Analyse terminée.');console.log('\`\`\`json');console.log(JSON.stringify({advice:'Commencez par la proposition gérée.',proposals:props}));console.log('\`\`\`');
`;

async function setup(
  t: TestContext,
  opts: { sandbox?: SandboxCapabilities; confirm?: (m: string, d: string) => Promise<boolean> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "nexus-ws-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const trashDir = join(root, "trash");
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(trashDir);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "/usr/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# Stock\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "inventory.ts"), "export const stock = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "fakeagent"), FAKE_AGENT);
  chmodSync(join(bin, "fakeagent"), 0o755);
  const fake = new GenericCliConnector(
    {
      signature: {
        connectorId: "fake-agent",
        displayName: "Fake",
        binaryNames: ["fakeagent"],
        versionArgs: ["--version"],
        versionPattern: /(\d+\.\d+\.\d+)/,
        probeTimeoutMs: 3000,
        agent: true,
      },
      args: [],
      promptVia: "stdin",
    },
    {
      probeContext: { pathEnv: `${bin}:${NODE_DIR}:/usr/bin:/bin` },
      baseEnv: { PATH: `${NODE_DIR}:/usr/bin:/bin` },
      runner: (o) => svcRef.svc!.runFor(o),
    },
  );
  await fake.probe();
  writeFileSync(join(bin, "fakelead"), FAKE_LEAD);
  chmodSync(join(bin, "fakelead"), 0o755);
  const lead = new GenericCliConnector(
    {
      signature: {
        connectorId: "fake-lead",
        displayName: "Fake Lead",
        binaryNames: ["fakelead"],
        versionArgs: ["--version"],
        versionPattern: /(\d+\.\d+\.\d+)/,
        probeTimeoutMs: 3000,
        agent: true,
      },
      args: [],
      promptVia: "stdin",
      // Le faux chef respecte la lecture seule (il n'écrit rien).
      readOnlyArgs: [],
    },
    { probeContext: { pathEnv: `${bin}:${NODE_DIR}:/usr/bin:/bin` }, baseEnv: { PATH: `${NODE_DIR}:/usr/bin:/bin` } },
  );
  writeFileSync(join(bin, "faketui"), FAKE_TUI);
  chmodSync(join(bin, "faketui"), 0o755);
  const tui = new GenericCliConnector(
    {
      signature: {
        connectorId: "fake-tui",
        displayName: "Fake TUI",
        binaryNames: ["faketui"],
        versionArgs: ["--version"],
        versionPattern: /(\d+\.\d+\.\d+)/,
        probeTimeoutMs: 3000,
        agent: true,
      },
      args: [],
      promptVia: "stdin",
    },
    {
      probeContext: { pathEnv: `${bin}:${NODE_DIR}:/usr/bin:/bin` },
      baseEnv: { PATH: `${NODE_DIR}:/usr/bin:/bin` },
      runner: (o) => svcRef.svc!.runFor(o),
    },
  );
  const svcRef: { svc?: AppServices } = {};
  const events: IpcPushEvent[] = [];
  const svc = await AppServices.open({
    userDataDir: join(root, "userdata"),
    cipher: cipher(),
    pathEnv: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    home,
    sandboxCapabilities: opts.sandbox ?? {
      platform: "linux",
      bwrap: false,
      pidNamespace: true,
      seccomp: false,
      cgroups: false,
      reasons: ["test"],
    },
    extraConnectors: [fake, tui, lead],
    push: (e) => events.push(e),
    pickFolder: async () => repo,
    ...(opts.confirm && { confirm: opts.confirm }),
    trash: async (p) => renameSync(p, join(trashDir, basename(p))),
    userEnv: { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin`, SHELL: "/bin/bash" },
  });
  svcRef.svc = svc;
  t.after(() => svc.close());
  const handlers = createAppHandlers(svc, {
    appVersion: "0.1.0",
    electron: "44",
    node: process.versions.node,
    platform: "linux",
  });
  const call = async <C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>> => {
    const spec = ipcChannels[channel];
    const h = handlers[channel] as ((r: unknown) => unknown) | undefined;
    assert.ok(h, `handler manquant : ${channel}`);
    return spec.response.parse(await h(spec.request.parse(payload))) as IpcResponse<C>;
  };
  return { root, repo, trashDir, svc, call, events };
}

async function until(pred: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("délai dépassé");
}

test("projets : ouverture par chemin (glisser-déposer / dialogue), idempotente, projets récents", async (t) => {
  const { repo, call } = await setup(t);
  const picked = await call("app.pickFolder", {});
  assert.equal(picked.path, repo);
  const a = await call("projects.open", { rootPath: repo });
  const b = await call("projects.open", { rootPath: repo });
  assert.equal(a.projectId, b.projectId, "rouvrir le même dossier ne crée pas de doublon");
  assert.equal(a.name, "repo");
  assert.deepEqual(
    (await call("projects.recent", {})).map((p) => p.projectId),
    [a.projectId],
  );
  await assert.rejects(
    call("projects.open", { rootPath: join(repo, "README.md") }),
    (e: unknown) => e instanceof ExposedError && e.code === "invalid_request",
  );
});

test("fichiers : créer, renommer, supprimer vers la corbeille, recherche floue, surveillance en direct", async (t) => {
  const { repo, trashDir, call, events } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  await call("files.watch", { projectId: p.projectId });
  await call("files.create", { projectId: p.projectId, path: "src/routes/products.ts", kind: "file" });
  await call("files.create", { projectId: p.projectId, path: "docs", kind: "directory" });
  await assert.rejects(
    call("files.create", { projectId: p.projectId, path: "README.md", kind: "file" }),
    (e: unknown) => e instanceof ExposedError && e.code === "conflict",
  );
  await call("files.rename", { projectId: p.projectId, from: "src/routes/products.ts", to: "src/routes/catalog.ts" });
  assert.ok(existsSync(join(repo, "src", "routes", "catalog.ts")));
  await call("files.delete", { projectId: p.projectId, path: "docs" });
  assert.ok(existsSync(join(trashDir, "docs")), "suppression récupérable (corbeille)");
  const found = await call("files.search", { projectId: p.projectId, query: "catlg", limit: 10 });
  assert.equal(found[0]?.path, "src/routes/catalog.ts");
  await until(() => events.some((e) => e.type === "fs" && e.changes.some((c) => c.path.startsWith("src/routes"))));
  assert.throws(() =>
    ipcChannels["files.rename"].request.parse({ projectId: p.projectId, from: "README.md", to: "../evil" }),
  );
});

test("terminal PTY réel : saisie, sortie poussée, redimensionnement, fermeture", async (t) => {
  const { repo, call, events } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const term = await call("terminal.create", { projectId: p.projectId, cols: 100, rows: 30 });
  assert.equal(term.cwd, repo);
  await call("terminal.write", { terminalId: term.terminalId, data: "echo NEXUS_PTY_$((20+22)); pwd\r" });
  await until(() =>
    events.some((e) => e.type === "terminal" && e.terminalId === term.terminalId && e.data.includes("NEXUS_PTY_42")),
  );
  await call("terminal.resize", { terminalId: term.terminalId, cols: 120, rows: 40 });
  await call("terminal.write", { terminalId: term.terminalId, data: "stty size\r" });
  await until(() =>
    events.some((e) => e.type === "terminal" && e.terminalId === term.terminalId && e.data.includes("40 120")),
  );
  await call("terminal.write", { terminalId: term.terminalId, data: "exit\r" });
  await until(() => events.some((e) => e.type === "terminal-exit" && e.terminalId === term.terminalId));
  await assert.rejects(
    call("terminal.write", { terminalId: term.terminalId, data: "x" }),
    (e: unknown) => e instanceof ExposedError && e.code === "not_found",
  );
});

test("session AUTONOME : l'agent agit directement dans le projet, terminée sans étape de revue", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const s = await call("sessions.start", {
    projectId: p.projectId,
    connectorId: "fake-agent",
    prompt: "Ajoute un module de stock",
    mode: "autonomous",
  });
  await until(async () => (await call("sessions.list", { projectId: p.projectId }))[0]?.status === "completed");
  assert.equal(
    readFileSync(join(repo, "agent-output.txt"), "utf8"),
    "Ajoute un module de stock",
    "écrit directement dans le projet",
  );
  const [listed] = await call("sessions.list", { projectId: p.projectId });
  assert.deepEqual([listed!.taskId, listed!.mode, listed!.workspacePath], [s.taskId, "autonomous", repo]);
});

test("session AVEC VALIDATION : copie isolée, revue, relance avec une nouvelle consigne", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const s = await call("sessions.start", {
    projectId: p.projectId,
    connectorId: "fake-agent",
    prompt: "Première consigne",
    mode: "supervised",
  });
  await until(async () => (await call("sessions.list", { projectId: p.projectId }))[0]?.status === "waiting_review");
  const [listed] = await call("sessions.list", { projectId: p.projectId });
  assert.notEqual(listed!.workspacePath, repo, "travail dans un worktree");
  assert.equal(existsSync(join(repo, "agent-output.txt")), false, "projet principal intact");
  assert.equal(readFileSync(join(listed!.workspacePath!, "agent-output.txt"), "utf8"), "Première consigne");
  await call("sessions.followUp", { taskId: s.taskId, prompt: "Corrige le nom de la fonction" });
  // L'agent factice ne sait pas reprendre sa session native : la nouvelle consigne arrive précédée d'un contexte
  // reconstruit, signalé comme tel (AC-05).
  await until(async () =>
    readFileSync(join(listed!.workspacePath!, "agent-output.txt"), "utf8").endsWith("Corrige le nom de la fonction"),
  );
  assert.match(readFileSync(join(listed!.workspacePath!, "agent-output.txt"), "utf8"), /CONTEXTE RECONSTRUIT/);
  await until(async () => (await call("sessions.list", { projectId: p.projectId }))[0]?.status === "waiting_review");
  const diff = await call("git.fileDiff", { projectId: p.projectId, path: "agent-output.txt", taskId: s.taskId });
  assert.equal(diff.original, "", "fichier nouveau");
  assert.ok(diff.modified.endsWith("Corrige le nom de la fonction"));
});

test("Git utilisateur : commit dans le dépôt, diff d'un fichier modifié", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  writeFileSync(join(repo, "src", "inventory.ts"), "export const stock = 2;\n");
  const diff = await call("git.fileDiff", { projectId: p.projectId, path: "src/inventory.ts" });
  assert.deepEqual(diff, { original: "export const stock = 1;\n", modified: "export const stock = 2;\n" });
  const c = await call("git.commit", { projectId: p.projectId, message: "Stock à 2" });
  assert.equal(c.branch, "main");
  assert.match(c.commit, /^[0-9a-f]{40}$/);
  assert.equal((await call("git.status", { projectId: p.projectId })).files.length, 0);
});

test("réglages : persistés, connecteur API ajouté à chaud, valeurs invalides refusées", async (t) => {
  const { call, svc } = await setup(t);
  const s = await call("settings.get", {});
  assert.equal(s.defaultMode, "supervised");
  await call("secrets.set", {
    ref: "openai:main",
    label: "OpenAI",
    purposes: ["connector:openai-api"],
    value: "fixture-value-not-real-123456",
  });
  await call("settings.set", {
    ...s,
    theme: "light",
    apiConnectors: [{ provider: "openai", model: "fixture-model", secretRef: "openai:main" }],
  });
  assert.equal((await call("settings.get", {})).theme, "light");
  assert.ok(svc.registry.get("openai-api"), "connecteur API disponible sans redémarrage");
  await call("settings.set", { ...s, apiConnectors: [] });
  assert.equal(svc.registry.get("openai-api"), undefined, "retiré à chaud");
  assert.throws(() => ipcChannels["settings.set"].request.parse({ ...s, sandboxExtraAllow: ["pas un hôte"] }));
});

test("session EN SANDBOX (réelle) : copie isolée, réseau direct coupé", async (t) => {
  const caps = await probeSandbox();
  if (!sandboxUsable(caps)) return t.skip(caps.reasons.join("; "));
  const { repo, call } = await setup(t, { sandbox: caps });
  const p = await call("projects.open", { rootPath: repo });
  const s = await call("sessions.start", {
    projectId: p.projectId,
    connectorId: "fake-agent",
    prompt: "Travail isolé",
    mode: "sandboxed",
  });
  await until(
    async () =>
      ["waiting_review", "failed"].includes((await call("sessions.list", { projectId: p.projectId }))[0]?.status ?? ""),
    30_000,
  );
  const events = await call("tasks.events", { taskId: s.taskId, afterSequence: 0 });
  const out = events.map((e) => (e.event.kind === "output" ? e.event.text : "")).join("\n");
  assert.match(out, /NET:(ENETUNREACH|ECONNREFUSED|EACCES|EPERM)/, `réseau direct refusé ; sortie : ${out}`);
  const [listed] = await call("sessions.list", { projectId: p.projectId });
  assert.equal(readFileSync(join(listed!.workspacePath!, "agent-output.txt"), "utf8"), "Travail isolé");
  assert.equal(existsSync(join(repo, "agent-output.txt")), false);
});

const termOut = (events: IpcPushEvent[], id: string) =>
  events.map((e) => (e.type === "terminal" && e.terminalId === id ? e.data : "")).join("");
const statuses = (events: IpcPushEvent[], taskId: string) =>
  events.flatMap((e) => (e.type === "agent-status" && e.taskId === taskId ? [e.status] : []));

test("session INTERACTIVE : TUI de l'agent dans un PTY, saisie directe, état par hooks, reprise", async (t) => {
  const { repo, call, events } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const s = await call("sessions.startInteractive", {
    projectId: p.projectId,
    connectorId: "fake-tui",
    mode: "autonomous",
    prompt: "Bonjour agent",
    cols: 100,
    rows: 30,
  });
  assert.equal(s.workspacePath, repo);
  await until(() => termOut(events, s.terminalId).includes("GOT:Bonjour agent"));
  await until(() => statuses(events, s.taskId).includes("needs_input"));
  assert.ok(statuses(events, s.taskId).includes("idle"), "tour terminé venu du hook");
  assert.ok(statuses(events, s.taskId).includes("working"), "état « travaille » venu du hook");
  const [live] = await call("sessions.list", { projectId: p.projectId });
  assert.deepEqual([live!.status, live!.terminalId], ["running", s.terminalId]);
  await call("terminal.write", { terminalId: s.terminalId, data: "ajoute un test\r" });
  await until(() => termOut(events, s.terminalId).includes("GOT:ajoute un test"));
  await until(() => statuses(events, s.taskId).at(-1) === "needs_input");
  await call("terminal.write", { terminalId: s.terminalId, data: "bye\r" });
  await until(async () => (await call("sessions.list", { projectId: p.projectId }))[0]?.status === "completed");
  assert.equal(statuses(events, s.taskId).at(-1), "done");
  assert.equal(readFileSync(join(repo, "tui-output.txt"), "utf8"), "Bonjour agent");
  // Reprise : la TUI est relancée dans le même dossier.
  const again = await call("sessions.resumeInteractive", { taskId: s.taskId, cols: 80, rows: 24 });
  await until(() => termOut(events, again.terminalId).includes("CWD:" + repo));
  await call("terminal.kill", { terminalId: again.terminalId });
  await until(() => events.some((e) => e.type === "terminal-exit" && e.terminalId === again.terminalId));
  assert.equal(
    (await call("sessions.list", { projectId: p.projectId }))[0]?.status,
    "completed",
    "reprise d'une session terminée : état inchangé",
  );
});

test("session INTERACTIVE EN SANDBOX (réelle) : TUI dans la sandbox, copie isolée, réseau direct coupé, hooks OK", async (t) => {
  const caps = await probeSandbox();
  if (!sandboxUsable(caps)) return t.skip(caps.reasons.join("; "));
  const { repo, call, events } = await setup(t, { sandbox: caps });
  const p = await call("projects.open", { rootPath: repo });
  // Un domaine autorisé suffit à activer le proxy filtrant (la fausse CLI n'a pas de profil fournisseur).
  await call("settings.set", { ...(await call("settings.get", {})), sandboxExtraAllow: ["autorise.invalid:443"] });
  const s = await call("sessions.startInteractive", {
    projectId: p.projectId,
    connectorId: "fake-tui",
    mode: "sandboxed",
    prompt: "isolé",
    cols: 100,
    rows: 30,
  });
  assert.notEqual(s.workspacePath, repo);
  await until(() => statuses(events, s.taskId).includes("idle"), 30_000);
  const out = termOut(events, s.terminalId);
  assert.match(out, /NET:(ENETUNREACH|ECONNREFUSED|EACCES|EPERM)/, `réseau direct refusé ; sortie : ${out}`);
  await until(() => termOut(events, s.terminalId).includes("PROXY:"), 15_000);
  assert.match(termOut(events, s.terminalId), /PROXY:HTTP\/1\.1 403/, "domaine hors liste refusé par le proxy");
  assert.ok(
    events.some((e) => e.type === "sandbox-denied" && e.taskId === s.taskId && e.target.startsWith("interdit.invalid")),
    "refus signalé à l'interface",
  );
  await until(() => existsSync(join(s.workspacePath, "tui-output.txt")), 15_000);
  await call("terminal.write", { terminalId: s.terminalId, data: "bye\r" });
  await until(
    async () => (await call("sessions.list", { projectId: p.projectId }))[0]?.status === "waiting_review",
    30_000,
  );
  assert.equal(readFileSync(join(s.workspacePath, "tui-output.txt"), "utf8"), "isolé");
  assert.equal(existsSync(join(repo, "tui-output.txt")), false);
});

test("diffusion : une consigne, plusieurs agents, chacun dans sa copie isolée ; agent inconnu signalé sans bloquer", async (t) => {
  const { repo, call, events } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const many = await call("sessions.startMany", {
    projectId: p.projectId,
    connectorIds: ["fake-agent", "fake-tui", "absent-cli"],
    mode: "supervised",
    prompt: "Compare-moi",
    interactive: false,
    cols: 80,
    rows: 24,
  });
  assert.equal(many.length, 3);
  assert.ok(many[2]!.error && !many[2]!.taskId, "agent absent : erreur par agent");
  const tui = await call("sessions.startMany", {
    projectId: p.projectId,
    connectorIds: ["fake-tui", "fake-agent"],
    mode: "supervised",
    prompt: "Interactif",
    interactive: true,
    cols: 80,
    rows: 24,
  });
  const live = tui[0]!;
  assert.ok(live.terminalId && live.workspacePath && live.workspacePath !== repo);
  await until(() => termOut(events, live.terminalId!).includes("GOT:Interactif"));
  await until(
    async () =>
      (await call("sessions.list", { projectId: p.projectId })).find((s) => s.taskId === many[0]!.taskId)?.status ===
      "waiting_review",
  );
  const dirs = new Set((await call("sessions.list", { projectId: p.projectId })).map((s) => s.workspacePath));
  assert.ok(dirs.size >= 4, "une copie isolée par session");
  await call("terminal.kill", { terminalId: live.terminalId! });
  if (tui[1]!.terminalId) await call("terminal.kill", { terminalId: tui[1]!.terminalId });
  await until(() => events.filter((e) => e.type === "terminal-exit").length >= (tui[1]!.terminalId ? 2 : 1));
  assert.throws(
    () =>
      ipcChannels["sessions.startMany"].request.parse({
        projectId: p.projectId,
        connectorIds: ["a1", "b2"],
        mode: "autonomous",
        prompt: "x",
      }),
    "Autonome refusé en diffusion",
  );
});

test("PR GitHub : refus explicite si gh est absent (jamais simulé)", async (t) => {
  const { repo, call, svc } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  if (svc.github && (await import("@nexus/github")).locateGh(svc.probeContext.pathEnv))
    return t.skip("gh installé : non testé sans réseau");
  await assert.rejects(
    call("git.createPr", { projectId: p.projectId, title: "Ma PR" }),
    (e: unknown) => e instanceof ExposedError && e.code === "unavailable",
  );
});

test("réglages : un domaine ajouté à la sandbox exige la confirmation native (refus → rien n'est changé)", async (t) => {
  const asked: string[] = [];
  let answer = false;
  const { call } = await setup(t, { confirm: async (_m, d) => (asked.push(d), answer) });
  const s = await call("settings.get", {});
  await assert.rejects(
    call("settings.set", { ...s, sandboxExtraAllow: ["exfil.invalid:443"] }),
    (e: unknown) => e instanceof ExposedError && e.code === "policy_denied",
  );
  assert.deepEqual((await call("settings.get", {})).sandboxExtraAllow, []);
  assert.match(asked[0] ?? "", /exfil\.invalid:443/);
  answer = true;
  await call("settings.set", { ...s, sandboxExtraAllow: ["ok.invalid:443"] });
  assert.deepEqual((await call("settings.get", {})).sandboxExtraAllow, ["ok.invalid:443"]);
  await call("settings.set", { ...s, theme: "light", sandboxExtraAllow: ["ok.invalid:443"] });
  assert.equal(asked.length, 2, "aucune nouvelle confirmation sans nouveau domaine");
});

test("terminal : une sortie massive est regroupée en envois bornés, sans perte", async (t) => {
  const { repo, call, events } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  const term = await call("terminal.create", { projectId: p.projectId, cols: 200, rows: 50 });
  await call("terminal.write", {
    terminalId: term.terminalId,
    data: "head -c 3000000 /dev/zero | tr '\\0' 'x'; echo; echo FIN_$((40+2))\r",
  });
  await until(() => termOut(events, term.terminalId).includes("FIN_42"), 30_000);
  const chunks = events.filter((e) => e.type === "terminal" && e.terminalId === term.terminalId);
  assert.ok(
    chunks.every((e) => e.type === "terminal" && e.data.length <= 256 * 1024),
    "envois bornés à 256 Ko",
  );
  assert.ok(chunks.length < 3_000_000 / 4096, "sortie regroupée");
  assert.ok((termOut(events, term.terminalId).match(/x/g) ?? []).length >= 3_000_000, "aucune perte");
  await call("terminal.kill", { terminalId: term.terminalId });
});

test("terminal : toujours dans un projet ouvert (jamais le HOME ni un dossier voisin au nom proche)", async (t) => {
  const { root, repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  assert.throws(() => ipcChannels["terminal.create"].request.parse({ cols: 80, rows: 24 }), "projectId obligatoire");
  mkdirSync(`${repo}-voisin`);
  await assert.rejects(
    call("terminal.create", { projectId: p.projectId, cwd: `${repo}-voisin`, cols: 80, rows: 24 }),
    (e: unknown) => e instanceof ExposedError && e.code === "policy_denied",
  );
  await assert.rejects(
    call("terminal.create", { projectId: p.projectId, cwd: root, cols: 80, rows: 24 }),
    (e: unknown) => e instanceof ExposedError && e.code === "policy_denied",
  );
  const ok = await call("terminal.create", { projectId: p.projectId, cwd: join(repo, "src"), cols: 80, rows: 24 });
  assert.equal(ok.cwd, join(repo, "src"));
  await call("terminal.kill", { terminalId: ok.terminalId });
});

test("plan de déploiement : analyse, IA qui pilote, coffre, confirmation native, étapes manuelles", async (t) => {
  let allow = false;
  const { repo, call } = await setup(t, { confirm: async () => allow });
  mkdirSync(join(repo, "api"));
  writeFileSync(
    join(repo, "api", "package.json"),
    JSON.stringify({ name: "api", scripts: { start: "node ." }, dependencies: { express: "5", mongoose: "8" } }),
  );
  writeFileSync(join(repo, "api", ".env.example"), "MONGODB_URI=\nJWT_SECRET=\n");
  const p = await call("projects.open", { rootPath: repo });
  assert.equal(await call("deployPlan.get", { projectId: p.projectId }), null);
  const plan = await call("deployPlan.analyze", { projectId: p.projectId });
  assert.deepEqual(
    plan.profile.components.map((c) => [c.role, c.path, c.envNames]),
    [["backend", "api", ["JWT_SECRET", "MONGODB_URI"]]],
  );
  assert.deepEqual(
    plan.proposals.map((x) => x.id),
    ["managed", "vps", "railway"],
  );

  const led = await call("deployPlan.askLead", {
    projectId: p.projectId,
    connectorId: "fake-lead",
    request: "le moins cher",
  });
  assert.equal(led.advice, "Commencez par la proposition gérée.");
  assert.deepEqual(led.proposals.map((x) => [x.id, x.origin]).slice(0, 2), [
    ["ia-choix", "ai"],
    ["managed", "rules"],
  ]);

  await call("deployPlan.setSecret", { projectId: p.projectId, ref: "deploy.render", value: "rnd_secret_value" });
  await call("deployPlan.setSecret", {
    projectId: p.projectId,
    ref: "deploy.env.backend-1.jwt_secret",
    value: "jwt-value",
  });
  assert.deepEqual(await call("deployPlan.secretStatus", { projectId: p.projectId }), [
    "deploy.render",
    "deploy.env.backend-1.jwt_secret",
  ]);
  assert.throws(
    () =>
      ipcChannels["deployPlan.setSecret"].request.parse({ projectId: p.projectId, ref: "vercel:token", value: "x" }),
    "seules les références deploy.* sont acceptées",
  );

  await call("deployPlan.choose", { projectId: p.projectId, proposalId: "managed" });
  await call("deployPlan.setInputs", { projectId: p.projectId, inputs: { repo: "Dayifour/shop" } });
  await assert.rejects(
    call("deployPlan.runStep", { projectId: p.projectId, stepId: "db-atlas" }),
    (e: unknown) => e instanceof ExposedError && e.code === "policy_denied",
    "refus dans la boîte native",
  );
  allow = true;
  await assert.rejects(
    call("deployPlan.runStep", { projectId: p.projectId, stepId: "db-atlas" }),
    (e: unknown) => e instanceof ExposedError && e.code === "invalid_request" && /Atlas/.test(e.message),
  );
  const failed = await call("deployPlan.get", { projectId: p.projectId });
  assert.equal(failed!.stepStatus["db-atlas"]?.status, "failed");
  const marked = await call("deployPlan.markStep", { projectId: p.projectId, stepId: "db-atlas", status: "skipped" });
  assert.equal(marked.stepStatus["db-atlas"]?.status, "skipped");
  const reanalyzed = await call("deployPlan.analyze", { projectId: p.projectId });
  assert.equal(reanalyzed.inputs.repo, "Dayifour/shop", "paramètres conservés");
  assert.ok(
    !JSON.stringify(reanalyzed).includes("rnd_secret_value") && !JSON.stringify(reanalyzed).includes("jwt-value"),
    "aucun secret dans le plan",
  );
});

test("sessions : relance d'une session terminée, historique du terminal, suppression, séparation par projet", async (t) => {
  const { root, repo, call, events } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  // Relance d'une session autonome terminée (nouveau message dans la conversation).
  const s = await call("sessions.start", {
    projectId: p.projectId,
    connectorId: "fake-agent",
    prompt: "Premier",
    mode: "autonomous",
  });
  await until(async () => (await call("sessions.list", { projectId: p.projectId }))[0]?.status === "completed");
  await call("sessions.followUp", { taskId: s.taskId, prompt: "Deuxième" });
  await until(async () => readFileSync(join(repo, "agent-output.txt"), "utf8").includes("Deuxième"));
  await until(async () => (await call("sessions.list", { projectId: p.projectId }))[0]?.status === "completed");

  // Session en terminal : sa sortie est conservée et relisible après la fin.
  const i = await call("sessions.startInteractive", {
    projectId: p.projectId,
    connectorId: "fake-tui",
    mode: "autonomous",
    prompt: "garde-moi",
    cols: 80,
    rows: 24,
  });
  await until(() => termOut(events, i.terminalId).includes("GOT:garde-moi"));
  await assert.rejects(
    call("sessions.delete", { taskId: i.taskId }),
    (e: unknown) => e instanceof ExposedError && e.code === "conflict",
    "suppression refusée pendant l'exécution",
  );
  await call("terminal.write", { terminalId: i.terminalId, data: "bye\r" });
  await until(
    async () =>
      (await call("sessions.list", { projectId: p.projectId })).find((x) => x.taskId === i.taskId)?.status ===
      "completed",
  );
  await until(async () => (await call("sessions.transcript", { taskId: i.taskId })).data.includes("GOT:garde-moi"));

  // Un autre projet n'affiche pas ces sessions.
  const other = join(root, "autre");
  mkdirSync(other);
  const p2 = await call("projects.open", { rootPath: other });
  assert.deepEqual(await call("sessions.list", { projectId: p2.projectId }), []);

  // Suppression : disparaît de la liste, historique effacé.
  await call("sessions.delete", { taskId: i.taskId });
  assert.ok(!(await call("sessions.list", { projectId: p.projectId })).some((x) => x.taskId === i.taskId));
  assert.equal((await call("sessions.transcript", { taskId: i.taskId })).data, "");
});

test("messages d'erreur dans la langue choisie (anglais)", async (t) => {
  const { call } = await setup(t);
  const s = await call("settings.get", {});
  await assert.rejects(
    call("projects.open", { rootPath: "/nexistepas/du/tout" }),
    (e: unknown) => e instanceof ExposedError && e.message === "Ce chemin n'est pas un dossier",
  );
  await call("settings.set", { ...s, language: "en" });
  await assert.rejects(
    call("projects.open", { rootPath: "/nexistepas/du/tout" }),
    (e: unknown) => e instanceof ExposedError && e.message === "This path is not a folder",
  );
  await assert.rejects(
    call("sessions.delete", { taskId: "00000000-0000-4000-8000-000000000009" }),
    (e: unknown) => e instanceof ExposedError && /not found/i.test(e.message),
  );
});

test("fichier supprimé hors de Nexus pendant qu'il est ouvert : « introuvable », jamais une erreur interne", async (t) => {
  const { repo, call } = await setup(t);
  const p = await call("projects.open", { rootPath: repo });
  await assert.rejects(
    call("files.read", { projectId: p.projectId, path: "src/disparu.ts" }),
    (e: unknown) => e instanceof ExposedError && e.code === "not_found",
  );
  await assert.rejects(
    call("files.list", { projectId: p.projectId, dir: "absent" }),
    (e: unknown) => e instanceof ExposedError && e.code === "not_found",
  );
});
