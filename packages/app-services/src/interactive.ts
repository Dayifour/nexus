// Sessions d'agent INTERACTIVES : la vraie interface (TUI) du CLI tourne dans un terminal PTY et l'utilisateur y tape
// directement. En mode « Autonome en sandbox », le terminal entier tourne dans la sandbox.
// L'état de l'agent vient de ses hooks (Claude : UserPromptSubmit, Notification, Stop… ; Hermes : pre_llm_call,
// pre_approval_request, on_session_end…), écrits dans un fichier que Nexus surveille : on ne devine jamais l'état à
// partir du texte affiché.
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcPushEvent, PermissionMode } from "@nexus/contracts";
import { hermesScope, hermesUserHasHooks, hermesUserHome } from "@nexus/connectors";
import { SYSTEM } from "@nexus/core";
import type { NexusCore } from "@nexus/core";
import { sandboxUsable, type SandboxCapabilities } from "@nexus/sandbox";
import { prepareInteractiveSandbox } from "./sandbox-run.ts";
import type { SettingsStore } from "./settings.ts";
import type { TerminalManager } from "./terminals.ts";

export type AgentStatus = "starting" | "working" | "idle" | "needs_input" | "done" | "error";
const STATUSES: readonly AgentStatus[] = ["working", "idle", "needs_input"];

/** Arguments de la TUI de chaque CLI connu. `sessionId` permet la reprise (Claude : identifiant = tâche). */
export function interactiveArgs(
  connectorId: string,
  mode: PermissionMode,
  o: { prompt?: string; sessionId: string; resume: boolean; settingsPath?: string },
): string[] {
  const free = mode === "autonomous" || mode === "sandbox-auto";
  switch (connectorId) {
    case "claude-cli":
      return [
        ...(o.resume ? ["--resume", o.sessionId] : ["--session-id", o.sessionId]),
        "--permission-mode",
        free ? "bypassPermissions" : "default",
        ...(o.settingsPath ? ["--settings", o.settingsPath] : []),
        ...(o.prompt ? [o.prompt] : []),
      ];
    case "codex-cli":
      return [
        ...(o.resume ? ["resume", "--last"] : []),
        ...(mode === "sandbox-auto"
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : mode === "autonomous"
            ? ["--sandbox", "danger-full-access", "--ask-for-approval", "never"]
            : []),
        ...(o.prompt && !o.resume ? [o.prompt] : []),
      ];
    case "gemini-cli":
    case "qwen-cli":
      return [
        ...(connectorId === "gemini-cli" ? ["--skip-trust"] : []),
        ...(o.resume ? (connectorId === "gemini-cli" ? ["--resume", "latest"] : ["--continue"]) : []),
        ...(free ? ["--yolo"] : []),
        ...(o.prompt && !o.resume ? ["--prompt-interactive", o.prompt] : []),
      ];
    // Hermes : pas d'option de consigne initiale en mode interactif ; elle est tapée dans le terminal (voir `typedPrompt`).
    case "hermes-cli":
      return [...(o.resume ? ["--continue"] : []), ...(free ? ["--yolo"] : [])];
    case "opencode-cli":
      return [...(o.resume ? ["--continue"] : []), ...(o.prompt && !o.resume ? ["--prompt", o.prompt] : [])];
    // Autres CLI : un argument libre serait mal interprété ; consigne tapée dans le terminal.
    default:
      return [];
  }
}

/** Vrai si la consigne initiale doit être tapée dans la TUI (CLI sans option de consigne interactive). */
export function typedPrompt(connectorId: string): boolean {
  return !["claude-cli", "codex-cli", "gemini-cli", "qwen-cli", "opencode-cli"].includes(connectorId);
}

/** Réglages Claude injectés via `--settings` : chaque hook ajoute une ligne d'état au fichier surveillé. */
export function claudeHookSettings(): string {
  const cmd = (s: AgentStatus) => [{ hooks: [{ type: "command", command: `printf '${s}\\n' >> "$NEXUS_HOOK_FILE"` }] }];
  return JSON.stringify({
    hooks: {
      UserPromptSubmit: cmd("working"),
      PostToolUse: cmd("working"),
      Notification: cmd("needs_input"),
      Stop: cmd("idle"),
    },
  });
}

type Deps = {
  core: NexusCore;
  terminals: TerminalManager;
  settings: SettingsStore;
  sandbox: SandboxCapabilities;
  home: string;
  userEnv: () => Record<string, string>;
  pathEnv: string;
  push: (e: IpcPushEvent) => void;
  /** Dossier des enregistrements de terminal des sessions. */
  transcriptsDir: string;
};

/** Questions de confiance dans le dossier, telles qu'affichées par les TUI (espaces parfois supprimés par le rendu). */
// Codex : « Trust this folder? », première option « Trust and continue » → Entrée.
// Claude : « Quick safety check… », première option « No, exit » → flèche bas vers « Yes, I trust this folder » puis Entrée.
const TRUST_PROMPTS: Array<{ re: RegExp; keys: string[] }> = [
  { re: /Yes,?\s*I\s*trust\s*this\s*folder/i, keys: ["\x1b[B", "\r"] },
  { re: /Trust\s*this\s*folder\?/i, keys: ["\r"] },
];

/** Au-delà, seule la fin de l'enregistrement est conservée. */
const TRANSCRIPT_MAX = 4 * 1024 * 1024;

export type InteractiveStart = {
  taskId: string;
  connectorId: string;
  binary: string;
  mode: PermissionMode;
  workspace: string;
  protectEnvFiles: boolean;
  prompt?: string;
  resume: boolean;
  /** Identifiant de session natif à reprendre (par défaut : l'identifiant de la tâche). */
  sessionId?: string;
  cols: number;
  rows: number;
};

export class InteractiveSessions {
  readonly #d: Deps;
  readonly #byTask = new Map<string, { terminalId: string; status: AgentStatus }>();

  constructor(deps: Deps) {
    this.#d = deps;
  }

  /** Session interactive en cours pour cette tâche (terminal et dernier état). */
  get(taskId: string): { terminalId: string; status: AgentStatus } | undefined {
    return this.#byTask.get(taskId);
  }

  #status(taskId: string, status: AgentStatus): void {
    const s = this.#byTask.get(taskId);
    if (s) s.status = status;
    this.#d.push({ type: "agent-status", taskId, status });
  }

  async start(o: InteractiveStart): Promise<string> {
    if (this.#byTask.has(o.taskId)) throw new Error("session_already_open");
    const { core } = this.#d;
    // Transitions validées : (draft →) ready → queued → running.
    let status = (await core.missions.getTask(o.taskId)).status;
    if (status === "draft") {
      await core.missions.transition(o.taskId, "ready", SYSTEM);
      status = "ready";
    }
    // Reprise d'une session déjà terminée (mode autonome) : la conversation rouvre, l'état de la tâche ne change pas.
    const track = status !== "completed";
    if (["ready", "interrupted", "failed", "waiting_review"].includes(status)) {
      await core.missions.transition(o.taskId, "queued", SYSTEM, o.resume ? { reason: "resume" } : {});
    }
    if (track) {
      const attempt = (await core.missions.getTask(o.taskId)).attempt + 1;
      await core.missions.transition(o.taskId, "running", SYSTEM, { attempt });
    }

    const hookDir = mkdtempSync(join(tmpdir(), "nexus-hooks-"));
    const hookFile = join(hookDir, "status");
    writeFileSync(hookFile, "");
    let settingsPath: string | undefined;
    const extraEnv: Record<string, string> = { NEXUS_HOOK_FILE: hookFile };
    if (o.connectorId === "claude-cli") {
      settingsPath = join(hookDir, "settings.json");
      writeFileSync(settingsPath, claudeHookSettings());
    } else if (o.connectorId === "hermes-cli") {
      // Hooks d'état par la portée gérée de Hermes, dans le dossier des hooks (visible dans la sandbox, supprimé à la fin).
      const userEnv = this.#d.userEnv();
      const scope = hermesScope({
        statusHooks: { autoAccept: !hermesUserHasHooks(hermesUserHome(this.#d.home, userEnv)) },
        baseDir: hookDir,
        home: this.#d.home,
        env: userEnv,
      });
      if (scope?.env.HERMES_MANAGED_DIR) Object.assign(extraEnv, scope.env);
    }
    const args = interactiveArgs(o.connectorId, o.mode, {
      ...(o.prompt !== undefined && { prompt: o.prompt }),
      sessionId: o.sessionId ?? o.taskId,
      resume: o.resume,
      ...(settingsPath && { settingsPath }),
    });

    let command: { file: string; args: string[]; env: Record<string, string> };
    let cleanup = async () => {};
    try {
      if (o.mode === "sandbox-auto") {
        if (!sandboxUsable(this.#d.sandbox)) throw new Error("sandbox_unavailable");
        const sb = await prepareInteractiveSandbox(o.binary, args, o.workspace, {
          caps: this.#d.sandbox,
          connectorId: o.connectorId,
          home: this.#d.home,
          protectEnvFiles: o.protectEnvFiles,
          extraAllow: this.#d.settings.get().sandboxExtraAllow,
          extraWritable: [hookDir],
          pathEnv: this.#d.pathEnv,
          extraEnv,
          onDenied: (target, reason) => this.#d.push({ type: "sandbox-denied", taskId: o.taskId, target, reason }),
        });
        command = sb;
        cleanup = sb.cleanup;
      } else {
        command = { file: o.binary, args, env: { ...this.#d.userEnv(), ...extraEnv } };
      }
    } catch (e) {
      rmSync(hookDir, { recursive: true, force: true });
      if (track)
        await core.missions
          .transition(o.taskId, "failed", SYSTEM, { failureCode: "spawn_failed" })
          .catch(() => undefined);
      throw e;
    }

    // Lecture incrémentale du fichier de hooks.
    let offset = 0;
    // Hermes : hooks demandés, mais une interface sans hooks (TUI, portée gérée de l'administrateur) reste possible ;
    // l'activité du terminal sert d'indication jusqu'au premier hook reçu.
    let hooksSeen = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const poll = setInterval(() => {
      try {
        const size = statSync(hookFile).size;
        if (size <= offset) return;
        const fd = openSync(hookFile, "r");
        const buf = Buffer.alloc(Math.min(size - offset, 64 * 1024));
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset += buf.length;
        // Chaque changement d'état est relayé (même plusieurs entre deux lectures), sans doublons consécutifs.
        for (const line of buf.toString("utf8").split("\n")) {
          const s = line.trim() as AgentStatus;
          if (!STATUSES.includes(s)) continue;
          // Premier hook reçu : l'état vient désormais des hooks, plus de l'activité du terminal.
          hooksSeen = true;
          if (quiet) clearTimeout(quiet);
          if (this.#byTask.get(o.taskId)?.status !== s) this.#status(o.taskId, s);
        }
      } catch {
        /* fichier supprimé à la fin de la session */
      }
    }, 250);

    // Agents sans hooks (Codex, Gemini, OpenCode…) : état déduit de l'activité du terminal, jamais de son texte :
    // sortie en cours → « travaille », 4 s de silence → « en attente de vous ».
    const hooks = o.connectorId === "claude-cli";
    const onActivity = hooks
      ? undefined
      : () => {
          if (hooksSeen) return;
          if (this.#byTask.get(o.taskId)?.status !== "working") this.#status(o.taskId, "working");
          if (quiet) clearTimeout(quiet);
          quiet = setTimeout(() => this.#byTask.has(o.taskId) && !hooksSeen && this.#status(o.taskId, "idle"), 4000);
        };

    // Conversation conservée : la sortie du terminal est ajoutée au fichier de la session (relue plus tard).
    mkdirSync(this.#d.transcriptsDir, { recursive: true, mode: 0o700 });
    const transcript = join(this.#d.transcriptsDir, `${o.taskId}.log`);
    if (o.resume) appendFileSync(transcript, "\r\n\x1b[2m── reprise ──\x1b[0m\r\n", { mode: 0o600 });
    let buffered = "";
    const flushTranscript = () => {
      if (!buffered) return;
      appendFileSync(transcript, buffered, { mode: 0o600 });
      buffered = "";
      if (statSync(transcript).size > TRANSCRIPT_MAX * 1.25) {
        const all = readFileSync(transcript);
        writeFileSync(transcript, all.subarray(all.length - TRANSCRIPT_MAX), { mode: 0o600 });
      }
    };
    const transcriptTimer = setInterval(flushTranscript, 1000);
    // Question « faire confiance à ce dossier ? » des TUI (Codex, Claude) : l'utilisateur a choisi de lancer cet agent
    // dans ce projet, Nexus y répond donc (Entrée = première option « faire confiance »). Aucune autre question
    // (permissions, mode sans confirmation…) n'est jamais répondue à sa place.
    let tail = "";
    let trusted = false;
    const onOutput = (d: string) => {
      buffered += d;
      if (trusted) return;
      // oxlint-disable-next-line no-control-regex -- codes de contrôle ANSI à retirer, voulu
      tail = (tail + d.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "")).slice(-4000);
      const prompt = TRUST_PROMPTS.find((p) => p.re.test(tail));
      if (prompt) {
        trusted = true;
        prompt.keys.forEach((k, i) =>
          setTimeout(
            () => {
              const live = this.#byTask.get(o.taskId);
              if (live) this.#d.terminals.write(live.terminalId, k);
            },
            400 + i * 300,
          ),
        );
      }
    };

    const onExit = (code: number | null, signal?: number) => {
      clearInterval(transcriptTimer);
      flushTranscript();
      clearInterval(poll);
      if (quiet) clearTimeout(quiet);
      this.#byTask.delete(o.taskId);
      void (async () => {
        await cleanup().catch(() => undefined);
        rmSync(hookDir, { recursive: true, force: true });
        // Tué par un signal (onglet fermé, arrêt) : interrompue, jamais « terminée ».
        const ok = code === 0 && !signal;
        this.#d.push({ type: "agent-status", taskId: o.taskId, status: ok ? "done" : "error" });
        if (!track) return;
        const to = signal ? "interrupted" : !ok ? "failed" : o.mode === "autonomous" ? "completed" : "waiting_review";
        await core.missions
          .transition(
            o.taskId,
            to,
            SYSTEM,
            signal ? { reason: "terminal_closed" } : ok ? {} : { failureCode: "cli_exit" },
          )
          .catch(() => undefined);
      })();
    };

    let terminalId: string;
    try {
      terminalId = this.#d.terminals.create(o.workspace, o.cols, o.rows, {
        ...command,
        onExit,
        onOutput,
        ...(onActivity && { onActivity }),
      }).terminalId;
    } catch (e) {
      onExit(null);
      throw e;
    }
    this.#byTask.set(o.taskId, { terminalId, status: "starting" });
    // Consigne tapée dans la TUI une fois celle-ci prête (première sortie puis courte accalmie).
    if (o.prompt && !o.resume && typedPrompt(o.connectorId)) {
      const prompt = o.prompt.replace(/\r?\n/g, " ");
      setTimeout(() => {
        try {
          this.#d.terminals.write(terminalId, `${prompt}\r`);
        } catch {
          /* terminal déjà fermé */
        }
      }, 2500);
    }
    this.#status(o.taskId, o.prompt ? "starting" : "idle");
    return terminalId;
  }
}
