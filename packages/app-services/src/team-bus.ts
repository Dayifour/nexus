// Bus de l'équipe (Orchestre) : les agents se parlent pendant qu'ils travaillent.
// Chaque agent reçoit un serveur MCP « nexus » (script autonome, protocole MCP sur stdio) qui relaie ses appels vers
// ce bus par une socket Unix privée (tube nommé `\\.\pipe\nexus-<aléa>` sous Windows), avec un jeton propre à sa
// tâche. Outils : état de l'équipe, message à un coéquipier ou à tous, lecture de ses messages, question au chef
// d'orchestre (réponse renvoyée à l'agent).
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSpec } from "@nexus/contracts";

export type BusIdentity = { missionId: string; taskId: string; role: string };
export type BusHandlers = {
  status(id: BusIdentity): Promise<string>;
  send(id: BusIdentity, to: string, text: string): Promise<string>;
  read(id: BusIdentity): Promise<string>;
  ask(id: BusIdentity, question: string): Promise<string>;
};

/** Serveur MCP minimal (aucune dépendance), exécuté par la CLI de l'agent. */
export const MCP_SCRIPT = String.raw`"use strict";
// Serveur MCP « nexus » : relaie les outils de l'équipe vers Nexus AI (socket Unix ou tube nommé + jeton de la tâche).
const net = require("net");
const readline = require("readline");
const SOCKET = process.env.NEXUS_BUS_SOCKET, TOKEN = process.env.NEXUS_BUS_TOKEN;
const TOOLS = [
  { name: "team_status", description: "État de l'équipe : objectif, plan, tâches (qui fait quoi, statut) et derniers échanges.", inputSchema: { type: "object", properties: {} } },
  { name: "send_message", description: "Envoie un message à un coéquipier (son rôle, ex. « Codex CLI »), au chef (« lead ») ou à tous (« all ») : interface à respecter, fichier créé, point de blocage…", inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] } },
  { name: "read_messages", description: "Lit les messages reçus de l'équipe et du chef depuis la dernière lecture.", inputSchema: { type: "object", properties: {} } },
  { name: "ask_lead", description: "Pose une question au chef d'orchestre quand une information te manque ; renvoie sa réponse (peut prendre une minute).", inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
];
function call(op, args) {
  return new Promise((resolve) => {
    const s = net.connect(SOCKET); let buf = "";
    s.on("connect", () => s.write(JSON.stringify({ token: TOKEN, op, args }) + "\n"));
    s.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { s.end(); try { const r = JSON.parse(buf.slice(0, i)); resolve(r.ok ? String(r.result) : "Erreur : " + r.error); } catch { resolve("Erreur : réponse illisible"); } } });
    s.on("error", (e) => resolve("Erreur : bus de l'équipe indisponible (" + e.code + ")"));
    s.setTimeout(300000, () => { s.destroy(); resolve("Erreur : délai dépassé"); });
  });
}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "nexus-team", version: "1.0.0" } } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const name = params && params.name, a = (params && params.arguments) || {};
    if (!TOOLS.some((t) => t.name === name)) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "outil inconnu" } });
    const text = await call(name, a);
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: text.startsWith("Erreur") } });
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "méthode inconnue" } });
});
`;

export class TeamBus {
  readonly #handlers: BusHandlers;
  readonly #tokens = new Map<string, BusIdentity>();
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #dir: string | undefined;
  #script: string | undefined;
  socketPath: string | undefined;

  constructor(handlers: BusHandlers) {
    this.#handlers = handlers;
  }

  /** Vrai une fois `start` réussi : sinon `register` ne fournit aucun serveur MCP (ne pas annoncer les outils). */
  get available(): boolean {
    return this.#listening;
  }
  #listening = false;

  /**
   * Démarre le transport et écrit le script MCP. Unix : socket dans un dossier privé 0700 (chemin court).
   * Windows : tube nommé au nom aléatoire (l'accès reste conditionné au jeton de la tâche).
   * Rejette avec une erreur explicite si le transport ne peut pas écouter ; le bus reste alors indisponible.
   */
  async start(scriptDir: string): Promise<void> {
    if (this.#server) return;
    mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
    const script = join(scriptDir, "nexus-team-mcp.cjs");
    writeFileSync(script, MCP_SCRIPT, { mode: 0o600 });
    let path: string;
    if (process.platform === "win32") {
      path = `\\\\.\\pipe\\nexus-${randomBytes(16).toString("hex")}`;
    } else {
      this.#dir = mkdtempSync(join(tmpdir(), "nexus-bus-"));
      chmodSync(this.#dir, 0o700);
      path = join(this.#dir, "bus.sock");
    }
    const server = createServer((s) => this.#serve(s));
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => resolve());
      });
      if (process.platform !== "win32") chmodSync(path, 0o600);
    } catch (e) {
      server.close();
      this.#server = undefined;
      if (this.#dir) rmSync(this.#dir, { recursive: true, force: true });
      this.#dir = undefined;
      throw new Error(`team bus: transport unavailable (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    this.#script = script;
    this.socketPath = path;
    this.#listening = true;
  }

  #serve(s: Socket): void {
    this.#sockets.add(s);
    s.once("close", () => this.#sockets.delete(s));
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.length > 64 * 1024) return s.destroy();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = "";
      void this.#handle(line).then((r) => s.end(`${JSON.stringify(r)}\n`));
    });
    s.on("error", () => undefined);
  }

  async #handle(line: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    let req: { token?: unknown; op?: unknown; args?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      return { ok: false, error: "requête illisible" };
    }
    const id = typeof req.token === "string" ? this.#tokens.get(req.token) : undefined;
    if (!id) return { ok: false, error: "jeton inconnu ou expiré" };
    const a = req.args ?? {};
    const str = (k: string, max = 8000) => (typeof a[k] === "string" ? (a[k] as string).slice(0, max) : "");
    try {
      switch (req.op) {
        case "team_status":
          return { ok: true, result: await this.#handlers.status(id) };
        case "send_message":
          if (!str("to") || !str("text")) return { ok: false, error: "destinataire et texte requis" };
          return { ok: true, result: await this.#handlers.send(id, str("to", 120), str("text")) };
        case "read_messages":
          return { ok: true, result: await this.#handlers.read(id) };
        case "ask_lead":
          if (!str("question")) return { ok: false, error: "question requise" };
          return { ok: true, result: await this.#handlers.ask(id, str("question")) };
        default:
          return { ok: false, error: "outil inconnu" };
      }
    } catch (e) {
      return { ok: false, error: ((e as Error).message || "échec").slice(0, 500) };
    }
  }

  /** Jeton d'une tâche (valable jusqu'à `revoke`) et serveur MCP à donner à son agent. */
  register(id: BusIdentity): McpServerSpec | undefined {
    if (!this.socketPath || !this.#script) return undefined;
    const token = randomBytes(24).toString("base64url");
    for (const [t, v] of this.#tokens) if (v.taskId === id.taskId) this.#tokens.delete(t);
    this.#tokens.set(token, id);
    return {
      name: "nexus",
      command: process.execPath,
      args: [this.#script],
      // ELECTRON_RUN_AS_NODE : dans l'application, le binaire d'Electron exécute le script comme Node.
      env: { NEXUS_BUS_SOCKET: this.socketPath, NEXUS_BUS_TOKEN: token, ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  revokeMission(missionId: string): void {
    for (const [t, v] of this.#tokens) if (v.missionId === missionId) this.#tokens.delete(t);
  }

  async close(): Promise<void> {
    this.#listening = false;
    this.socketPath = undefined;
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
    this.#server = undefined;
    if (this.#dir) rmSync(this.#dir, { recursive: true, force: true });
    this.#dir = undefined;
  }
}
