// Cycle de vie des processus (repris et étendu du spike T-001).
// Sans user namespaces (ex. runners CI restreints par AppArmor), la suite ÉCHOUE au lieu d'être ignorée,
// sauf déclaration explicite NEXUS_ALLOW_NO_USERNS=1.
import { before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  defaultKillBoundary,
  probeKillBoundary,
  resolveExecutable,
  runProcess,
  type RunOptions,
} from "../src/index.ts";

const ESCAPER = fileURLToPath(new URL("./fixtures/escaper.mjs", import.meta.url));
const SUPERVISOR_PARENT = fileURLToPath(new URL("./fixtures/supervisor-parent.ts", import.meta.url));
let pidns = { usable: false, parentDeath: false } as { usable: boolean; reason?: string; parentDeath: boolean };
before(async () => {
  pidns = await probeKillBoundary();
  if (!pidns.usable && process.env.NEXUS_ALLOW_NO_USERNS !== "1") {
    throw new Error(`PID namespace indisponible (${pidns.reason}) : refus, pas de faux vert`);
  }
});
const ns = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, (t) => (pidns.usable ? fn(t) : t.skip(`pid namespace: ${pidns.reason}`)));

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-ps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const run = (o: Partial<RunOptions> & Pick<RunOptions, "args" | "cwd">) =>
  runProcess({ file: process.execPath, env: {}, timeoutMs: 10_000, ...o });

const readBeat = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
async function beating(f: string): Promise<boolean> {
  const a = readBeat(f);
  await new Promise((r) => setTimeout(r, 400));
  return a !== null && a !== readBeat(f);
}
async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) await new Promise((r) => setTimeout(r, 20));
  return pred();
}

ns("argument hostile transmis littéralement, jamais interprété par un shell", async (t) => {
  const dir = tmp(t);
  const marker = join(dir, "pwned");
  const lines: string[] = [];
  const r = await run({
    args: ["-e", "console.log(process.argv[1])", `x; touch ${marker}`],
    cwd: dir,
    onLine: (l) => lines.push(l),
  });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(lines, [`x; touch ${marker}`]);
  assert.equal(existsSync(marker), false);
});

ns("environnement explicite : aucune variable du parent ne fuit", async (t) => {
  process.env.NEXUS_FAKE_TOKEN = "fixture-token-not-real";
  t.after(() => delete process.env.NEXUS_FAKE_TOKEN);
  const lines: string[] = [];
  await run({
    args: ["-e", "console.log(JSON.stringify(Object.keys(process.env)))"],
    cwd: tmp(t),
    env: { NEXUS_OK: "1" },
    onLine: (l) => lines.push(l),
  });
  const keys = JSON.parse(lines[0]!) as string[];
  assert.ok(!keys.includes("NEXUS_FAKE_TOKEN"));
  assert.ok(keys.includes("NEXUS_OK"));
});

test("frontière process-group refusée sans déclaration explicite ; frontière inconnue refusée", async (t) => {
  await assert.rejects(run({ args: ["-v"], cwd: tmp(t), killBoundary: "process-group" }), /insufficient/);
  await assert.rejects(run({ args: ["-v"], cwd: tmp(t), killBoundary: "none" as never }), /unknown killBoundary/);
});

test("PREUVE DE LA FAILLE : process-group seul laisse survivre un descendant setsid", async (t) => {
  const dir = tmp(t);
  const hb = join(dir, "hb");
  const ac = new AbortController();
  const done = run({
    args: [ESCAPER, hb],
    cwd: dir,
    killBoundary: "process-group",
    allowWeakBoundary: true,
    killGraceMs: 300,
    signal: ac.signal,
  });
  assert.ok(await waitFor(() => readBeat(hb) !== null));
  ac.abort();
  await done;
  const survived = await beating(hb);
  const pid = Number(readBeat(hb)?.split(":")[0]);
  if (pid > 1) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* déjà mort */
    }
  }
  assert.equal(survived, true);
});

for (const [label, opts] of [
  ["AbortSignal", {}],
  ["timeout", { timeoutMs: 1500 }],
  ["SIGTERM ignoré + escalade SIGKILL", { flags: ["--ignore-sigterm"] }],
] as const) {
  ns(`PID namespace : descendant setsid tué (${label})`, async (t) => {
    const dir = tmp(t);
    const hb = join(dir, "hb");
    const ac = new AbortController();
    const done = run({
      args: [ESCAPER, hb, ...("flags" in opts ? opts.flags : [])],
      cwd: dir,
      killGraceMs: 300,
      signal: ac.signal,
      timeoutMs: "timeoutMs" in opts ? opts.timeoutMs : 60_000,
    });
    assert.ok(await waitFor(() => readBeat(hb) !== null), "descendant démarré");
    const t0 = Date.now();
    if (!("timeoutMs" in opts)) ac.abort();
    const r = await done;
    assert.ok(r.cancelled || r.timedOut);
    assert.equal(await beating(hb), false, "le descendant setsid a survécu");
    if (!("timeoutMs" in opts)) assert.ok(Date.now() - t0 < 3000, "NFR-005");
  });
}

ns("PID namespace : un « démon » setsid laissé après une fin normale est tué", async (t) => {
  const dir = tmp(t);
  const hb = join(dir, "hb");
  const r = await run({ args: [ESCAPER, hb, "--exit-soon"], cwd: dir });
  assert.equal(r.exitCode, 0);
  assert.equal(await beating(hb), false);
});

ns("mort brutale du parent (SIGKILL de Nexus) : tout le PID namespace meurt avec lui", async (t) => {
  if (!pidns.parentDeath) return t.skip("setpriv absent : pas de protection contre la mort du parent");
  const dir = tmp(t);
  const hb = join(dir, "hb");
  const parent = spawn(process.execPath, [SUPERVISOR_PARENT, ESCAPER, hb], { stdio: "ignore" });
  t.after(() => parent.kill("SIGKILL"));
  assert.ok(await waitFor(() => readBeat(hb) !== null), "descendant démarré");
  assert.equal(await beating(hb), true);
  parent.kill("SIGKILL");
  await new Promise((r) => parent.once("exit", r));
  // Le descendant setsid, petit-enfant de unshare, ne doit pas survivre au parent.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await beating(hb), false, "le descendant a survécu à la mort du parent");
});

test("frontière par défaut selon la plateforme ; frontières hors plateforme refusées", async (t) => {
  assert.equal(defaultKillBoundary("linux"), "pid-namespace");
  assert.equal(defaultKillBoundary("darwin"), "process-group");
  assert.equal(defaultKillBoundary("win32"), "process-tree");
  if (process.platform !== "win32") {
    await assert.rejects(run({ args: ["-v"], cwd: tmp(t), killBoundary: "process-tree" }), /Windows-only/);
  }
});

ns("plafond de sortie : processus bavard arrêté, mémoire bornée", async (t) => {
  let received = 0;
  const r = await run({
    args: ["-e", "const b='x'.repeat(65536);setInterval(()=>process.stdout.write(b),1)"],
    cwd: tmp(t),
    maxOutputBytes: 1 << 20,
    killGraceMs: 300,
    onChunk: (c) => (received += c.length),
  });
  assert.equal(r.outputLimitExceeded, true);
  assert.ok(received <= 1 << 20);
});

ns("redaction : valeurs connues et motifs de jetons masqués sur stdout et stderr", async (t) => {
  const known = "fixture-secret-0123456789";
  const pattern = "sk-ant-" + "a".repeat(24);
  const lines: string[] = [];
  await run({
    args: ["-e", `console.log('a=${known}'); console.error('b=${pattern}')`],
    cwd: tmp(t),
    redact: [known],
    onLine: (l, ch) => lines.push(`${ch}:${l}`),
  });
  assert.deepEqual(lines.sort(), ["stderr:b=[REDACTED]", "stdout:a=[REDACTED]"]);
});

test("binaire absent ou chemin relatif : erreur normalisée, pas d'exception non gérée (AC-14)", async (t) => {
  const r = await runProcess({ file: "/nonexistent/cli", args: [], cwd: tmp(t), env: {}, timeoutMs: 1000 });
  assert.equal(r.spawnError, "ENOENT");
  await assert.rejects(runProcess({ file: "node", args: [], cwd: tmp(t), env: {}, timeoutMs: 1000 }), /absolute/);
});

test("résolution PATH : entrées relatives ignorées, exécutable modifiable par tous refusé", (t) => {
  const dir = tmp(t);
  const good = join(dir, "good");
  const evil = join(dir, "evil");
  mkdirSync(good);
  mkdirSync(evil);
  for (const d of [good, evil]) {
    writeFileSync(join(d, "fakecli"), "#!/bin/sh\necho ok\n");
    chmodSync(join(d, "fakecli"), 0o755);
  }
  chmodSync(join(evil, "fakecli"), 0o777);
  const rejected: string[] = [];
  const r = resolveExecutable("fakecli", `.::relative/bin:${evil}:${good}`, (x) => rejected.push(x.reason));
  assert.equal(r?.path, join(good, "fakecli"));
  assert.deepEqual(rejected, ["world_writable"]);
  assert.equal(resolveExecutable("../etc/passwd", good), null);
  assert.equal(resolveExecutable("absent", good), null);
});
