// Broker GitHub (§13, UC-06, AC-08, NFR-009) : seule voie pour une action distante git/GitHub dans Nexus.
//
// Invariants :
// - toute exécution passe par `runProcess` (binaire absolu, tableau d'arguments, shell:false, env construit, timeout,
//   plafond de sortie, frontière PID namespace par défaut) ;
// - une action distante (push, PR) ne s'exécute qu'APRÈS `approvals.consume` réussi, sur le plan exact approuvé ;
// - le push n'a AUCUNE forme forcée : ni `--force`, ni `--force-with-lease`, ni `--delete`, ni `--mirror`, ni refspec
//   `+…` ; la suppression de branche distante et le force-push ne sont pas implémentés du tout ;
// - `protocol.allow=never` puis autorisation explicite des seuls protocoles configurés (git applique lui-même la règle) ;
// - l'authentification GitHub reste celle de l'utilisateur (aide aux identifiants git, `gh auth login`) : Nexus ne lit
//   jamais de fichier de configuration ni de jeton ; il appelle seulement `gh auth status` (sortie expurgée).
//
// LIMITES DÉCLARÉES : `gh` n'a été exercé qu'avec une fausse CLI (script). Les options utilisées
// (`gh auth status`, `gh pr create --title --body-file - --base --head`) et le format de sortie analysé doivent être
// vérifiés contre une version réelle de gh avant d'annoncer la fonctionnalité (voir `GITHUB_VERIFICATION`).
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Actor, ApprovalService } from "@nexus/core";
import {
  assertSafeRefName,
  canonicalJson,
  GitBroker,
  isGitError,
  parseNameStatusZ,
  planPush,
  scanDiffForSecrets,
  sha256Hex,
  stripUrlCredentials,
  type PushPlan,
  type SecretFinding,
  unsafeConfigKeys,
} from "@nexus/git";
import { resolveExecutable, runProcess, type RunOptions, type RunResult } from "@nexus/process-supervisor";
import { cleanOutput, GitHubError } from "./errors.ts";
import {
  assertProtocolAllowed,
  assertSafePushArgs,
  normalizeAllowedProtocols,
  protocolConfigArgs,
} from "./protocol.ts";

export type Runner = (opts: RunOptions) => Promise<RunResult>;

/** Interface minimale : le broker n'a besoin que de la consommation d'une approbation (usage unique). */
export type ApprovalConsumer = Pick<ApprovalService, "consume">;

/**
 * Variables transmises SEULEMENT si fournies explicitement : nécessaires à l'agent SSH et aux trousseaux
 * (libsecret via D-Bus) utilisés par les aides aux identifiants de l'utilisateur.
 */
export type CredentialEnv = {
  SSH_AUTH_SOCK?: string;
  DBUS_SESSION_BUS_ADDRESS?: string;
  XDG_RUNTIME_DIR?: string;
};

export type GitHubBrokerOptions = {
  gitPath: string;
  /** Chemin absolu de gh ; absent -> PR et statut d'authentification `unavailable`/`unknown`. */
  ghPath?: string;
  /** HOME réel de l'utilisateur : son aide aux identifiants git et l'authentification gh en dépendent. */
  home: string;
  /** PATH transmis à git/gh (ssh, aides aux identifiants). Entrées absolues uniquement. */
  pathEnv: string;
  approvals: ApprovalConsumer;
  /** Protocoles distants autorisés (défaut : https, ssh). `file` n'est destiné qu'aux tests. */
  allowedProtocols?: readonly string[];
  credentialEnv?: CredentialEnv;
  /** Acteur enregistré lors de la consommation de l'approbation. */
  actor?: Actor;
  timeoutMs?: number;
  /** Délai d'un push ou d'une création de PR (réseau). */
  remoteTimeoutMs?: number;
  runner?: Runner;
};

export type PushApprovalPlan = {
  kind: "nexus.git_push";
  v: 1;
  repo: string;
  headSha: string;
  protocol: string;
  scanComplete: boolean;
  blocked: boolean;
  /** Empreinte `planPush` : remote (sans identifiants), branches, commits, fichiers, détections. */
  pushFingerprint: string;
};

export type PreparedPush = {
  repo: string;
  /** Plan produit par `planPush` (@nexus/git) : c'est lui qui est montré à l'utilisateur. */
  push: PushPlan;
  headSha: string;
  protocol: string;
  scanComplete: boolean;
  /** Bloqué par défaut : secret détecté OU scan incomplet. */
  blocked: boolean;
  blockedReasons: string[];
  summary: string;
  /** Objet EXACT à passer à `approvals.request({ action: "git_push", plan })`. */
  approvalPlan: PushApprovalPlan;
  /** Empreinte canonique de `approvalPlan` (affichage, journal). */
  fingerprint: string;
};

export type PushResult = {
  remote: string;
  remoteBranch: string;
  sha: string;
  /** Code porcelain de git : ` ` avance rapide, `*` nouvelle réf, `=` déjà à jour. */
  flag: " " | "*" | "=";
  output: string;
};

export type PullRequestInput = { title: string; body: string; base: string; head: string; draft?: boolean };

export type PullRequestApprovalPlan = {
  kind: "nexus.github_pr_create";
  v: 1;
  repo: string;
  base: string;
  head: string;
  title: string;
  bodySha256: string;
  bodyBytes: number;
  draft: boolean;
};

export type PreparedPullRequest = {
  approvalPlan: PullRequestApprovalPlan;
  fingerprint: string;
  summary: string;
};

export type PullRequestResult = { url: string; output: string };

export type GhProbe = {
  available: boolean;
  path?: string;
  version?: string;
  reason?: "not_configured" | "not_executable" | "failed";
  /** Toujours false tant que les essais avec une vraie CLI n'ont pas été faits. */
  verifiedAgainstRealCli: false;
};

export type GhAccount = { host: string; login: string; storage: "keyring" | "file" | "unknown" };

export type GhAuthStatus = {
  state: "authenticated" | "unauthenticated" | "unknown";
  accounts: GhAccount[];
  /** gh a retombé sur un fichier en clair : l'UI doit avertir (§13), Nexus ne le lit jamais. */
  insecureStorage: boolean;
  reason?: string;
  /** Sortie expurgée et bornée, pour l'affichage. */
  output: string;
};

/** Déclaration honnête de l'état de vérification du connecteur. */
export const GITHUB_VERIFICATION = {
  realGhTested: false,
  realRemotePushTested: false,
  notes: [
    "gh n'est pas installé sur l'hôte de développement : probe/authStatus/createPullRequest testés avec une fausse CLI.",
    "Push testé vers un dépôt nu local (file://) ; https/ssh et les aides aux identifiants réelles restent à essayer.",
    "Format de `gh auth status` (stdout/stderr, codes de sortie 0/1/4) à vérifier contre la version réelle installée.",
    "Comportement de `gh pr create --head` sans TTY (pas de tentative de push) à vérifier.",
  ],
} as const;

const SYSTEM_ACTOR: Actor = { actorType: "system", actorId: "nexus-github" };
const MAX_SCAN_BYTES = 8 << 20;
const MAX_COMMITS = 500;
const MAX_FILES = 5000;
const MAX_TITLE = 256;
const MAX_BODY = 65_536;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const HEAD_REF = /^(?:[A-Za-z0-9][A-Za-z0-9-]{0,38}:)?(.+)$/;

/** Durcissement commun à toutes les commandes git (hooks, fsmonitor, signatures, couleurs). */
const GIT_HARDENING = [
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
] as const;

/** Clés de config locales qui font lancer une commande par `git push` (en plus de `unsafeConfigKeys`). */
const PUSH_COMMAND_KEYS = [
  /^core\.sshcommand$/,
  /^core\.askpass$/,
  /^credential\..*helper$/,
  /^remote\..*\.(receivepack|uploadpack|vcs)$/,
];
function localCommandKeys(listZ: string): string[] {
  const out: string[] = [];
  const parts = listZ.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== "local" && parts[i] !== "worktree") continue;
    const key = (parts[i + 1]!.split("\n", 1)[0] ?? "").toLowerCase();
    if (PUSH_COMMAND_KEYS.some((re) => re.test(key)) && !out.includes(key)) out.push(key);
  }
  return out;
}

export function locateGh(pathEnv: string): string | null {
  return resolveExecutable("gh", pathEnv)?.path ?? null;
}

type Out = { code: number; stdout: string; stderr: string };

export class GitHubBroker {
  readonly gitPath: string;
  readonly ghPath: string | undefined;
  readonly allowedProtocols: readonly string[];
  private readonly approvals: ApprovalConsumer;
  private readonly actor: Actor;
  private readonly baseEnv: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly remoteTimeoutMs: number;
  private readonly runner: Runner;
  private readonly git: GitBroker;

  constructor(opts: GitHubBrokerOptions) {
    for (const [k, v] of [
      ["gitPath", opts.gitPath],
      ["home", opts.home],
    ] as const) {
      if (typeof v !== "string" || !isAbsolute(v))
        throw new GitHubError("invalid_argument", `${k} : chemin absolu requis`);
    }
    if (opts.ghPath !== undefined && (typeof opts.ghPath !== "string" || !isAbsolute(opts.ghPath))) {
      throw new GitHubError("invalid_argument", "ghPath : chemin absolu requis");
    }
    if (typeof opts.pathEnv !== "string") throw new GitHubError("invalid_argument", "pathEnv requis");
    if (!opts.approvals || typeof opts.approvals.consume !== "function") {
      throw new GitHubError("invalid_argument", "service d'approbation requis");
    }
    this.gitPath = opts.gitPath;
    this.ghPath = opts.ghPath;
    this.allowedProtocols = normalizeAllowedProtocols(opts.allowedProtocols);
    this.approvals = opts.approvals;
    this.actor = opts.actor ?? SYSTEM_ACTOR;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.remoteTimeoutMs = opts.remoteTimeoutMs ?? 300_000;
    this.runner = opts.runner ?? runProcess;
    const pathEnv = opts.pathEnv
      .split(":")
      .filter((d) => d && isAbsolute(d))
      .join(":");
    const cred = opts.credentialEnv ?? {};
    const credEnv: Record<string, string> = {};
    for (const k of ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const) {
      const v = cred[k];
      if (typeof v === "string" && v.length > 0 && !v.includes("\0")) credEnv[k] = v;
    }
    this.baseEnv = { HOME: opts.home, LANG: "C", LC_ALL: "C", ...(pathEnv ? { PATH: pathEnv } : {}), ...credEnv };
    // Lecture locale (validation du dépôt) déléguée au Git broker ; il n'est jamais utilisé pour une action distante.
    this.git = new GitBroker({
      gitPath: opts.gitPath,
      home: opts.home,
      worktreesRoot: join(tmpdir(), "nexus-github-unused-worktrees"),
      timeoutMs: this.timeoutMs,
      ...(opts.runner ? { runner: opts.runner } : {}),
    });
  }

  // ------------------------------------------------------------------ exécution

  private async exec(
    file: string,
    args: readonly string[],
    cwd: string,
    env: Record<string, string>,
    o: { stdin?: string; timeoutMs?: number; what: string },
  ): Promise<Out> {
    let stdout = "";
    let stderr = "";
    const r = await this.runner({
      file,
      args,
      cwd,
      env,
      timeoutMs: o.timeoutMs ?? this.timeoutMs,
      killGraceMs: 1000,
      maxOutputBytes: 4 << 20,
      ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
      onChunk: (chunk, channel) => {
        if (channel === "stdout") stdout += chunk;
        else stderr = (stderr + chunk).slice(-8192); // seule la fin de stderr est conservée
      },
    });
    if (r.spawnError) throw new GitHubError("unavailable", `${o.what} : lancement impossible (${r.spawnError})`);
    if (r.timedOut) throw new GitHubError("timeout", `${o.what} : délai dépassé`);
    if (r.outputLimitExceeded) throw new GitHubError("output_limit", `${o.what} : sortie au-delà de la limite`);
    if (r.cancelled || r.exitCode === null) throw new GitHubError("command_failed", `${o.what} : interrompu`);
    return { code: r.exitCode, stdout, stderr };
  }

  /** Commande git LOCALE (lecture) : aucun protocole distant autorisé, configuration système ignorée. */
  private async gitLocal(cwd: string, args: readonly string[], ok: readonly number[] = [0]): Promise<Out> {
    const out = await this.exec(
      this.gitPath,
      [...GIT_HARDENING, "-c", "protocol.allow=never", ...args],
      cwd,
      { ...this.baseEnv, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
      { what: `git ${args[0] ?? "?"}` },
    );
    if (!ok.includes(out.code)) {
      throw new GitHubError(
        "command_failed",
        `git ${args[0] ?? "?"} a échoué (code ${out.code}) : ${cleanOutput(out.stderr.trim(), 300)}`,
      );
    }
    return out;
  }

  private ghEnv(): Record<string, string> {
    return {
      ...this.baseEnv,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_SPINNER_DISABLED: "1",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  private async repoTop(repo: string): Promise<string> {
    if (typeof repo !== "string" || !isAbsolute(repo))
      throw new GitHubError("invalid_argument", "chemin absolu requis");
    try {
      return (await this.git.repoInfo(repo)).top;
    } catch (e) {
      if (isGitError(e)) throw new GitHubError("not_a_repository", e.message);
      throw e;
    }
  }

  private async consume(approvalId: string, action: "git_push" | "github_pr_create", plan: unknown): Promise<void> {
    if (typeof approvalId !== "string" || approvalId.length === 0) {
      throw new GitHubError("approval_denied", "approbation requise");
    }
    try {
      await this.approvals.consume(approvalId, action, plan, this.actor);
    } catch (e) {
      throw new GitHubError("approval_denied", `approbation refusée : ${(e as Error).message}`, {
        cause: (e as { code?: string }).code ?? "unknown",
      });
    }
  }

  // ------------------------------------------------------------------ gh : sonde et authentification

  async probe(): Promise<GhProbe> {
    if (!this.ghPath) return { available: false, reason: "not_configured", verifiedAgainstRealCli: false };
    try {
      const r = await this.exec(this.ghPath, ["--version"], "/", this.ghEnv(), { what: "gh --version" });
      const m = /gh version (\S+)/.exec(r.stdout);
      if (r.code !== 0) return { available: false, path: this.ghPath, reason: "failed", verifiedAgainstRealCli: false };
      return {
        available: true,
        path: this.ghPath,
        ...(m?.[1] ? { version: cleanOutput(m[1], 64) } : {}),
        verifiedAgainstRealCli: false,
      };
    } catch (e) {
      const reason = (e as GitHubError).code === "unavailable" ? "not_executable" : "failed";
      return { available: false, path: this.ghPath, reason, verifiedAgainstRealCli: false };
    }
  }

  /**
   * Statut via la commande documentée `gh auth status` (jamais `--show-token`, jamais de lecture de hosts.yml).
   * Indéterminable -> `unknown`.
   */
  async authStatus(): Promise<GhAuthStatus> {
    const unknown = (reason: string, output = ""): GhAuthStatus => ({
      state: "unknown",
      accounts: [],
      insecureStorage: false,
      reason,
      output,
    });
    if (!this.ghPath) return unknown("unavailable");
    let r: Out;
    try {
      r = await this.exec(this.ghPath, ["auth", "status"], "/", this.ghEnv(), { what: "gh auth status" });
    } catch (e) {
      return unknown((e as GitHubError).code ?? "failed");
    }
    // Selon les versions, gh écrit sur stdout ou stderr : les deux sont analysés, après expurgation.
    const text = cleanOutput(`${r.stdout}\n${r.stderr}`, 4000).trim();
    return parseGhAuthStatus(text, r.code);
  }

  // ------------------------------------------------------------------ push

  /** Construit le plan de push à faire approuver. Lecture locale uniquement : aucune commande réseau. */
  async preparePush(
    repo: string,
    branch: string,
    remote: string,
    remoteBranch: string = branch,
  ): Promise<PreparedPush> {
    try {
      assertSafeRefName(branch, "branche");
      assertSafeRefName(remote, "remote");
      assertSafeRefName(remoteBranch, "branche distante");
    } catch (e) {
      throw new GitHubError("invalid_argument", (e as Error).message);
    }
    const top = await this.repoTop(repo);

    const urlOut = await this.gitLocal(top, ["remote", "get-url", "--push", "--", remote], [0, 2, 128]);
    const rawUrl = urlOut.stdout.trim().split("\n")[0] ?? "";
    if (urlOut.code !== 0 || !rawUrl) throw new GitHubError("remote_not_found", `remote introuvable : ${remote}`);
    // URL de push après réécritures insteadOf/pushInsteadOf (git les applique dans `get-url`).
    const remoteUrl = stripUrlCredentials(rawUrl);
    const protocol = assertProtocolAllowed(rawUrl, this.allowedProtocols);

    const headOut = await this.gitLocal(
      top,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`],
      [0, 1, 128],
    );
    const headSha = headOut.stdout.trim();
    if (headOut.code !== 0 || !SHA.test(headSha))
      throw new GitHubError("branch_not_found", `branche introuvable : ${branch}`);

    // Commits non poussés : atteignables depuis la branche mais depuis aucune réf de suivi du remote (état LOCAL,
    // sans fetch : si le remote a avancé, le push sans force sera simplement refusé par le serveur).
    const range = [headSha, "--not", `--remotes=${remote}`];
    const log = await this.gitLocal(top, [
      "log",
      "--topo-order",
      `--max-count=${MAX_COMMITS + 1}`,
      "--format=%H%x1f%s",
      ...range,
      "--",
    ]);
    const commits = log.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha = "", subject = ""] = l.split("\x1f");
        return { sha, subject };
      })
      .reverse(); // du plus ancien au plus récent : le dernier est la tête de branche
    if (commits.length === 0) throw new GitHubError("nothing_to_push", "aucun commit à pousser");
    if (commits.length > MAX_COMMITS) {
      throw new GitHubError("invalid_argument", `plus de ${MAX_COMMITS} commits à pousser : découper le push`);
    }

    const files = await this.unpushedFiles(top, range);
    const scan = await this.scanUnpushed(top, range);

    let push: PushPlan;
    try {
      push = planPush({
        remote,
        remoteUrl,
        localBranch: branch,
        remoteBranch,
        commits,
        files: files.files,
        secretFindings: scan.findings,
      });
    } catch (e) {
      throw new GitHubError("invalid_argument", (e as Error).message);
    }
    const scanComplete = scan.complete && !files.truncated;
    const blockedReasons: string[] = [];
    if (push.blocked || scan.findings.length > 0) blockedReasons.push("secret_detected");
    if (!scanComplete) blockedReasons.push("scan_incomplete");
    const blocked = blockedReasons.length > 0;
    const approvalPlan: PushApprovalPlan = {
      kind: "nexus.git_push",
      v: 1,
      repo: top,
      headSha,
      protocol,
      scanComplete,
      blocked,
      pushFingerprint: push.fingerprint,
    };
    const summary = [
      push.summary,
      `Protocole : ${protocol} ; tête : ${headSha.slice(0, 12)}`,
      ...(scanComplete ? [] : ["SCAN INCOMPLET (diff trop volumineux) : push bloqué par défaut"]),
    ]
      .join("\n")
      .slice(0, 2000);
    return {
      repo: top,
      push,
      headSha,
      protocol,
      scanComplete,
      blocked,
      blockedReasons,
      summary,
      approvalPlan,
      fingerprint: sha256Hex(canonicalJson(approvalPlan)),
    };
  }

  private async unpushedFiles(top: string, range: readonly string[]) {
    const r = await this.gitLocal(top, [
      "log",
      "--reverse",
      "--topo-order",
      "--no-merges",
      "-z",
      "--name-status",
      "--no-ext-diff",
      "--no-textconv",
      "--format=tformat:%x01%H",
      ...range,
      "--",
    ]);
    // Format : `\x01<sha>\0\n<statut>\0<chemin>\0…` par commit ; le dernier statut d'un chemin l'emporte.
    const byPath = new Map<string, string>();
    for (const seg of r.stdout.split("\x01")) {
      const nul = seg.indexOf("\0");
      if (nul < 0) continue;
      const rest = seg.slice(nul + 1).replace(/^\n/, "");
      for (const f of parseNameStatusZ(rest, MAX_FILES + 1).files) {
        if (f.oldPath && f.status === "renamed") byPath.set(f.oldPath, "D");
        byPath.set(f.path, statusLetter(f.status));
      }
    }
    const truncated = byPath.size > MAX_FILES;
    const files = [...byPath].slice(0, MAX_FILES).map(([path, status]) => ({ path, status }));
    return { files, truncated };
  }

  /**
   * Analyse le patch de CHAQUE commit non poussé (un secret ajouté puis retiré reste dans l'historique poussé).
   * Le patch est écrit par git dans un fichier privé puis lu en taille bornée : il échappe ainsi à la redaction
   * de runProcess (le scanner doit voir les vraies valeurs) ; il n'est jamais renvoyé.
   */
  private async scanUnpushed(
    top: string,
    range: readonly string[],
  ): Promise<{ findings: SecretFinding[]; complete: boolean }> {
    const dir = mkdtempSync(join(tmpdir(), "nexus-github-scan-"));
    try {
      const file = join(dir, "push.patch");
      await this.gitLocal(top, [
        "log",
        "-p",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--format=%H",
        `--output=${file}`,
        ...range,
        "--",
      ]);
      const fd = openSync(file, "r");
      try {
        const size = fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(size, MAX_SCAN_BYTES));
        let off = 0;
        while (off < buf.length) {
          const n = readSync(fd, buf, off, buf.length - off, off);
          if (n === 0) break;
          off += n;
        }
        const scan = scanDiffForSecrets(buf.subarray(0, off).toString("utf8"));
        return { findings: scan.findings, complete: size <= MAX_SCAN_BYTES && !scan.truncated };
      } finally {
        closeSync(fd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Exécute le push approuvé. Ordre : refus si bloqué -> consommation de l'approbation -> vérification de l'état
   * -> `git push` du commit EXACT approuvé vers `refs/heads/<branche distante>`, sans aucune forme de force.
   */
  async push(repo: string, plan: PreparedPush, approvalId: string): Promise<PushResult> {
    if (!plan || typeof plan !== "object" || !plan.push || !plan.approvalPlan) {
      throw new GitHubError("invalid_argument", "plan de push invalide");
    }
    if (plan.blocked || plan.approvalPlan.blocked || !plan.scanComplete || plan.push.plan.secretFindings.length > 0) {
      throw new GitHubError("plan_blocked", "push bloqué : secret détecté ou scan incomplet", {
        reasons: plan.blockedReasons,
      });
    }
    if (plan.push.plan.force !== false) throw new GitHubError("invalid_argument", "push forcé non pris en charge");
    const { remote, localBranch, remoteBranch, remoteUrl } = plan.push.plan;
    try {
      assertSafeRefName(remote, "remote");
      assertSafeRefName(localBranch, "branche");
      assertSafeRefName(remoteBranch, "branche distante");
    } catch (e) {
      throw new GitHubError("invalid_argument", (e as Error).message);
    }
    if (!SHA.test(plan.headSha)) throw new GitHubError("invalid_argument", "tête de branche invalide");
    // Contrôle sans commande : un plan préparé ailleurs avec un protocole interdit ici ne consomme rien.
    assertProtocolAllowed(remoteUrl ?? "", this.allowedProtocols);

    // 1. Approbation : AVANT toute commande. Usage unique, empreinte du plan, expiration, action `git_push`.
    await this.consume(approvalId, "git_push", plan.approvalPlan);

    // 2. L'état réel doit toujours correspondre au plan approuvé (même tête, mêmes commits, même remote…).
    let current: PreparedPush;
    try {
      current = await this.preparePush(repo, localBranch, remote, remoteBranch);
    } catch (e) {
      throw new GitHubError("state_changed", `l'état du dépôt ne correspond plus au plan : ${(e as Error).message}`);
    }
    if (current.headSha !== plan.headSha || current.fingerprint !== sha256Hex(canonicalJson(plan.approvalPlan))) {
      throw new GitHubError("state_changed", "l'état du dépôt a changé depuis l'approbation : nouveau plan requis");
    }
    if (current.blocked) throw new GitHubError("plan_blocked", "push bloqué : secret détecté ou scan incomplet");

    // 2 bis. Config locale du dépôt : une commande définie par le dépôt (sshCommand, askPass, filtre…) s'exécuterait
    // sur l'hôte pendant le push. Refusé : seule la configuration globale de l'utilisateur est honorée.
    const cfg = await this.gitLocal(current.repo, ["config", "--list", "--show-scope", "-z"], [0, 1]);
    const unsafe = [...new Set([...unsafeConfigKeys(cfg.stdout), ...localCommandKeys(cfg.stdout)])];
    if (unsafe.length > 0) {
      throw new GitHubError(
        "plan_blocked",
        `push refusé : la configuration git du dépôt définit une commande (${unsafe.slice(0, 10).join(", ")})`,
        { keys: unsafe.slice(0, 50) },
      );
    }

    // 3. Push. Le commit exact approuvé est poussé (pas le nom de branche, qui a pu avancer entre-temps).
    const pushArgs = [
      "--porcelain",
      "--no-verify",
      "--no-recurse-submodules",
      remote,
      `${plan.headSha}:refs/heads/${remoteBranch}`,
    ];
    assertSafePushArgs(pushArgs);
    const args = [
      ...GIT_HARDENING,
      ...protocolConfigArgs(this.allowedProtocols),
      // Neutralise une configuration du dépôt qui élargirait le push (miroir, étiquettes suivies).
      "-c",
      `remote.${remote}.mirror=false`,
      "-c",
      "push.followTags=false",
      "push",
      ...pushArgs,
    ];
    const r = await this.exec(
      this.gitPath,
      args,
      current.repo,
      { ...this.baseEnv, GIT_TERMINAL_PROMPT: "0" },
      {
        what: "git push",
        timeoutMs: this.remoteTimeoutMs,
      },
    );
    const output = cleanOutput(`${r.stdout}\n${r.stderr}`.trim(), 2000);
    if (r.code !== 0) throw classifyPushFailure(r.stderr, r.stdout, r.code);
    const line = r.stdout.split("\n").find((l) => l.includes(`:refs/heads/${remoteBranch}\t`));
    const flag = line?.[0];
    if (flag !== " " && flag !== "*" && flag !== "=") {
      throw new GitHubError("command_failed", `résultat de push inattendu : ${output.slice(0, 300)}`);
    }
    return { remote, remoteBranch, sha: plan.headSha, flag, output };
  }

  // ------------------------------------------------------------------ pull request

  /** Plan de PR à faire approuver (`approvals.request({ action: "github_pr_create", plan: approvalPlan })`). */
  async preparePullRequest(repo: string, input: PullRequestInput): Promise<PreparedPullRequest> {
    const v = validatePrInput(input);
    const top = await this.repoTop(repo);
    const body = Buffer.from(v.body, "utf8");
    const approvalPlan: PullRequestApprovalPlan = {
      kind: "nexus.github_pr_create",
      v: 1,
      repo: top,
      base: v.base,
      head: v.head,
      title: v.title,
      bodySha256: sha256Hex(v.body),
      bodyBytes: body.length,
      draft: v.draft,
    };
    const summary = `Créer une pull request${v.draft ? " (brouillon)" : ""} « ${v.title} » : ${v.head} -> ${v.base} (${body.length} octets de description)`;
    return { approvalPlan, fingerprint: sha256Hex(canonicalJson(approvalPlan)), summary: summary.slice(0, 2000) };
  }

  async createPullRequest(repo: string, input: PullRequestInput, approvalId: string): Promise<PullRequestResult> {
    const v = validatePrInput(input);
    if (!this.ghPath) throw new GitHubError("unavailable", "gh n'est pas configuré : création de PR indisponible");
    const prepared = await this.preparePullRequest(repo, v);
    // Approbation consommée AVANT toute commande gh.
    await this.consume(approvalId, "github_pr_create", prepared.approvalPlan);
    const args = ["pr", "create", "--title", v.title, "--body-file", "-", "--base", v.base, "--head", v.head];
    if (v.draft) args.push("--draft");
    const r = await this.exec(this.ghPath, args, prepared.approvalPlan.repo, this.ghEnv(), {
      what: "gh pr create",
      stdin: v.body,
      timeoutMs: this.remoteTimeoutMs,
    });
    const output = cleanOutput(`${r.stdout}\n${r.stderr}`.trim(), 2000);
    if (r.code === 4) throw new GitHubError("auth_required", "gh n'est pas authentifié : lancer `gh auth login`");
    if (r.code !== 0) throw new GitHubError("command_failed", `gh pr create a échoué (code ${r.code}) : ${output}`);
    const url = extractPullRequestUrl(r.stdout) ?? extractPullRequestUrl(r.stderr);
    if (!url) throw new GitHubError("command_failed", "URL de la pull request introuvable dans la sortie de gh");
    return { url, output };
  }
}

// ------------------------------------------------------------------ fonctions pures

function statusLetter(s: string): string {
  return (
    { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", type_changed: "T", unmerged: "U" }[s] ?? "X"
  );
}

// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function validatePrInput(input: PullRequestInput): Required<PullRequestInput> {
  if (!input || typeof input !== "object") throw new GitHubError("invalid_argument", "entrée de PR invalide");
  const { title, body, base, head } = input;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > MAX_TITLE ||
    CONTROL.test(title) ||
    /[\n\t]/.test(title)
  ) {
    throw new GitHubError("invalid_argument", `titre requis (${MAX_TITLE} caractères max, une ligne)`);
  }
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_BODY || body.includes("\0")) {
    throw new GitHubError("invalid_argument", `description invalide (${MAX_BODY} octets max)`);
  }
  try {
    assertSafeRefName(base, "base");
    const m = HEAD_REF.exec(typeof head === "string" ? head : "");
    assertSafeRefName(m?.[1], "head");
  } catch (e) {
    throw new GitHubError("invalid_argument", (e as Error).message);
  }
  if (title.startsWith("-")) throw new GitHubError("invalid_argument", "le titre ne peut pas commencer par '-'");
  return { title, body, base, head, draft: input.draft === true };
}

/** Dernière URL de pull request (`https://<hôte>/<owner>/<repo>/pull/<n>`) trouvée dans un texte. */
export function extractPullRequestUrl(text: string): string | null {
  const all = [...text.matchAll(/https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g)];
  return all.length ? all[all.length - 1]![0] : null;
}

/** Analyse de la sortie (déjà expurgée) de `gh auth status`. Prudence : en cas de doute, `unknown`. */
export function parseGhAuthStatus(text: string, exitCode: number): GhAuthStatus {
  const accounts: GhAccount[] = [];
  const re = /Logged in to (\S+) (?:account|as) (\S+?)\s*\(([^)]*)\)/g;
  for (const m of text.matchAll(re)) {
    const where = m[3] ?? "";
    const storage: GhAccount["storage"] = /keyring/i.test(where)
      ? "keyring"
      : /[/\\]|\.yml/.test(where)
        ? "file"
        : "unknown";
    accounts.push({ host: m[1]!, login: m[2]!, storage });
  }
  const insecureStorage = accounts.some((a) => a.storage === "file");
  const output = text.slice(0, 4000);
  if (exitCode === 0 && accounts.length > 0) return { state: "authenticated", accounts, insecureStorage, output };
  if (/not logged in|Failed to log in|gh auth login/i.test(text) && accounts.length === 0) {
    return { state: "unauthenticated", accounts, insecureStorage, output };
  }
  if (exitCode !== 0 && /Failed to log in/i.test(text)) {
    return { state: "unauthenticated", accounts, insecureStorage, output };
  }
  return { state: "unknown", accounts, insecureStorage, reason: `indéterminé (code ${exitCode})`, output };
}

function classifyPushFailure(stderr: string, stdout: string, code: number): GitHubError {
  const text = `${stdout}\n${stderr}`;
  const shown = cleanOutput(text.trim(), 400);
  if (/protocol '[^']*' is not allowed|transport '[^']*' not allowed/i.test(text)) {
    return new GitHubError("protocol_not_allowed", `protocole refusé par git : ${shown}`);
  }
  if (/\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]|^!/m.test(text)) {
    return new GitHubError("push_rejected", `push refusé par le serveur (sans force, aucune réécriture) : ${shown}`);
  }
  if (/Authentication failed|could not read Username|Permission denied|terminal prompts disabled|403/i.test(text)) {
    return new GitHubError("auth_required", `authentification requise ou refusée : ${shown}`);
  }
  return new GitHubError("command_failed", `git push a échoué (code ${code}) : ${shown}`);
}
