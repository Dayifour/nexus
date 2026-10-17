import { join } from "node:path";
import { existsSync } from "node:fs";
// Sonde non intrusive d'une CLI : résolution PATH sûre puis `--version` avec délai court.
// Jamais d'authentification, de téléchargement ni de lecture de dossiers d'identifiants (UC-01, AC-01, AC-14).
import type { ProbeResult } from "@nexus/contracts";
import { resolveExecutable, runProcess, type RunOptions, type RunResult } from "@nexus/process-supervisor";
import type { CliSignature } from "./signatures.ts";

/** `ctx.taskId` : tâche Nexus du lancement (le runner applique le mode de CETTE tâche, pas celui du dossier). */
export type Runner = (opts: RunOptions, ctx?: { taskId?: string }) => Promise<RunResult>;

export type ProbeContext = {
  /** PATH fourni explicitement (celui de l'utilisateur, jamais modifié silencieusement). */
  pathEnv: string;
  runner?: Runner;
  clock?: () => string;
  cwd?: string;
  /** HOME de l'utilisateur, transmis aux seules commandes d'état de connexion documentées. */
  home?: string;
  /** Environnement de l'utilisateur (présence de clés API seulement ; valeurs jamais lues ni conservées). */
  env?: Record<string, string | undefined>;
};

export async function probeCli(sig: CliSignature, ctx: ProbeContext): Promise<ProbeResult> {
  const clock = ctx.clock ?? (() => new Date().toISOString());
  const base = { connectorId: sig.connectorId, probedAt: clock() };
  let resolved: { path: string } | null = null;
  const rejected: string[] = [];
  for (const name of sig.binaryNames) {
    resolved = resolveExecutable(name, ctx.pathEnv, (r) => rejected.push(`${r.dir}:${r.reason}`));
    if (resolved) break;
  }
  if (!resolved) {
    return {
      ...base,
      installed: false,
      reason: rejected.length ? `rejected: ${rejected.join(", ")}`.slice(0, 500) : "not_found_on_path",
    };
  }

  const out: string[] = [];
  let result: RunResult;
  try {
    result = await (ctx.runner ?? runProcess)({
      file: resolved.path,
      args: sig.versionArgs,
      cwd: ctx.cwd ?? "/",
      // Environnement minimal : la sonde n'a besoin d'aucun identifiant.
      env: { PATH: ctx.pathEnv, LANG: "C.UTF-8", NO_COLOR: "1" },
      timeoutMs: sig.probeTimeoutMs,
      killGraceMs: 500,
      maxOutputBytes: 64 * 1024,
      onLine: (l) => out.push(l),
    });
  } catch (e) {
    return {
      ...base,
      installed: true,
      path: resolved.path,
      reason: `probe_error: ${(e as Error).message}`.slice(0, 500),
    };
  }
  if (result.timedOut) return { ...base, installed: true, path: resolved.path, reason: "version_probe_timeout" };
  if (result.spawnError)
    return { ...base, installed: true, path: resolved.path, reason: `spawn_error: ${result.spawnError}` };
  const match = out.join("\n").match(sig.versionPattern);
  let authenticated: boolean | undefined;
  if (sig.authStatus && match?.[1]) {
    let authOut = "";
    try {
      const a = await (ctx.runner ?? runProcess)({
        file: resolved.path,
        args: sig.authStatus.args,
        cwd: ctx.cwd ?? "/",
        // Le CLI a besoin de son HOME pour retrouver sa propre session ; Nexus ne lit rien lui-même.
        env: { PATH: ctx.pathEnv, LANG: "C.UTF-8", NO_COLOR: "1", ...(ctx.home && { HOME: ctx.home }) },
        timeoutMs: sig.probeTimeoutMs,
        killGraceMs: 500,
        maxOutputBytes: 64 * 1024,
        // Certains CLI (Codex) écrivent leur état sur stderr.
        onChunk: (c) => {
          authOut += c;
        },
      });
      if (!a.timedOut && !a.spawnError) authenticated = sig.authStatus.parse(authOut);
    } catch {
      authenticated = undefined;
    }
  }
  if (sig.authPresence && authenticated === undefined && ctx.home) {
    const home = ctx.home;
    authenticated =
      sig.authPresence.files.some((f) => existsSync(join(home, f))) ||
      sig.authPresence.env.some((v) => Boolean(ctx.env?.[v]));
  }
  return {
    ...base,
    installed: true,
    path: resolved.path,
    ...(match?.[1] ? { version: match[1] } : {}),
    ...(authenticated !== undefined && { authenticated }),
    reason: match?.[1]
      ? result.exitCode === 0
        ? authenticated === undefined
          ? "auth_not_checked"
          : authenticated
            ? "authenticated"
            : "not_logged_in"
        : `version_exit_${result.exitCode}`
      : "unknown_version_format",
  };
}
