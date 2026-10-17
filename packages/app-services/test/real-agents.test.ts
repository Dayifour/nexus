// Vérifications RÉELLES avec les CLI installés et connectés sur la machine (Hermes Agent, Codex CLI).
// Désactivé par défaut (consomme des requêtes chez les fournisseurs) : NEXUS_REAL_AGENTS=1 pour l'exécuter.
// Une consigne courte par vérification ; bus de l'équipe réel (socket + serveur MCP stdio de Nexus).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTaskRequest } from "@nexus/contracts";
import {
  CLI_SIGNATURES,
  CodexCliConnector,
  GENERIC_INVOCATIONS,
  GenericCliConnector,
  hermesScope,
  supportsReadOnly,
} from "@nexus/connectors";
import { TeamBus } from "../src/team-bus.ts";

const REAL = process.env.NEXUS_REAL_AGENTS === "1";
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const baseEnv = { HOME: homedir(), PATH, LANG: "C.UTF-8", NO_COLOR: "1" };
const MARK = "NEXUS-STATUS-7431";

function request(ws: string, prompt: string, over: Partial<AgentTaskRequest> = {}): AgentTaskRequest {
  return {
    taskId: randomUUID(),
    projectId: randomUUID(),
    sessionId: randomUUID(),
    agentProfileId: randomUUID(),
    workspacePath: ws,
    prompt,
    contextRefs: [],
    permissionsPolicyId: "manual",
    timeoutMs: 300_000,
    ...over,
  };
}
async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const text = (ev: AgentEvent[]) =>
  ev
    .filter((e) => e.kind === "output")
    .map((e) => (e as { text: string }).text)
    .join("\n");

async function withBus(t: { after: (fn: () => unknown) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-real-bus-"));
  const calls: string[] = [];
  const bus = new TeamBus({
    status: async (id) => (calls.push(`status:${id.role}`), `${MARK} (tu es ${id.role})`),
    send: async (id, to) => (calls.push(`send:${id.role}->${to}`), "ok"),
    read: async () => (calls.push("read"), "Aucun nouveau message."),
    ask: async () => (calls.push("ask"), "Continue."),
  });
  await bus.start(dir);
  t.after(async () => {
    await bus.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { bus, calls };
}

test(
  "Hermes RÉEL : chef en lecture seule sur le bus (team_status), écriture refusée, puis reprise native et hooks d'état",
  { skip: !REAL && "opt-in NEXUS_REAL_AGENTS=1", timeout: 900_000 },
  async (t) => {
    const ws = mkdtempSync(join(tmpdir(), "nexus-real-hermes-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "nexus-real-rt-"));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
    const { bus, calls } = await withBus(t);
    const signature = CLI_SIGNATURES.find((s) => s.connectorId === "hermes-cli")!;
    const c = new GenericCliConnector(
      { signature, ...GENERIC_INVOCATIONS["hermes-cli"]! },
      { probeContext: { pathEnv: PATH, home: homedir() }, baseEnv, runtimeDir },
    );
    assert.equal((await c.probe()).installed, true, "Hermes installé");
    assert.equal(supportsReadOnly(c), true);
    const spec = bus.register({ missionId: "m", taskId: "t1", role: "Chef" })!;
    const ev = await collect(
      c.start(
        request(
          ws,
          "Do exactly two things. 1) Call the MCP tool team_status (server nexus) and copy the first word it returns. " +
            "2) Try to create the file proof.txt containing 'hi' in the current directory with your file tools. " +
            "Then answer on one line: STATUS=<first word> WRITE=<ok or refused>.",
          { permissionsPolicyId: "read-only", mcpServers: [spec] },
        ),
        new AbortController().signal,
      ),
    );
    const out = text(ev);
    console.log("[hermes lecture seule]", out.slice(-800));
    const last = ev.at(-1);
    assert.equal(last?.kind, "completed", JSON.stringify(last));
    assert.ok(calls.includes("status:Chef"), `team_status appelé via le bus (${calls.join(",")})`);
    assert.ok(out.includes(MARK), "réponse du bus relayée");
    assert.equal(existsSync(join(ws, "proof.txt")), false, "aucun fichier écrit en lecture seule");
    assert.deepEqual(readdirSync(runtimeDir), [], "portée gérée supprimée à la fin");
    const sid = last?.kind === "completed" ? last.nativeSessionId : undefined;
    assert.ok(sid, "identifiant de session natif rapporté");

    // Reprise native (même conversation) avec les hooks d'état des sessions interactives.
    const hookDir = mkdtempSync(join(tmpdir(), "nexus-real-hooks-"));
    t.after(() => rmSync(hookDir, { recursive: true, force: true }));
    const hookFile = join(hookDir, "status");
    const scope = hermesScope({ statusHooks: { autoAccept: true }, readOnly: true, baseDir: hookDir })!;
    const r = spawnSync(
      (await c.probe()).path!,
      [
        "chat",
        "-Q",
        "--resume",
        sid!,
        ...scope.args,
        "-q",
        "What was the first word team_status returned? Reply with it only.",
      ],
      { cwd: ws, env: { ...baseEnv, ...scope.env, NEXUS_HOOK_FILE: hookFile }, encoding: "utf8", timeout: 300_000 },
    );
    scope.cleanup();
    console.log(
      "[hermes reprise]",
      r.stdout.trim().slice(-300),
      "| hooks :",
      readFileSync(hookFile, "utf8").trim().split("\n").join(","),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(MARK.split("-")[0]!), "la session reprise se souvient du résultat");
    const hooks = readFileSync(hookFile, "utf8");
    assert.match(hooks, /working/);
    assert.match(hooks, /idle/);
  },
);

test(
  "Codex RÉEL : connexion de l'utilisateur conservée et outil team_status du bus disponible (jeton hors argv)",
  { skip: !REAL && "opt-in NEXUS_REAL_AGENTS=1", timeout: 600_000 },
  async (t) => {
    const ws = mkdtempSync(join(tmpdir(), "nexus-real-codex-"));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const { bus, calls } = await withBus(t);
    const spec = bus.register({ missionId: "m", taskId: "t2", role: "Codex CLI" })!;
    const seenArgs: string[][] = [];
    const c = new CodexCliConnector({
      probeContext: { pathEnv: PATH, home: homedir() },
      baseEnv,
      resolvePermissionMode: () => "read-only",
      runner: async (o) => {
        seenArgs.push([...o.args]);
        const { runProcess } = await import("@nexus/process-supervisor");
        return runProcess(o);
      },
    });
    assert.equal((await c.probe()).installed, true, "Codex installé");
    const ev = await collect(
      c.start(
        request(
          ws,
          "Call the MCP tool team_status (server nexus) and reply with the first word it returns, nothing else.",
          {
            permissionsPolicyId: "read-only",
            mcpServers: [spec],
          },
        ),
        new AbortController().signal,
      ),
    );
    const out = text(ev);
    console.log("[codex]", out.slice(-500), JSON.stringify(ev.at(-1)));
    assert.ok(!seenArgs.flat().join(" ").includes(spec.env.NEXUS_BUS_TOKEN!), "jeton jamais dans argv");
    assert.equal(ev.at(-1)?.kind, "completed", JSON.stringify(ev.at(-1)));
    assert.ok(calls.includes("status:Codex CLI"), `team_status appelé via le bus (${calls.join(",")})`);
    assert.ok(out.includes(MARK), "réponse du bus relayée");
  },
);
