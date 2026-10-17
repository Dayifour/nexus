// Exécution contrôlée d'un processus (ADR-001 §5.4) : binaire absolu, tableau d'arguments, shell:false,
// environnement construit (jamais hérité), timeout, annulation SIGTERM -> SIGKILL, plafond de sortie, redaction.
//
// Frontière d'arrêt par défaut, selon la plateforme (`defaultKillBoundary`, addendum de l'ADR-001) :
// - Linux : PID namespace dédié (`unshare --user --map-current-user --pid --fork --kill-child=SIGKILL`).
//   Aucun processus ne peut en sortir (setsid, double fork) ; quand son PID 1 meurt, le noyau tue tout le namespace ;
//   si `unshare` est tué, --kill-child tue le PID 1. Le groupe de processus seul est insuffisant (constat 7 de
//   l'ADR-001) : sans unshare utilisable, l'exécution est REFUSÉE (`kill_boundary_unavailable`), jamais dégradée.
//   Mort du parent : `unshare` est lancé via `setpriv --pdeathsig KILL` quand setpriv existe ; si Nexus (Electron)
//   meurt brutalement, le noyau tue unshare, donc --kill-child tue le namespace entier.
// - macOS : groupe de processus détaché, arrêt par kill(-pgid) SIGTERM -> SIGKILL. Pas de PID namespace : un
//   descendant setsid y échappe (limite connue), et aucune protection contre la mort du parent.
// - Windows : arbre de processus, arrêt par `%SystemRoot%\System32\taskkill.exe /PID <pid> /T [/F]` (sans shell).
//   Un descendant dont le parent est déjà terminé n'est plus rattaché à l'arbre (limite connue ; un Job Object
//   avec KILL_ON_JOB_CLOSE demanderait du code natif).
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { createLineSplitter } from "./lines.ts";
import { createRedactor, redactKnownTokenPatterns } from "./redact.ts";
import { resolveExecutable } from "./resolve.ts";

// Emplacements système d'abord (usrmerge ou non), puis les entrées absolues du PATH (ex. NixOS, Guix).
const SYSTEM_BIN_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/run/current-system/sw/bin"];
const toolCache = new Map<string, string | null>();
/** Chemin absolu d'un outil util-linux (unshare, setpriv), ou null. Résultat mis en cache. */
function findTool(name: string): string | null {
  if (toolCache.has(name)) return toolCache.get(name)!;
  const found =
    SYSTEM_BIN_DIRS.map((d) => join(d, name)).find((f) => executable(f) === null) ??
    resolveExecutable(name, process.env.PATH ?? "")?.path ?? // entrées absolues seulement, fichier world-writable refusé
    null;
  toolCache.set(name, found);
  return found;
}
const PDEATHSIG_PREFIX = ["--pdeathsig", "KILL", "--"];
// `--mount --mount-proc` : /proc propre au namespace. Sans lui, /proc est celui de l'hôte et les numéros de processus
// ne correspondent pas : un outil qui suit ses enfants via /proc ne voit jamais leur fin (constaté avec Codex).
const PIDNS_PREFIX = [
  "--user",
  "--map-current-user",
  "--pid",
  "--fork",
  "--kill-child=SIGKILL",
  "--mount",
  "--mount-proc",
  "--",
];

/**
 * - `pid-namespace` (défaut sous Linux) : la commande est placée dans un PID namespace dédié via unshare ;
 * - `wrapper-pid-namespace` : l'enveloppe fournie (bwrap --unshare-pid --die-with-parent) établit elle-même le PID
 *   namespace ; utile quand une autre enveloppe (systemd-run --scope) ne fonctionne pas dans un user namespace ;
 * - `process-group` (défaut sous macOS) : groupe détaché + kill(-pgid). Insuffisant contre setsid : sous Linux,
 *   réservé aux tests qui démontrent la faille (`allowWeakBoundary`) ;
 * - `process-tree` (défaut sous Windows) : arbre arrêté par `taskkill /T /F`.
 */
export type KillBoundary = "pid-namespace" | "wrapper-pid-namespace" | "process-group" | "process-tree";

/** Meilleure frontière disponible sur la plateforme. */
export function defaultKillBoundary(platform: NodeJS.Platform = process.platform): KillBoundary {
  if (platform === "win32") return "process-tree";
  if (platform === "linux") return "pid-namespace";
  return "process-group";
}

const TASKKILL = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
export type Channel = "stdout" | "stderr";

export type RunOptions = {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  /** Valeurs secrètes connues à expurger de toute sortie transmise. */
  redact?: readonly string[];
  maxLineBytes?: number;
  /** Au-delà, le processus est arrêté (`outputLimitExceeded`). Protège la mémoire et le journal. */
  maxOutputBytes?: number;
  onLine?: (line: string, channel: Channel) => void;
  onChunk?: (chunk: string, channel: Channel) => void;
  /**
   * Par défaut `defaultKillBoundary()`. Sous Linux, `process-group` est INSUFFISANT contre setsid ; il n'y est
   * accepté qu'avec `allowWeakBoundary: true` (tests démontrant la faille, ou sonde éphémère explicitement déclarée).
   */
  killBoundary?: KillBoundary;
  allowWeakBoundary?: boolean;
  /** Données écrites sur l'entrée standard puis fermée (ex. prompt volumineux, au-delà de la limite d'un argv). */
  stdin?: string;
  /**
   * Descripteurs hérités par l'enfant à partir du fd 3 (ex. programme seccomp lu par `bwrap --seccomp 3`).
   * Ils traversent unshare/systemd-run, qui font un exec sans fermer les descripteurs hérités.
   */
  inheritFds?: readonly number[];
  /** Préfixe d'enveloppe (ex. bwrap) : la commande réelle devient `wrapper.file ...wrapper.args file ...args`. */
  wrapper?: { file: string; args: readonly string[] };
};

export type RunResult = {
  pid?: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
  spawnError?: string;
  durationMs: number;
};

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const executable = (file: string): string | null => {
  try {
    accessSync(file, constants.X_OK);
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? "EACCES";
  }
};

/**
 * Sonde la frontière par défaut sur cet hôte. Sous Linux : PID namespace (user namespaces non privilégiés,
 * AppArmor) ; `parentDeath` indique si la mort de Nexus tue aussi les agents (setpriv disponible).
 * Ailleurs, la frontière de la plateforme (groupe ou arbre de processus) est toujours utilisable.
 */
export async function probeKillBoundary(): Promise<{
  usable: boolean;
  reason?: string;
  boundary: KillBoundary;
  parentDeath: boolean;
}> {
  const boundary = defaultKillBoundary();
  if (boundary !== "pid-namespace") return { usable: true, boundary, parentDeath: false };
  const parentDeath = findTool("setpriv") !== null;
  if (!findTool("unshare")) return { usable: false, reason: "unshare_not_found", boundary, parentDeath };
  const t = ["/usr/bin/true", "/bin/true"].find((f) => executable(f) === null);
  if (!t) return { usable: false, reason: "true_not_found", boundary, parentDeath };
  const r = await runProcess({ file: t, args: [], cwd: "/", env: {}, timeoutMs: 5000 });
  return r.exitCode === 0
    ? { usable: true, boundary, parentDeath }
    : { usable: false, reason: `pid_namespace_failed:${r.exitCode ?? r.spawnError}`, boundary, parentDeath };
}

export async function runProcess(opts: RunOptions): Promise<RunResult> {
  const { file, args, cwd, env, timeoutMs, killGraceMs = 1500, signal } = opts;
  const { maxLineBytes = 1 << 20, maxOutputBytes = 64 << 20, killBoundary = defaultKillBoundary() } = opts;
  if (!isAbsolute(file)) throw new Error("runProcess: file must be an absolute path (no PATH lookup)");
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
    throw new Error("runProcess: args must be string[]");
  if (!isAbsolute(cwd)) throw new Error("runProcess: cwd must be an absolute path");
  if (
    killBoundary !== "pid-namespace" &&
    killBoundary !== "process-group" &&
    killBoundary !== "wrapper-pid-namespace" &&
    killBoundary !== "process-tree"
  ) {
    throw new Error(`runProcess: unknown killBoundary ${String(killBoundary)} (no silent fallback)`);
  }
  if (killBoundary === "wrapper-pid-namespace" && !opts.wrapper) {
    throw new Error("runProcess: wrapper-pid-namespace requires a wrapper that establishes the PID namespace");
  }
  if (killBoundary === "process-tree" && process.platform !== "win32") {
    throw new Error("runProcess: process-tree boundary is Windows-only (taskkill /T)");
  }
  if ((killBoundary === "pid-namespace" || killBoundary === "wrapper-pid-namespace") && process.platform !== "linux") {
    throw new Error(`runProcess: ${killBoundary} boundary is Linux-only`);
  }
  if (killBoundary === "process-group" && process.platform === "linux" && !opts.allowWeakBoundary) {
    throw new Error(
      "runProcess: process-group boundary is insufficient against setsid; set allowWeakBoundary explicitly",
    );
  }

  const fail = (spawnError: string): RunResult => ({
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    spawnError,
    durationMs: 0,
  });
  if (signal?.aborted) return { ...fail("aborted"), spawnError: undefined, cancelled: true };

  // Vérifiés avant le spawn : sinon un binaire absent apparaîtrait comme un code de sortie d'unshare.
  // Avec une enveloppe (bwrap…), la cible est un chemin VU DANS l'enveloppe : seule l'enveloppe est vérifiée sur l'hôte.
  const targetError = executable(opts.wrapper?.file ?? file);
  if (targetError) return fail(targetError);

  let command = opts.wrapper ? [opts.wrapper.file, ...opts.wrapper.args, file, ...args] : [file, ...args];
  if (killBoundary === "pid-namespace") {
    const unshare = findTool("unshare");
    if (!unshare) return fail("kill_boundary_unavailable");
    command = [unshare, ...PIDNS_PREFIX, ...command];
    // Sans setpriv (rare : util-linux le fournit avec unshare), la protection contre la mort du parent manque,
    // mais la frontière elle-même reste entière. Le pdeathsig vise le thread qui a lancé setpriv : le thread
    // principal de Node/Electron (boucle d'événements), qui ne meurt qu'avec le processus.
    const setpriv = findTool("setpriv");
    if (setpriv) command = [setpriv, ...PDEATHSIG_PREFIX, ...command];
  }
  const windows = killBoundary === "process-tree";

  const scrub = (s: string) => redactKnownTokenPatterns(createRedactor(opts.redact ?? [])(s));
  const started = Date.now();
  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let outputBytes = 0;

  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    env: { ...env }, // jamais fusionné avec process.env
    shell: false,
    // Groupe dédié : le SIGTERM initial atteint aussi le PID 1 du namespace. Sous Windows, detached ouvrirait une
    // console par processus : l'arbre est arrêté par taskkill à la place.
    detached: !windows,
    windowsHide: true,
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", ...(opts.inheritFds ?? [])],
  });
  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => {}); // processus terminé avant d'avoir tout lu : sans incidence
    child.stdin.end(opts.stdin);
  }

  const killTree = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    if (windows) {
      // SIGTERM : demande de fermeture (souvent ignorée par une application console) ; SIGKILL : /F forcé.
      const args = ["/PID", String(child.pid), "/T", ...(sig === "SIGKILL" ? ["/F"] : [])];
      try {
        spawn(TASKKILL, args, { shell: false, stdio: "ignore", windowsHide: true }).on("error", () => {});
      } catch {
        /* taskkill indisponible : rien de plus sûr à tenter */
      }
      return;
    }
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* groupe déjà terminé */
    }
  };
  let graceTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    killTree("SIGTERM");
    graceTimer ??= setTimeout(() => killTree("SIGKILL"), killGraceMs);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  for (const channel of ["stdout", "stderr"] as const) {
    const splitter = opts.onLine
      ? createLineSplitter({ maxLineBytes, onLine: (l) => opts.onLine!(scrub(l), channel) })
      : null;
    // stdout/stderr sont toujours des pipes (stdio ci-dessus) : jamais null.
    const stream = child[channel]!;
    stream.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          stop();
        }
        return;
      }
      opts.onChunk?.(scrub(chunk.toString("utf8")), channel);
      splitter?.write(chunk);
    });
    stream.on("end", () => splitter?.end());
  }

  const result = await new Promise<{ exitCode: number | null; signal: string | null; spawnError?: string }>(
    (resolve) => {
      child.once("error", (e: NodeJS.ErrnoException) =>
        resolve({ exitCode: null, signal: null, spawnError: e.code ?? "spawn_failed" }),
      );
      child.once("close", (exitCode, sig) => resolve({ exitCode, signal: sig }));
    },
  );

  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  // En mode pid-namespace le noyau a déjà tué tout le namespace ; ce SIGKILL reste une défense en profondeur.
  if (cancelled || timedOut || outputLimitExceeded) killTree("SIGKILL");
  clearTimeout(graceTimer);

  return { pid: child.pid, ...result, timedOut, cancelled, outputLimitExceeded, durationMs: Date.now() - started };
}
