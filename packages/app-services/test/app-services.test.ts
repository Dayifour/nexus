// Intégration de bout en bout (sans Electron) : handlers IPC -> services -> domaine, worktrees Git réels,
// fausse CLI agent qui écrit dans son dossier de travail. Chaque réponse est validée par le contrat IPC.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ipcChannels, type IpcChannel, type IpcRequest, type IpcResponse } from "@nexus/contracts";
import { GenericCliConnector } from "@nexus/connectors";
import type { Cipher } from "@nexus/secrets";
import type { SandboxCapabilities } from "@nexus/sandbox";
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

const NO_SANDBOX: SandboxCapabilities = {
  platform: "linux",
  bwrap: false,
  pidNamespace: true,
  seccomp: false,
  cgroups: false,
  reasons: ["test"],
};

async function setup(t: TestContext, dialogs: { save?: string; open?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-app-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "/usr/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# Stock\n");
  writeFileSync(join(repo, ".env"), "FIXTURE_ENV=1\n");
  writeFileSync(join(repo, ".npmrc"), "//r/:_authToken=FIXTURE\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");

  // Fausse CLI agent : lit le prompt sur stdin et écrit un fichier dans son dossier de travail.
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "fakeagent"),
    `#!/usr/bin/env node\nconst fs=require('fs');if(process.argv[2]==='--version'){console.log('fakeagent 1.2.3');process.exit(0)}\nconst p=fs.readFileSync(0,'utf8');fs.mkdirSync('backend',{recursive:true});fs.writeFileSync('backend/api.js','// '+p.split('\\n')[0]+'\\n');console.log('écrit backend/api.js');\n`,
  );
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
    { probeContext: { pathEnv: `${bin}:${NODE_DIR}:/usr/bin:/bin` }, baseEnv: { PATH: `${NODE_DIR}:/usr/bin:/bin` } },
  );
  await fake.probe();

  const events: string[] = [];
  const svc = await AppServices.open({
    userDataDir: join(root, "userdata"),
    cipher: cipher(),
    pathEnv: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    home,
    sandboxCapabilities: NO_SANDBOX,
    extraConnectors: [fake],
    push: (e) => events.push(e.type === "run" ? `run:${e.event.kind}` : e.type === "domain" ? e.eventType : e.type),
    pickSavePath: async () => dialogs.save ?? null,
    pickOpenPath: async () => dialogs.open ?? null,
  });
  t.after(() => svc.close());
  const handlers = createAppHandlers(svc, {
    appVersion: "0.1.0",
    electron: "44",
    node: process.versions.node,
    platform: "linux",
  });
  /** Appel validé par le contrat (requête ET réponse), comme le ferait le dispatcher du main. */
  const call = async <C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>> => {
    const spec = ipcChannels[channel];
    const req = spec.request.parse(payload);
    const h = handlers[channel] as ((r: unknown) => unknown) | undefined;
    assert.ok(h, `handler manquant : ${channel}`);
    const res = await h(req);
    return spec.response.parse(res) as IpcResponse<C>;
  };
  return { root, repo, svc, call, events };
}

async function until(pred: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("délai dépassé");
}

test("tous les canaux du contrat ont un handler", async (t) => {
  const { svc } = await setup(t);
  const handlers = createAppHandlers(svc, { appVersion: "x", electron: "x", node: "x", platform: "linux" });
  const missing = (Object.keys(ipcChannels) as IpcChannel[]).filter((c) => !handlers[c]);
  assert.deepEqual(missing, []);
});

test("parcours UC-02 complet : projet, session avec validation dans un worktree isolé, revue, diff, événements", async (t) => {
  const { repo, call, events } = await setup(t);
  const caps = await call("app.capabilities", {});
  assert.equal(caps.secrets.available, true);
  assert.equal(caps.sandbox.usable, false, "capacités honnêtes : pas de sandbox simulée");
  const inventory = await call("agents.inventory", {});
  assert.equal(inventory.find((p) => p.connectorId === "fake-agent")?.version, "1.2.3");

  const project = await call("projects.create", { name: "Stock", rootPath: repo });
  const task = await call("sessions.start", {
    projectId: project.projectId,
    connectorId: "fake-agent",
    prompt: "API produits\nCRUD",
    mode: "supervised",
  });
  const session = async () =>
    (await call("sessions.list", { projectId: project.projectId })).find((s) => s.taskId === task.taskId);
  await until(async () => (await session())?.status === "waiting_review");
  assert.equal((await session())?.prompt, "API produits\nCRUD", "consigne initiale servie avec la session");

  // ADR-008 : le dépôt principal n'est pas modifié ; le travail est dans le worktree de la tâche.
  assert.equal(existsSync(join(repo, "backend", "api.js")), false, "aucune écriture dans le dépôt principal");
  const diff = await call("tasks.diff", { taskId: task.taskId });
  const outputs = await call("tasks.events", { taskId: task.taskId, afterSequence: 0 });
  assert.ok(outputs.some((e) => e.event.kind === "output" && e.event.text.includes("backend/api.js")));
  assert.ok(
    events.includes("run:output") && events.includes("task.status_changed"),
    "événements poussés vers l'interface",
  );
  assert.deepEqual(
    diff.files.map((f) => [f.path, f.status]),
    [["backend/api.js", "added"]],
    "la revue voit le fichier créé par l'agent",
  );
  assert.match(diff.unified, /API produits/);
  assert.deepEqual(diff.secretFindings, []);
  assert.equal(existsSync(join(repo, "backend")), false, "toujours rien dans le dépôt principal après la revue");

  const reviewed = await call("tasks.review", { taskId: task.taskId, decision: "approve" });
  assert.equal(reviewed.status, "completed");
  const usage = await call("usage.summary", { projectId: project.projectId });
  assert.equal(usage.source, "unavailable", "CLI générique sans compteur : indisponible, jamais 0 inventé (AC-10)");
});

test("session isolée dans un projet non Git : refus explicite (ADR-008)", async (t) => {
  const { root, call } = await setup(t);
  const plain = join(root, "plain");
  mkdirSync(plain);
  const project = await call("projects.create", { name: "Plain", rootPath: plain });
  await assert.rejects(
    call("sessions.start", {
      projectId: project.projectId,
      connectorId: "fake-agent",
      prompt: "x",
      mode: "supervised",
    }),
    (e: unknown) => e instanceof ExposedError && e.code === "invalid_request",
  );
  assert.deepEqual(await call("sessions.list", { projectId: project.projectId }), []);
  assert.equal(existsSync(join(plain, "backend")), false);
});

test("fichiers : traversée refusée, identifiants jamais servis, .env servi par défaut puis protégé (D-4)", async (t) => {
  const { repo, call } = await setup(t);
  const project = await call("projects.create", { name: "Stock", rootPath: repo });
  const list = await call("files.list", { projectId: project.projectId, dir: "" });
  assert.equal(list.find((f) => f.name === ".npmrc")?.protected, true);
  assert.equal(list.find((f) => f.name === ".env")?.protected, false);
  await assert.rejects(
    call("files.read", { projectId: project.projectId, path: ".npmrc" }),
    (e: unknown) => e instanceof ExposedError && e.code === "policy_denied",
  );
  assert.match((await call("files.read", { projectId: project.projectId, path: ".env" })).content, /FIXTURE_ENV/);
  await call("projects.setEnvProtection", { projectId: project.projectId, protect: true });
  await assert.rejects(
    call("files.read", { projectId: project.projectId, path: ".env" }),
    (e: unknown) => e instanceof ExposedError && e.code === "policy_denied",
  );
  assert.throws(
    () => ipcChannels["files.read"].request.parse({ projectId: project.projectId, path: "../etc/passwd" }),
    "traversée refusée dès le contrat",
  );
  await call("files.write", { projectId: project.projectId, path: "docs/notes.md", content: "ok" });
  assert.equal(readFileSync(join(repo, "docs", "notes.md"), "utf8"), "ok");
});

test("secrets : valeur jamais renvoyée ; statut Git servi", async (t) => {
  const { repo, call } = await setup(t);
  const meta = await call("secrets.set", {
    ref: "openai:main",
    label: "OpenAI",
    purposes: ["connector:openai-api"],
    value: "fixture-value-not-real-123456",
  });
  assert.ok(!JSON.stringify(meta).includes("fixture-value"));
  assert.ok(!JSON.stringify(await call("secrets.list", {})).includes("fixture-value"));
  const project = await call("projects.create", { name: "Stock", rootPath: repo });
  const status = await call("git.status", { projectId: project.projectId });
  assert.equal(status.available, true);
  assert.equal(status.branch, "main");
});

test("voix AC-11 via IPC : moteurs non configurés indisponibles, micro accordé seulement après armement, envoi sans relecture refusé", async (t) => {
  const { svc, call } = await setup(t);
  const status = await call("voice.status", {});
  assert.equal(status.state, "idle");
  assert.ok(
    status.engines.every((e) => !e.available),
    "aucun moteur configuré : rien n'est promis",
  );
  assert.ok(status.engines.find((e) => e.kind === "cloud")?.reason?.includes("consentement"));
  assert.equal(svc.voice.mayGrantMicrophone(), false, "micro refusé par défaut");
  const armed = await call("voice.arm", { consent: true });
  assert.equal(armed.windowMs, 10_000);
  assert.equal(svc.voice.mayGrantMicrophone(), true);
  await assert.rejects(
    call("voice.transcribe", {
      engineId: "local-whisper-cpp",
      language: "fr",
      mimeType: "audio/webm",
      audioBase64: "AAAA",
    }),
    (e: unknown) => e instanceof ExposedError && e.code === "unavailable",
  );
  await assert.rejects(
    call("voice.commit", { editedText: "texte" }),
    (e: unknown) => e instanceof ExposedError && e.code === "conflict",
  );
  await call("voice.discard", {});
  assert.equal(svc.voice.mayGrantMicrophone(), false);
});

test("FR-025 via IPC : export vers le chemin choisi (0600), annulation sans écriture, import refusé en double", async (t) => {
  const out = join(mkdtempSync(join(tmpdir(), "nexus-export-")), "projet.nexus.json");
  t.after(() => rmSync(dirname(out), { recursive: true, force: true }));
  const { repo, call } = await setup(t, { save: out, open: out });
  const project = await call("projects.create", { name: "Stock", rootPath: repo });
  const r = await call("projects.export", { projectId: project.projectId });
  assert.equal(r.path, out);
  assert.equal((await import("node:fs")).statSync(out).mode & 0o777, 0o600);
  assert.match(readFileSync(out, "utf8"), /nexus-project-archive/);
  await assert.rejects(
    call("projects.import", {}),
    (e: unknown) => e instanceof ExposedError && e.code === "conflict",
    "déjà présent dans cette base",
  );
  const cancelled = await setup(t);
  const p2 = await cancelled.call("projects.create", { name: "Autre", rootPath: cancelled.repo });
  assert.deepEqual(await cancelled.call("projects.export", { projectId: p2.projectId }), { path: null, events: 1 });
});
