import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEvent, type AgentTaskRequest, type PermissionMode } from "@nexus/contracts";
import {
  AsyncQueue,
  runCliTask,
  ClaudeCliConnector,
  CodexCliConnector,
  ConnectorRegistry,
  EventSequencer,
  GENERIC_INVOCATIONS,
  supportsReadOnly,
  claudeMcpConfig,
  claudeMcpArgs,
  codexMcpArgs,
  codexMcpConfig,
  hermesScope,
  hermesUserHome,
  injectHermesMcpServers,
  parseHermesSessionId,
  mcpConfigFor,
  stripAnsi,
  GenericCliConnector,
  createCodexNormalizer,
  probeCli,
  type CliSignature,
} from "../src/index.ts";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const NODE_DIR = dirname(process.execPath);

/** Dossier bin temporaire contenant de fausses CLI sous les noms attendus. */
function binDir(t: TestContext, map: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-conn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  for (const [name, fixture] of Object.entries(map)) {
    const target = join(dir, "bin", name);
    copyFileSync(join(FIX, fixture), target);
    chmodSync(target, 0o755);
  }
  // Les fausses CLI importent leurs fixtures par URL relative : on les copie à côté.
  for (const f of ["claude-stream-ok.jsonl", "claude-stream-not-logged-in.jsonl"])
    copyFileSync(join(FIX, f), join(dir, "bin", f));
  return dir;
}

function request(workspacePath: string, overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest {
  return {
    taskId: randomUUID(),
    projectId: randomUUID(),
    sessionId: randomUUID(),
    agentProfileId: randomUUID(),
    workspacePath,
    prompt: "Réponds pong ; ce prompt ne doit jamais apparaître dans argv",
    contextRefs: [],
    permissionsPolicyId: "manual",
    timeoutMs: 15_000,
    ...overrides,
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const sig = (connectorId: string, name: string): CliSignature => ({
  connectorId,
  displayName: connectorId,
  binaryNames: [name],
  versionArgs: ["--version"],
  versionPattern: /(\d+\.\d+\.\d+)/,
  probeTimeoutMs: 1500,
  agent: true,
});

const modes = (m: PermissionMode) => () => m;

test("sonde : CLI absente, présente avec version, format inconnu, code non nul, blocage (AC-01, AC-14)", async (t) => {
  const dir = binDir(t, { fakecli: "fake-plain.mjs" });
  const pathEnv = `${join(dir, "bin")}:${NODE_DIR}:/usr/bin:/bin`;
  const absent = await probeCli(sig("x", "absentcli"), { pathEnv });
  assert.equal(absent.installed, false);
  assert.equal(absent.reason, "not_found_on_path");

  const ok = await probeCli(sig("hermes-cli", "fakecli"), { pathEnv });
  assert.deepEqual(
    [ok.installed, ok.version, ok.authenticated, ok.reason],
    [true, "0.18.0", undefined, "auth_not_checked"],
  );

  process.env.FAKE_VERSION = "build unknown";
  t.after(() => delete process.env.FAKE_VERSION);
  // La sonde n'hérite pas de l'environnement : FAKE_VERSION ne doit PAS être vu par la CLI.
  const isolated = await probeCli(sig("hermes-cli", "fakecli"), { pathEnv });
  assert.equal(isolated.version, "0.18.0", "la sonde ne transmet pas l'environnement du parent");

  const hangDir = binDir(t, {});
  writeFileSync(join(hangDir, "bin", "hangcli"), `#!/bin/sh\nsleep 30\n`);
  chmodSync(join(hangDir, "bin", "hangcli"), 0o755);
  const hang = await probeCli(sig("y", "hangcli"), { pathEnv: `${join(hangDir, "bin")}:/usr/bin:/bin` });
  assert.equal(hang.reason, "version_probe_timeout");

  const odd = binDir(t, {});
  writeFileSync(join(odd, "bin", "oddcli"), `#!/bin/sh\necho "no version here"\nexit 3\n`);
  chmodSync(join(odd, "bin", "oddcli"), 0o755);
  const unknown = await probeCli(sig("z", "oddcli"), { pathEnv: `${join(odd, "bin")}:/usr/bin:/bin` });
  assert.deepEqual([unknown.installed, unknown.version, unknown.reason], [true, undefined, "unknown_version_format"]);
});

test("inventaire : toutes les signatures sondées sans exception, triées, résultats conformes au contrat", async (t) => {
  const dir = binDir(t, { claude: "fake-claude.mjs" });
  // PATH isolé : seulement la fausse CLI et node (les vraies CLI installées sur la machine ne doivent pas compter).
  symlinkSync(process.execPath, join(dir, "bin", "node"));
  const registry = new ConnectorRegistry();
  const results = await registry.inventory({ pathEnv: join(dir, "bin") });
  const claude = results.find((r) => r.connectorId === "claude-cli");
  assert.equal(claude?.installed, true);
  assert.equal(claude?.version, "2.1.296");
  assert.equal(results.find((r) => r.connectorId === "codex-cli")?.installed, false);
  assert.deepEqual(
    results.map((r) => r.connectorId),
    results.map((r) => r.connectorId).sort(),
  );
});

function claude(
  t: TestContext,
  scenario: string,
  mode: PermissionMode = "manual",
  authMode: "vendor-login" | "api-key" = "vendor-login",
) {
  const dir = binDir(t, { claude: "fake-claude.mjs" });
  const record = join(dir, "record.json");
  const connector = new ClaudeCliConnector({
    probeContext: { pathEnv: `${join(dir, "bin")}:${NODE_DIR}:/usr/bin:/bin` },
    authMode,
    baseEnv: { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: dir, FAKE_SCENARIO: scenario, FAKE_RECORD: record },
    resolvePermissionMode: modes(mode),
  });
  return { dir, record, connector };
}

test("Claude : flux nominal normalisé, séquences croissantes, événements conformes au contrat", async (t) => {
  const { dir, record, connector } = claude(t, "ok");
  await connector.probe();
  const req = request(dir);
  const events = await collect(connector.start(req, new AbortController().signal));
  assert.deepEqual(
    events.map((e) => e.kind),
    ["started", "output", "quota", "usage", "completed"],
  );
  const quota = events.find((e) => e.kind === "quota");
  assert.ok(
    quota?.kind === "quota" && quota.status === "allowed" && quota.window === "fixture" && !quota.resetsAt,
    "quota normalisé (réinitialisation 0 ignorée)",
  );
  events.forEach((e, i) => {
    assert.equal(AgentEvent.safeParse(e).success, true);
    assert.equal(e.sequence, i + 1);
    assert.equal(e.taskId, req.taskId);
  });
  const usage = events.find((e) => e.kind === "usage");
  assert.ok(usage?.kind === "usage" && usage.caveat, "coût indicatif accompagné d'un avertissement");
  const rec = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(rec.stdin, req.prompt, "prompt transmis sur stdin");
  assert.ok(!rec.args.join(" ").includes("ce prompt"), "prompt jamais dans argv");
  assert.deepEqual(rec.args.slice(0, 5), ["--print", "--output-format", "stream-json", "--verbose", "--session-id"]);
  // H7 : identifiant de session NEUF à chaque lancement (sinon « Session ID already in use » d'une tâche à l'autre).
  assert.match(rec.args[5], /^[0-9a-f-]{36}$/);
  assert.notEqual(
    rec.args[5],
    req.sessionId,
    "la session Nexus (projet, agent) n'est pas réutilisée comme session CLI",
  );
  await collect(connector.start(req, new AbortController().signal));
  const again = JSON.parse(readFileSync(record, "utf8"));
  assert.notEqual(again.args[5], rec.args[5], "deux lancements, deux sessions CLI distinctes");
});

test("Claude avec validation : --restricted, dontAsk, outils limités ; environnement réduit", async (t) => {
  const { dir, record, connector } = claude(t, "ok", "manual");
  await connector.probe();
  await collect(connector.start(request(dir), new AbortController().signal));
  const rec = JSON.parse(readFileSync(record, "utf8"));
  assert.ok(rec.args.includes("--restricted"));
  assert.equal(rec.args[rec.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!rec.args.includes("Bash"));
  assert.deepEqual(rec.envKeys.filter((k: string) => !["PWD", "SHLVL", "_"].includes(k)).sort(), [
    "FAKE_RECORD",
    "FAKE_SCENARIO",
    "HOME",
    "PATH",
  ]);
});

test("Claude autonome / en sandbox : aucune question de permission (bypassPermissions), pas de --restricted", async (t) => {
  for (const mode of ["autonomous", "sandbox-auto"] as const) {
    const { dir, record, connector } = claude(t, "ok", mode, "vendor-login");
    await connector.probe();
    const events = await collect(connector.start(request(dir), new AbortController().signal));
    assert.equal(events.at(-1)?.kind, "completed");
    const rec = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(rec.args[rec.args.indexOf("--permission-mode") + 1], "bypassPermissions", mode);
    assert.ok(!rec.args.includes("--restricted"), mode);
  }
});

test("Claude non connecté : échec auth_required (piège subtype success + is_error)", async (t) => {
  const { dir, connector } = claude(t, "not-logged-in");
  await connector.probe();
  const events = await collect(connector.start(request(dir), new AbortController().signal));
  const last = events.at(-1);
  assert.ok(last?.kind === "failed" && last.code === "auth_required", JSON.stringify(last));
});

test("Claude reprise : --resume avec l'identifiant natif", async (t) => {
  const { dir, record, connector } = claude(t, "ok");
  await connector.probe();
  await collect(connector.resume!("native-123", request(dir), new AbortController().signal));
  const rec = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(rec.args[rec.args.indexOf("--resume") + 1], "native-123");
  assert.ok(!rec.args.includes("--session-id"));
});

test("Claude annulation en cours de flux : terminal unique `cancelled` en moins de 3 s", async (t) => {
  const { dir, connector } = claude(t, "slow");
  await connector.probe();
  const ac = new AbortController();
  const events: AgentEvent[] = [];
  const t0 = Date.now();
  for await (const e of connector.start(request(dir), ac.signal)) {
    events.push(e);
    if (e.kind === "started") ac.abort();
  }
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["started", "failed"],
  );
  assert.ok(events[1]?.kind === "failed" && events[1].code === "cancelled");
});

test("binaire non détecté : échec explicite binary_not_found", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-conn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = new ClaudeCliConnector({
    probeContext: { pathEnv: dir },
    authMode: "vendor-login",
    baseEnv: {},
    resolvePermissionMode: modes("manual"),
  });
  const events = await collect(c.start(request(dir), new AbortController().signal));
  assert.ok(events[0]?.kind === "failed" && events[0].code === "binary_not_found");
});

test("Codex (fixture-only, forme documentée NON vérifiée) : normalisation et raisonnement interne non exposé", () => {
  const out: AgentEvent[] = [];
  const seq = new EventSequencer(randomUUID(), (e) => out.push(e));
  const n = createCodexNormalizer();
  for (const line of readFileSync(join(FIX, "codex-exec-documented.jsonl"), "utf8").trim().split("\n"))
    n.onStdout(line, seq);
  assert.deepEqual(
    out.map((e) => e.kind),
    ["started", "tool-request", "output", "usage", "completed"],
  );
  assert.ok(!JSON.stringify(out).includes("interne"), "le raisonnement interne n'est pas exposé (§17)");
  assert.equal(n.stats().unknown, 1, "turn.started ignoré et compté");
});

test("Codex absent : maturité beta (vérifié en réel) déclarée et échec binary_not_found", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-conn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = new CodexCliConnector({
    probeContext: { pathEnv: dir },
    baseEnv: {},
    resolvePermissionMode: modes("manual"),
  });
  assert.equal(c.manifest.maturity, "beta");
  assert.equal((await c.probe()).installed, false);
  const events = await collect(c.start(request(dir), new AbortController().signal));
  assert.ok(events[0]?.kind === "failed" && events[0].code === "binary_not_found");
});

test("CLI générique : lignes stdout/stderr en output, code 0 terminé, code non nul en échec", async (t) => {
  const dir = binDir(t, { fakecli: "fake-plain.mjs" });
  const make = (exit: string) =>
    new GenericCliConnector(
      { signature: sig("hermes-cli", "fakecli"), args: [], promptVia: "stdin" },
      {
        probeContext: { pathEnv: `${join(dir, "bin")}:${NODE_DIR}:/usr/bin:/bin` },
        baseEnv: { PATH: `${NODE_DIR}:/usr/bin:/bin`, FAKE_EXIT: exit },
      },
    );
  const ok = make("0");
  await ok.probe();
  const events = await collect(ok.start(request(dir), new AbortController().signal));
  assert.equal(events[0]?.kind, "started");
  assert.equal(events.at(-1)?.kind, "completed");
  assert.equal(events.filter((e) => e.kind === "output").length, 3);
  const ko = make("2");
  await ko.probe();
  const failed = await collect(ko.start(request(dir), new AbortController().signal));
  assert.ok(failed.at(-1)?.kind === "failed");
  assert.equal(ok.manifest.maturity, "beta");
});

test(
  "Claude RÉEL (opt-in NEXUS_REAL_CLAUDE=1) : mode manuel, prompt inoffensif, flux complet",
  { skip: process.env.NEXUS_REAL_CLAUDE !== "1" && "opt-in" },
  async (t) => {
    const ws = mkdtempSync(join(tmpdir(), "nexus-real-claude-"));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const c = new ClaudeCliConnector({
      probeContext: { pathEnv: process.env.PATH ?? "" },
      authMode: "vendor-login",
      baseEnv: { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      resolvePermissionMode: modes("manual"),
    });
    const probe = await c.probe();
    assert.equal(probe.installed, true);
    const events = await collect(
      c.start(request(ws, { prompt: "Reply with exactly the word: pong" }), new AbortController().signal),
    );
    assert.equal(events[0]?.kind, "started");
    assert.equal(events.at(-1)?.kind, "completed", JSON.stringify(events.at(-1)));
    assert.ok(events.some((e) => e.kind === "output" && /pong/i.test(e.text)));
  },
);

test("CLI générique : invocation non interactive, auto-approbation dans les modes qui écrivent, lecture seule réelle ou refusée", async (t) => {
  const dir = binDir(t, { fakecli: "fake-plain.mjs" });
  const seen: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  const make = (id: string) =>
    new GenericCliConnector(
      { signature: sig(id, "fakecli"), ...GENERIC_INVOCATIONS[id]! },
      {
        probeContext: { pathEnv: `${join(dir, "bin")}:${NODE_DIR}:/usr/bin:/bin` },
        baseEnv: { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: dir },
        runtimeDir: join(dir, "rt"),
        runner: async (o) => {
          seen.push([...o.args]);
          envs.push({ ...o.env });
          if (o.env.HERMES_MANAGED_DIR)
            assert.match(
              readFileSync(join(o.env.HERMES_MANAGED_DIR, ".env"), "utf8"),
              /HERMES_WRITE_SAFE_ROOT=\/dev\/null/,
            );
          assert.equal(o.stdin, undefined, "pas de consigne sur stdin (la CLI ouvrirait son mode interactif)");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            outputLimitExceeded: false,
            durationMs: 1,
          };
        },
      },
    );
  const c = make("hermes-cli");
  await c.probe();
  await collect(
    c.start(request(dir, { prompt: "Fais X", permissionsPolicyId: "manual" }), new AbortController().signal),
  );
  await collect(
    c.start(request(dir, { prompt: "Fais Y", permissionsPolicyId: "autonomous" }), new AbortController().signal),
  );
  // Mode « validation » : worktree isolé + revue humaine, la CLI travaille sans question (personne pour répondre).
  assert.deepEqual(seen, [
    ["chat", "-Q", "--yolo", "-q", "Fais X"],
    ["chat", "-Q", "--yolo", "-q", "Fais Y"],
  ]);
  // Hermes en lecture seule : jeux d'outils sans écriture ni terminal, écriture de fichiers refusée partout.
  assert.equal(c.readOnlySupported, true);
  assert.equal(supportsReadOnly(c), true);
  const ro = await collect(
    c.start(request(dir, { prompt: "Relis", permissionsPolicyId: "read-only" }), new AbortController().signal),
  );
  assert.equal(ro.at(-1)?.kind, "completed");
  assert.deepEqual(seen.at(-1), ["chat", "-Q", "-t", "file,web,vision,todo,session_search", "-q", "Relis"]);
  assert.ok(!seen.at(-1)!.includes("--yolo"), "jamais d'auto-approbation en lecture seule");
  assert.equal(envs.at(-1)!.HERMES_WRITE_SAFE_ROOT, "/dev/null");
  // Générique sans mode lecture seule : refus explicite, jamais une exécution qui pourrait écrire.
  const bare = new GenericCliConnector(
    { signature: sig("hermes-cli", "fakecli"), args: ["chat"], promptVia: "last-arg" },
    { probeContext: { pathEnv: `${join(dir, "bin")}:${NODE_DIR}:/usr/bin:/bin` }, baseEnv: {} },
  );
  await bare.probe();
  assert.equal(supportsReadOnly(bare), false);
  const refused = await collect(
    bare.start(request(dir, { prompt: "Relis", permissionsPolicyId: "read-only" }), new AbortController().signal),
  );
  const last = refused.at(-1);
  assert.ok(last?.kind === "failed" && last.code === "policy_denied");
  // Gemini : mode plan (lecture seule) au lieu de --yolo.
  const g = make("gemini-cli");
  await g.probe();
  assert.equal(supportsReadOnly(g), true);
  await collect(
    g.start(request(dir, { prompt: "Relis", permissionsPolicyId: "read-only" }), new AbortController().signal),
  );
  assert.deepEqual(seen.at(-1), ["--skip-trust", "--approval-mode", "plan", "--prompt", "Relis"]);
});

test("bus de l'équipe : Claude, Gemini, Qwen, OpenCode et Codex le reçoivent sans jeton dans argv", () => {
  const s = [{ name: "nexus", command: "/usr/bin/node", args: ["/x/mcp.cjs"], env: { NEXUS_BUS_TOKEN: "t0k" } }];
  const mcp = claudeMcpConfig(s, "manual")!;
  const cl = mcp.args;
  assert.equal(cl[0], "--mcp-config");
  assert.ok(!cl.join(" ").includes("t0k"), "le jeton ne figure jamais dans argv");
  assert.deepEqual(JSON.parse(readFileSync(cl[1]!, "utf8")).mcpServers.nexus, {
    command: "/usr/bin/node",
    args: ["/x/mcp.cjs"],
    env: { NEXUS_BUS_TOKEN: "t0k" },
  });
  assert.deepEqual(cl.slice(2), ["--allowedTools", "mcp__nexus"], "outils autorisés en mode avec validation");
  mcp.cleanup();
  assert.throws(() => readFileSync(cl[1]!), "configuration temporaire supprimée");
  assert.deepEqual(claudeMcpConfig(s, "autonomous")!.args.length, 2);
  assert.deepEqual(claudeMcpArgs(undefined, "manual"), []);
  // Codex : commande et script dans argv, variables (jeton) dans l'environnement, transmises par `env_vars`.
  const cx = codexMcpConfig(s);
  assert.ok(!cx.args.join(" ").includes("t0k"), "jeton jamais dans argv (Codex)");
  assert.deepEqual(codexMcpArgs(s), cx.args);
  assert.deepEqual(cx.args, [
    "-c",
    'mcp_servers.nexus.command="/usr/bin/node"',
    "-c",
    'mcp_servers.nexus.args=["/x/mcp.cjs"]',
    "-c",
    'mcp_servers.nexus.env_vars=["NEXUS_BUS_TOKEN"]',
    "-c",
    "mcp_servers.nexus.tool_timeout_sec=300",
    "-c",
    'mcp_servers.nexus.default_tools_approval_mode="approve"',
  ]);
  assert.deepEqual(cx.env, { NEXUS_BUS_TOKEN: "t0k" });
  assert.deepEqual(codexMcpConfig(undefined), { args: [], env: {} });
  for (const [id, env] of [
    ["gemini-cli", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"],
    ["qwen-cli", "QWEN_CODE_SYSTEM_SETTINGS_PATH"],
    ["opencode-cli", "OPENCODE_CONFIG"],
  ] as const) {
    const m = mcpConfigFor(id, s)!;
    const file = m.env[env]!;
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(
      id === "opencode-cli" ? cfg.mcp.nexus.command[0] === "/usr/bin/node" : cfg.mcpServers.nexus.trust === true,
      id,
    );
    m.cleanup();
    assert.throws(() => readFileSync(file), "fichier temporaire supprimé");
  }
  assert.equal(mcpConfigFor("hermes-cli", s), undefined, "Hermes : voir hermesScope");
  assert.equal(stripAnsi("\x1b[0m> build\x1b[32m ok\x1b[0m"), "> build ok");
});

test("AsyncQueue : `return()` (consommateur qui abandonne) libère la file et prévient le producteur", async () => {
  let stopped = 0;
  const q = new AsyncQueue<number>({ onReturn: () => stopped++ });
  q.push(1);
  q.push(2);
  for await (const n of q) {
    assert.equal(n, 1);
    break; // appelle return()
  }
  assert.equal(stopped, 1, "le producteur est prévenu (ex. arrêt de la CLI)");
  q.push(3);
  const it = q[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: undefined, done: true }, "rien ne s'accumule après abandon");
});

test("runCliTask : une exception du normaliseur sur une ligne ne devient jamais une uncaughtException", async (t) => {
  const dir = binDir(t, {});
  const events = await collect(
    runCliTask({
      taskId: randomUUID(),
      file: "/bin/sh",
      args: [],
      cwd: dir,
      env: {},
      timeoutMs: 5000,
      signal: new AbortController().signal,
      normalizer: {
        onStdout(line, seq) {
          if (line === "boom") throw new Error("parser cassé");
          seq.emit({ kind: "output", text: line, channel: "stdout" });
        },
        finish(_exit, seq) {
          seq.emit({ kind: "completed", resultRef: "x" });
        },
      },
      runner: async (o) => {
        o.onLine?.("boom", "stdout");
        o.onLine?.("ok", "stdout");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          outputLimitExceeded: false,
          durationMs: 1,
        };
      },
    }),
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ["output", "completed"],
  );
});

test("Hermes : reprise native par `--resume`, identifiant de session lu sur stderr (jamais affiché)", async (t) => {
  const dir = binDir(t, { fakecli: "fake-plain.mjs" });
  const seen: string[][] = [];
  const c = new GenericCliConnector(
    { signature: sig("hermes-cli", "fakecli"), ...GENERIC_INVOCATIONS["hermes-cli"]! },
    {
      probeContext: { pathEnv: `${join(dir, "bin")}:${NODE_DIR}:/usr/bin:/bin` },
      baseEnv: { PATH: `${NODE_DIR}:/usr/bin:/bin`, FAKE_SESSION: "20261017_003813_1822a7" },
      runner: async (o) => {
        seen.push([...o.args]);
        const { runProcess } = await import("@nexus/process-supervisor");
        return runProcess(o);
      },
    },
  );
  await c.probe();
  const events = await collect(c.start(request(dir, { prompt: "Fais X" }), new AbortController().signal));
  const done = events.at(-1);
  assert.ok(done?.kind === "completed" && done.nativeSessionId === "20261017_003813_1822a7", JSON.stringify(done));
  assert.ok(!events.some((e) => e.kind === "output" && e.text.includes("session_id")), "identifiant non affiché");
  assert.ok(c.resume, "reprise native disponible");
  await collect(c.resume("20261017_003813_1822a7", request(dir, { prompt: "Suite" }), new AbortController().signal));
  assert.deepEqual(seen.at(-1), ["chat", "-Q", "--resume", "20261017_003813_1822a7", "--yolo", "-q", "Suite"]);
  assert.equal(parseHermesSessionId("session_id: abc_1"), "abc_1");
  assert.equal(parseHermesSessionId("le session_id: abc"), undefined);
  // Les CLI sans reprise native n'en annoncent pas.
  const g = new GenericCliConnector(
    { signature: sig("gemini-cli", "fakecli"), ...GENERIC_INVOCATIONS["gemini-cli"]! },
    { probeContext: { pathEnv: "" }, baseEnv: {} },
  );
  assert.equal(g.resume, undefined);
});

test("Hermes : ajout du serveur MCP au texte de la configuration, sans l'analyser ni deviner", () => {
  const s = [{ name: "nexus", command: "/usr/bin/node", args: ["/x/mcp.cjs"], env: { NEXUS_BUS_TOKEN: "t0k" } }];
  const entry =
    'nexus: {"command":"/usr/bin/node","args":["/x/mcp.cjs"],"env":{"NEXUS_BUS_TOKEN":"t0k"},"timeout":300,"connect_timeout":30}';
  assert.equal(injectHermesMcpServers("", s), `mcp_servers:\n  ${entry}\n`);
  assert.equal(
    injectHermesMcpServers("model:\n  default: x\n", s),
    `model:\n  default: x\nmcp_servers:\n  ${entry}\n`,
    "bloc ajouté à la fin, le reste intact",
  );
  assert.equal(
    injectHermesMcpServers("mcp_servers:  # mes serveurs\n    github:\n      command: gh\nmodel: x\n", s),
    `mcp_servers:  # mes serveurs\n    ${entry}\n    github:\n      command: gh\nmodel: x\n`,
    "entrée ajoutée avec l'indentation existante",
  );
  assert.equal(injectHermesMcpServers("mcp_servers: {}\nmodel: x\n", s), `mcp_servers:\n  ${entry}\nmodel: x\n`);
  assert.equal(injectHermesMcpServers("mcp_servers: {a: {command: b}}\n", s), undefined, "table en ligne : refus");
  assert.equal(injectHermesMcpServers("mcp_servers:\n  nexus:\n    command: autre\n", s), undefined, "nom déjà pris");
});

test("Hermes : HERMES_HOME de remplacement (liens, configuration complétée, droits), lecture seule, hooks, nettoyage", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nexus-hermes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const real = join(home, ".hermes");
  mkdirSync(join(real, "sessions"), { recursive: true });
  writeFileSync(join(real, "auth.json"), '{"fake":true}');
  writeFileSync(join(real, "config.yaml"), "model:\n  default: fake-model\n");
  const s = [{ name: "nexus", command: "/usr/bin/node", args: ["/x/mcp.cjs"], env: { NEXUS_BUS_TOKEN: "t0k" } }];
  const base = join(root, "rt");
  const none = join(root, "pas-de-portee-admin");
  const scope = hermesScope({ servers: s, readOnly: true, baseDir: base, home, env: {}, systemManagedDir: none })!;
  const overlay = scope.env.HERMES_HOME!;
  assert.equal(
    dirname(overlay).endsWith("profiles"),
    true,
    "Hermes fait confiance à HERMES_HOME (pas de profil actif suivi)",
  );
  assert.equal(statSync(base).mode & 0o777, 0o700);
  assert.equal(statSync(scope.dir!).mode & 0o777, 0o700);
  assert.equal(statSync(join(overlay, "config.yaml")).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(overlay, "auth.json")).isSymbolicLink(), true, "connexion de l'utilisateur partagée");
  assert.equal(lstatSync(join(overlay, "sessions")).isSymbolicLink(), true, "sessions écrites dans le vrai dossier");
  assert.equal(lstatSync(join(overlay, "config.yaml")).isSymbolicLink(), false);
  const cfg = readFileSync(join(overlay, "config.yaml"), "utf8");
  assert.match(cfg, /^model:\n {2}default: fake-model\n/, "configuration de l'utilisateur conservée");
  assert.match(cfg, /\nmcp_servers:\n {2}nexus: \{"command":"\/usr\/bin\/node"/);
  assert.equal(readFileSync(join(real, "config.yaml"), "utf8"), "model:\n  default: fake-model\n", "original intact");
  assert.deepEqual(scope.args, ["-t", "file,web,vision,todo,session_search,nexus"]);
  assert.equal(scope.env.HERMES_WRITE_SAFE_ROOT, "/dev/null");
  const managed = scope.env.HERMES_MANAGED_DIR!;
  assert.equal(readFileSync(join(managed, ".env"), "utf8"), "HERMES_WRITE_SAFE_ROOT=/dev/null\n");
  assert.equal(statSync(join(managed, ".env")).mode & 0o777, 0o600);
  // Écritures de Hermes pendant l'exécution : par les liens dans le vrai dossier, nouvelles entrées rapatriées.
  writeFileSync(join(overlay, "sessions", "s1.json"), "{}");
  writeFileSync(join(overlay, "state.db"), "db");
  scope.cleanup();
  assert.equal(existsSync(scope.dir!), false, "fichiers temporaires (jeton) supprimés");
  assert.equal(readFileSync(join(real, "sessions", "s1.json"), "utf8"), "{}");
  assert.equal(readFileSync(join(real, "state.db"), "utf8"), "db", "nouvelle entrée rapatriée");
  assert.equal(readFileSync(join(real, "auth.json"), "utf8"), '{"fake":true}', "liens supprimés, jamais suivis");
  assert.deepEqual(readdirSync(base), []);

  // Portée gérée de l'administrateur : jamais masquée ; la lecture seule reste appliquée (argv + environnement).
  mkdirSync(none);
  const admin = hermesScope({ readOnly: true, baseDir: base, home, systemManagedDir: none })!;
  assert.equal(admin.env.HERMES_MANAGED_DIR, undefined);
  assert.equal(admin.env.HERMES_WRITE_SAFE_ROOT, "/dev/null");
  assert.deepEqual(admin.args, ["-t", "file,web,vision,todo,session_search"]);
  admin.cleanup();

  // Hooks d'état (sessions interactives) : commandes sans shell implicite, accord automatique seulement sans hooks.
  const hooks = hermesScope({
    statusHooks: { autoAccept: true },
    baseDir: base,
    home,
    systemManagedDir: join(root, "x"),
  })!;
  const hc = JSON.parse(readFileSync(join(hooks.env.HERMES_MANAGED_DIR!, "config.yaml"), "utf8"));
  assert.equal(hc.hooks_auto_accept, true);
  assert.deepEqual(hc.hooks.on_session_end, [
    { command: `/bin/sh -c 'printf "idle\\n" >> "$NEXUS_HOOK_FILE"'`, timeout: 5 },
  ]);
  assert.match(hc.hooks.pre_approval_request[0].command, /needs_input/);
  assert.equal(hooks.args.length, 0);
  hooks.cleanup();
  const asked = hermesScope({
    statusHooks: { autoAccept: false },
    baseDir: base,
    home,
    systemManagedDir: join(root, "x"),
  })!;
  assert.equal(
    JSON.parse(readFileSync(join(asked.env.HERMES_MANAGED_DIR!, "config.yaml"), "utf8")).hooks_auto_accept,
    undefined,
  );
  asked.cleanup();
  assert.equal(hermesScope({ baseDir: base, home }), undefined, "rien à préparer");

  // Dossier de l'utilisateur : HERMES_HOME, profil actif.
  assert.equal(hermesUserHome(home, { HERMES_HOME: "/opt/h" }), "/opt/h");
  mkdirSync(join(real, "profiles", "coder"), { recursive: true });
  writeFileSync(join(real, "active_profile"), "coder\n");
  assert.equal(hermesUserHome(home), join(real, "profiles", "coder"));
});

test("Codex : le jeton du bus passe par l'environnement du processus, jamais par argv", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-codex-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
  const c = new CodexCliConnector({
    probeContext: { pathEnv: "" },
    baseEnv: { HOME: dir },
    resolvePermissionMode: modes("read-only"),
    binaryPath: "/usr/bin/true",
    runner: async (o) => {
      seen.push({ args: o.args, env: { ...o.env } });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        outputLimitExceeded: false,
        durationMs: 1,
      };
    },
  });
  const s = [{ name: "nexus", command: "/usr/bin/node", args: ["/x/mcp.cjs"], env: { NEXUS_BUS_TOKEN: "t0k" } }];
  await collect(c.start(request(dir, { mcpServers: s }), new AbortController().signal));
  await collect(c.resume!("thread-1", request(dir, { mcpServers: s }), new AbortController().signal));
  for (const r of seen) {
    assert.ok(!r.args.join(" ").includes("t0k"));
    assert.equal(r.env.NEXUS_BUS_TOKEN, "t0k");
    assert.equal(r.env.HOME, dir, "CODEX_HOME de l'utilisateur inchangé : sa connexion reste chargée");
    assert.ok(r.args.includes('mcp_servers.nexus.env_vars=["NEXUS_BUS_TOKEN"]'));
  }
});
