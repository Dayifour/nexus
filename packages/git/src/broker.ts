// Git broker (§13, ADR-008) : seule voie d'accès à la CLI git pour Nexus.
// - Toute exécution passe par `runProcess` (binaire absolu, tableau d'arguments, shell:false, PID namespace, timeout).
// - Environnement construit ici, jamais hérité de process.env.
// - Noms de réf validés par liste blanche, chemins après `--` avec GIT_LITERAL_PATHSPECS=1.
// - Hooks, fsmonitor, diff externes, textconv et transports désactivés : un dépôt non fiable n'exécute rien via git.
// - Config du dépôt (local/worktree) : toute clé capable de lancer une commande (filtres clean/smudge/process, pilotes
//   de diff/merge, include…) fait refuser l'opération (UNSAFE_REPO_CONFIG) ; les autres sont neutralisées par `-c`.
// - Worktree de tâche : son gitdir doit être celui enregistré par le dépôt principal (pointeur `.git` non falsifié).
// - Aucune action distante ici (push : T-018). `planPush` (plan.ts) produit seulement le plan à approuver.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  closeSync,
  fstatSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveExecutable, runProcess, type RunOptions, type RunResult } from "@nexus/process-supervisor";
import { bound, GitError } from "./errors.ts";
import { parseNameStatusZ, parsePorcelainZ, splitZ, type FileChange, type StatusEntry } from "./parse.ts";
import { mergePlanFingerprint, sha256Hex } from "./plan.ts";
import { maskSecretsInText, scanDiffForSecrets, type SecretFinding } from "./secrets.ts";
import {
  assertAuthor,
  assertCommitMessage,
  assertRelativePath,
  assertSafeRefName,
  assertTaskBranch,
  FINGERPRINT,
  TASK_BRANCH,
  taskBranchName,
  type GitAuthor,
} from "./validate.ts";

export type Runner = (opts: RunOptions) => Promise<RunResult>;

export type GitBrokerOptions = {
  /** Chemin absolu de git (voir `locateGit`). */
  gitPath: string;
  /** HOME fourni explicitement (config globale de l'utilisateur, ou dossier vide pour l'isolation). */
  home: string;
  /** Dossier dédié aux worktrees de tâche, hors de tout dépôt principal. */
  worktreesRoot: string;
  /** PATH transmis à git, absent par défaut (git n'en a pas besoin pour ses commandes intégrées). */
  pathEnv?: string;
  timeoutMs?: number;
  /** Plafond de sortie standard d'une commande (hors diff unifié, lu depuis un fichier). */
  maxOutputBytes?: number;
  runner?: Runner;
};

export type RepoInfo = { top: string; gitDir: string; commonDir: string; isMain: boolean };

export type StatusResult = { branch: string | null; clean: boolean; entries: StatusEntry[]; truncated: boolean };

export type DiffOptions = {
  /** Si fourni : diff de `merge-base(base, head)` vers `head` (revue d'une branche de tâche). Sinon : worktree vs HEAD. */
  base?: string;
  head?: string;
  paths?: readonly string[];
  /** Taille maximale du texte unifié renvoyé (défaut 256 Kio). */
  maxBytes?: number;
  /** Taille maximale analysée par le scanner de secrets (défaut 8 Mio). */
  scanMaxBytes?: number;
  /** Masque les secrets détectés dans le texte renvoyé (défaut : true). */
  maskSecrets?: boolean;
  maxFiles?: number;
};

export type DiffResult = {
  from: string;
  to: string | null;
  files: FileChange[];
  filesTruncated: boolean;
  unified: string;
  unifiedBytes: number;
  truncated: boolean;
  secrets: SecretFinding[];
  /** false si le diff dépasse `scanMaxBytes` : un appelant de push DOIT alors refuser par défaut. */
  secretsScanComplete: boolean;
};

export type TaskWorktree = { path: string; branch: string; baseCommit: string };

export type MergePlan = {
  repo: string;
  branch: string;
  targetBranch: string | null;
  targetHead: string;
  branchTip: string;
  fingerprint: string;
  summary: string;
};

export type MergeResult =
  | { status: "merged"; commit: string; files: FileChange[] }
  | { status: "up_to_date"; commit: string }
  | { status: "conflict"; files: string[] };

export function locateGit(pathEnv: string): string | null {
  return resolveExecutable("git", pathEnv)?.path ?? null;
}

const GLOBAL_ARGS = [
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "color.ui=false",
  "-c",
  "advice.detachedHead=false",
  // Commandes configurables jamais utiles au broker : neutralisées quelle que soit la config du dépôt.
  "-c",
  "core.sshCommand=false",
  "-c",
  "core.editor=false",
  "-c",
  "sequence.editor=false",
  "-c",
  "core.pager=cat",
  "-c",
  "credential.helper=",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "merge.verifySignatures=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "diff.ignoreSubmodules=dirty",
] as const;

/**
 * Clés de config (portée local/worktree, includes suivis) capables d'exécuter une commande pendant les opérations du
 * broker (status, diff, add, commit, worktree add, merge) et non neutralisables par `-c` (noms choisis par le dépôt).
 * Les includes sont refusés : ils peuvent désigner n'importe quel fichier.
 */
const UNSAFE_CONFIG_KEYS: readonly RegExp[] = [
  /^include\./,
  /^includeif\./,
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(textconv|command)$/,
  /^diff\.external$/,
  /^merge\..+\.driver$/,
  /^trailer\..+\.(command|cmd)$/,
  /^core\.worktree$/,
];

export function unsafeConfigKeys(listZ: string): string[] {
  const out: string[] = [];
  const parts = listZ.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!;
    const key = (parts[i + 1]!.split("\n", 1)[0] ?? "").toLowerCase();
    if (scope !== "local" && scope !== "worktree") continue;
    if (UNSAFE_CONFIG_KEYS.some((re) => re.test(key)) && !out.includes(key)) out.push(key);
  }
  return out;
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"] as const;

type RunGitOpts = { env?: Record<string, string>; stdin?: string; ok?: readonly number[]; timeoutMs?: number };
type GitOut = { code: number; stdout: string; stderr: string };

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    throw new GitError("NOT_A_REPOSITORY", "chemin introuvable");
  }
};
const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

export class GitBroker {
  readonly gitPath: string;
  readonly worktreesRoot: string;
  private readonly env: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: Runner;

  constructor(opts: GitBrokerOptions) {
    if (typeof opts.gitPath !== "string" || !isAbsolute(opts.gitPath)) {
      throw new GitError("INVALID_ARGUMENT", "gitPath doit être un chemin absolu");
    }
    if (typeof opts.home !== "string" || !isAbsolute(opts.home)) {
      throw new GitError("INVALID_ARGUMENT", "home doit être un chemin absolu");
    }
    if (typeof opts.worktreesRoot !== "string" || !isAbsolute(opts.worktreesRoot)) {
      throw new GitError("INVALID_ARGUMENT", "worktreesRoot doit être un chemin absolu");
    }
    this.gitPath = opts.gitPath;
    this.worktreesRoot = opts.worktreesRoot;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxOutputBytes = opts.maxOutputBytes ?? 4 << 20;
    this.runner = opts.runner ?? runProcess;
    this.env = {
      HOME: opts.home,
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      ...(opts.pathEnv ? { PATH: opts.pathEnv } : {}),
    };
  }

  // ------------------------------------------------------------------ exécution

  private async git(cwd: string, args: readonly string[], o: RunGitOpts = {}): Promise<GitOut> {
    const stdout: string[] = [];
    let stderr = "";
    const r = await this.runner({
      file: this.gitPath,
      args: [...GLOBAL_ARGS, ...args],
      cwd,
      env: { ...this.env, ...o.env },
      timeoutMs: o.timeoutMs ?? this.timeoutMs,
      killGraceMs: 1000,
      maxOutputBytes: this.maxOutputBytes,
      ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
      onChunk: (chunk, channel) => {
        if (channel === "stdout") stdout.push(chunk);
        else stderr = (stderr + chunk).slice(-4096); // seule la fin de stderr est conservée
      },
    });
    const sub = args[0] ?? "?";
    if (r.spawnError) throw new GitError("GIT_SPAWN_FAILED", `git ${sub} : lancement impossible (${r.spawnError})`);
    if (r.timedOut) throw new GitError("GIT_TIMEOUT", `git ${sub} : délai dépassé`);
    if (r.outputLimitExceeded) throw new GitError("OUTPUT_LIMIT", `git ${sub} : sortie au-delà de la limite`);
    if (r.cancelled || r.exitCode === null) throw new GitError("GIT_FAILED", `git ${sub} : interrompu (${r.signal})`);
    const out = { code: r.exitCode, stdout: stdout.join(""), stderr };
    if (!(o.ok ?? [0]).includes(r.exitCode)) {
      throw new GitError("GIT_FAILED", `git ${sub} a échoué (code ${r.exitCode}) : ${bound(stderr.trim(), 400)}`);
    }
    return out;
  }

  // ------------------------------------------------------------------ dépôts

  /** Vérifie que `path` est la racine d'un worktree git et retourne ses chemins réels. */
  async repoInfo(path: string): Promise<RepoInfo> {
    if (typeof path !== "string" || !isAbsolute(path)) throw new GitError("INVALID_PATH", "chemin absolu requis");
    const p = real(path);
    const r = await this.git(
      p,
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
      {
        ok: [0, 128],
      },
    );
    const [top, gitDir, commonDir] = r.stdout.split("\n");
    if (r.code !== 0 || !top || !gitDir || !commonDir) throw new GitError("NOT_A_REPOSITORY", "pas un dépôt git");
    if (real(top) !== p) throw new GitError("NOT_A_REPOSITORY", "le chemin n'est pas la racine d'un worktree");
    await this.assertSafeRepoConfig(p);
    return { top: p, gitDir: real(gitDir), commonDir: real(commonDir), isMain: real(gitDir) === real(commonDir) };
  }

  /**
   * Refuse un dépôt dont la config locale (ou de worktree, includes compris) définit une commande exécutable
   * (filtre clean/smudge/process, pilote de diff ou de merge, include…) : git l'exécuterait sur l'hôte, hors sandbox.
   */
  async assertSafeRepoConfig(path: string): Promise<void> {
    if (typeof path !== "string" || !isAbsolute(path)) throw new GitError("INVALID_PATH", "chemin absolu requis");
    const r = await this.git(real(path), ["config", "--list", "--show-scope", "-z"], { ok: [0, 1, 128] });
    if (r.code === 128)
      throw new GitError("UNSAFE_REPO_CONFIG", "configuration git du dépôt illisible : opération refusée");
    const keys = unsafeConfigKeys(r.stdout);
    if (keys.length > 0) {
      throw new GitError(
        "UNSAFE_REPO_CONFIG",
        `configuration git du dépôt refusée : ${keys.slice(0, 10).join(", ")} peut exécuter une commande sur l'hôte`,
        { keys: keys.slice(0, 50) },
      );
    }
  }

  private async requireMain(repo: string): Promise<RepoInfo> {
    const info = await this.repoInfo(repo);
    if (!info.isMain)
      throw new GitError("NOT_MAIN_WORKTREE", "le dépôt principal est requis, pas un worktree de tâche");
    return info;
  }

  private rootReal(): string | null {
    try {
      return realpathSync(this.worktreesRoot);
    } catch {
      return null;
    }
  }

  private async requireTaskWorktree(worktree: string): Promise<RepoInfo & { branch: string }> {
    const info = await this.repoInfo(worktree);
    const root = this.rootReal();
    if (info.isMain || !root || !isInside(info.top, root) || info.top === root) {
      throw new GitError("NOT_TASK_WORKTREE", "opération réservée aux worktrees de tâche gérés par Nexus");
    }
    await this.assertRegisteredWorktree(info, root);
    const branch = await this.currentBranch(info.top);
    if (!branch || !TASK_BRANCH.test(branch)) {
      throw new GitError("NOT_TASK_WORKTREE", "le worktree n'est pas sur une branche nexus/task-<id>");
    }
    return { ...info, branch };
  }

  /**
   * Le pointeur `.git` d'un worktree est un fichier du workspace : falsifié, il désignerait un gitdir (et sa config)
   * choisi par l'agent. Exigé : gitdir = `<commonDir>/worktrees/<nom>`, dont le `gitdir` pointe en retour sur ce
   * worktree, commonDir hors des worktrees de tâche, et worktree listé par le dépôt principal.
   */
  private async assertRegisteredWorktree(info: RepoInfo, root: string): Promise<void> {
    const forged = () =>
      new GitError("NOT_TASK_WORKTREE", "pointeur gitdir du worktree non reconnu par le dépôt principal : refusé");
    if (dirname(info.gitDir) !== join(info.commonDir, "worktrees")) throw forged();
    if (isInside(info.commonDir, root) || isInside(info.gitDir, info.top)) throw forged();
    let back: string;
    try {
      back = readFileSync(join(info.gitDir, "gitdir"), "utf8").trim();
      back = realpathSync(isAbsolute(back) ? back : join(info.gitDir, back));
    } catch {
      throw forged();
    }
    if (back !== join(info.top, ".git")) throw forged();
    if (basename(info.commonDir) !== ".git") throw forged(); // dépôt principal non nu attendu
    const mainTop = dirname(info.commonDir);
    let main: RepoInfo;
    try {
      main = await this.requireMain(mainTop);
    } catch (e) {
      if (e instanceof GitError && e.code === "UNSAFE_REPO_CONFIG") throw e;
      throw forged();
    }
    if (main.commonDir !== info.commonDir) throw forged();
    if (!(await this.listTaskWorktrees(main.top)).some((w) => w.path === info.top)) throw forged();
  }

  private async resolveCommit(cwd: string, ref: string): Promise<string> {
    assertSafeRefName(ref);
    const r = await this.git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
      ok: [0, 1, 128],
    });
    const sha = r.stdout.trim();
    if (r.code !== 0 || !/^[a-f0-9]{40,64}$/.test(sha)) throw new GitError("REF_NOT_FOUND", `réf introuvable : ${ref}`);
    return sha;
  }

  private async mergeInProgress(top: string): Promise<boolean> {
    const r = await this.git(top, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], { ok: [0, 1, 128] });
    return r.code === 0;
  }

  // ------------------------------------------------------------------ lecture

  async currentBranch(path: string): Promise<string | null> {
    const r = await this.git(real(path), ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: [0, 1] });
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  async status(path: string): Promise<StatusResult> {
    const info = await this.repoInfo(path);
    const r = await this.git(info.top, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // `dirty` : l'état d'un sous-module est lu sans lancer git dans son dossier (sa config n'est pas vérifiée).
      "--ignore-submodules=dirty",
    ]);
    const { entries, truncated } = parsePorcelainZ(r.stdout);
    return { branch: await this.currentBranch(info.top), clean: entries.length === 0, entries, truncated };
  }

  /** Modifications présentes dans le worktree PRINCIPAL (non autorisées : les tâches écrivent dans leur worktree). */
  async mainWorktreeChanges(repo: string): Promise<StatusEntry[]> {
    const info = await this.requireMain(repo);
    return (await this.status(info.top)).entries;
  }

  async assertMainWorktreeClean(repo: string): Promise<void> {
    const changes = await this.mainWorktreeChanges(repo);
    if (changes.length > 0) {
      throw new GitError(
        "MAIN_WORKTREE_DIRTY",
        `${changes.length} modification(s) non autorisée(s) dans le worktree principal`,
        {
          files: changes.slice(0, 50).map((e) => e.path),
        },
      );
    }
  }

  async diff(path: string, opts: DiffOptions = {}): Promise<DiffResult> {
    const info = await this.repoInfo(path);
    const maxBytes = opts.maxBytes ?? 256 * 1024;
    const scanMaxBytes = Math.max(opts.scanMaxBytes ?? 8 << 20, maxBytes);
    const paths = (opts.paths ?? []).map(assertRelativePath);
    let revs: string[];
    let from: string;
    let to: string | null;
    if (opts.base !== undefined) {
      const baseSha = await this.resolveCommit(info.top, opts.base);
      const headSha = await this.resolveCommit(info.top, opts.head ?? "HEAD");
      const mb = await this.git(info.top, ["merge-base", "--end-of-options", baseSha, headSha], { ok: [0, 1] });
      if (mb.code !== 0) throw new GitError("REF_NOT_FOUND", "aucun ancêtre commun");
      from = mb.stdout.trim();
      to = headSha;
      revs = [from, to];
    } else {
      if (opts.head !== undefined) throw new GitError("INVALID_ARGUMENT", "head exige base");
      from = await this.resolveCommit(info.top, "HEAD");
      to = null; // worktree courant
      revs = [from];
    }

    const ns = await this.git(info.top, ["diff", ...DIFF_FLAGS, "--name-status", "-z", ...revs, "--", ...paths]);
    const { files, truncated: filesTruncated } = parseNameStatusZ(ns.stdout, opts.maxFiles ?? 5000);

    // Le diff unifié est écrit par git dans un fichier privé puis lu en taille bornée : il échappe ainsi à la
    // redaction de runProcess (le scanner doit voir les valeurs réelles) et au plafond de sortie standard.
    const dir = mkdtempSync(join(tmpdir(), "nexus-git-diff-"));
    try {
      const file = join(dir, "diff.patch");
      await this.git(info.top, ["diff", ...DIFF_FLAGS, `--output=${file}`, ...revs, "--", ...paths], {
        timeoutMs: Math.max(this.timeoutMs, 60_000),
      });
      const fd = openSync(file, "r");
      let size: number;
      let raw: string;
      try {
        size = fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(size, scanMaxBytes));
        let off = 0;
        while (off < buf.length) {
          const n = readSync(fd, buf, off, buf.length - off, off);
          if (n === 0) break;
          off += n;
        }
        raw = buf.subarray(0, off).toString("utf8");
      } finally {
        closeSync(fd);
      }
      const scan = scanDiffForSecrets(raw);
      const shown = Buffer.from(raw, "utf8").subarray(0, maxBytes).toString("utf8");
      return {
        from,
        to,
        files,
        filesTruncated,
        unified: opts.maskSecrets === false ? shown : maskSecretsInText(shown),
        unifiedBytes: size,
        truncated: size > maxBytes,
        secrets: scan.findings,
        secretsScanComplete: size <= scanMaxBytes && !scan.truncated,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ worktrees de tâche

  async createTaskWorktree(repo: string, taskId: string, baseRef: string): Promise<TaskWorktree> {
    const branch = taskBranchName(taskId);
    assertSafeRefName(baseRef, "baseRef");
    const info = await this.requireMain(repo);

    mkdirSync(this.worktreesRoot, { recursive: true, mode: 0o700 });
    const root = realpathSync(this.worktreesRoot);
    if (isInside(root, info.top) || isInside(root, info.commonDir)) {
      throw new GitError("WORKTREE_ROOT_INSIDE_REPO", "le dossier des worktrees doit être hors du dépôt principal");
    }
    const target = join(root, `${basename(info.top)}-${sha256Hex(info.top).slice(0, 8)}`, `task-${taskId}`);
    if (existsSync(target)) throw new GitError("WORKTREE_EXISTS", `worktree déjà présent pour la tâche ${taskId}`);
    const exists = await this.git(info.top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      ok: [0, 1],
    });
    if (exists.code === 0) throw new GitError("BRANCH_EXISTS", `la branche ${branch} existe déjà`);

    const baseCommit = await this.resolveCommit(info.top, baseRef);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    await this.git(info.top, ["worktree", "add", "--quiet", "-b", branch, "--", target, baseCommit], {
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
    return { path: realpathSync(target), branch, baseCommit };
  }

  async listTaskWorktrees(repo: string): Promise<{ path: string; branch: string | null }[]> {
    const info = await this.requireMain(repo);
    const r = await this.git(info.top, ["worktree", "list", "--porcelain", "-z"]);
    const root = this.rootReal();
    const out: { path: string; branch: string | null }[] = [];
    let cur: { path: string; branch: string | null } | null = null;
    for (const field of r.stdout.split("\0")) {
      if (field.startsWith("worktree ")) {
        cur = { path: field.slice("worktree ".length), branch: null };
        if (root && isInside(cur.path, root) && cur.path !== root) out.push(cur);
      } else if (field.startsWith("branch refs/heads/") && cur) {
        cur.branch = field.slice("branch refs/heads/".length);
      }
    }
    return out;
  }

  async removeWorktree(
    repo: string,
    worktreePath: string,
    opts: { force?: boolean; deleteBranch?: boolean } = {},
  ): Promise<void> {
    const info = await this.requireMain(repo);
    if (typeof worktreePath !== "string" || !isAbsolute(worktreePath))
      throw new GitError("INVALID_PATH", "chemin absolu requis");
    const wanted = existsSync(worktreePath) ? realpathSync(worktreePath) : worktreePath;
    const entry = (await this.listTaskWorktrees(info.top)).find((w) => w.path === wanted);
    if (!entry) throw new GitError("NOT_TASK_WORKTREE", "worktree inconnu ou non géré par Nexus");
    await this.git(info.top, ["worktree", "remove", ...(opts.force ? ["--force"] : []), "--", entry.path]);
    if (opts.deleteBranch && entry.branch && TASK_BRANCH.test(entry.branch)) {
      await this.git(info.top, ["branch", "-D", "--", entry.branch]);
    }
  }

  async commitAll(worktree: string, message: string, author: GitAuthor): Promise<{ commit: string; branch: string }> {
    assertCommitMessage(message);
    const who = assertAuthor(author);
    const info = await this.requireTaskWorktree(worktree);
    await this.git(info.top, ["add", "--all", "--", "."]);
    const staged = await this.git(info.top, ["diff", "--cached", "--quiet"], { ok: [0, 1] });
    if (staged.code === 0) throw new GitError("NOTHING_TO_COMMIT", "aucune modification à committer");
    await this.git(info.top, ["commit", "--quiet", "--no-verify", "-F", "-"], {
      stdin: message,
      env: identityEnv(who),
    });
    return { commit: await this.resolveCommit(info.top, "HEAD"), branch: info.branch };
  }

  // ------------------------------------------------------------------ merge (ADR-008)

  /** Plan de merge à faire approuver : son empreinte doit être fournie telle quelle à `mergeTaskBranch`. */
  async planMerge(repo: string, branch: string): Promise<MergePlan> {
    assertTaskBranch(branch);
    const info = await this.requireMain(repo);
    const targetHead = await this.resolveCommit(info.top, "HEAD");
    const branchTip = await this.resolveCommit(info.top, `refs/heads/${branch}`);
    const targetBranch = await this.currentBranch(info.top);
    const fingerprint = mergePlanFingerprint({ repo: info.top, branch, targetHead, branchTip });
    const summary = `Merge ${branch} (${branchTip.slice(0, 10)}) dans ${targetBranch ?? "HEAD détachée"} (${targetHead.slice(0, 10)}), --no-ff`;
    return { repo: info.top, branch, targetBranch, targetHead, branchTip, fingerprint, summary };
  }

  async mergeTaskBranch(
    repo: string,
    branch: string,
    opts: { approvalFingerprint: string; author: GitAuthor; message?: string },
  ): Promise<MergeResult> {
    // Refus AVANT toute commande git : pas de merge silencieux.
    if (typeof opts?.approvalFingerprint !== "string" || !FINGERPRINT.test(opts.approvalFingerprint)) {
      throw new GitError("APPROVAL_REQUIRED", "merge refusé : empreinte d'approbation absente ou invalide");
    }
    assertTaskBranch(branch);
    const who = assertAuthor(opts.author);
    if (opts.message !== undefined) assertCommitMessage(opts.message);
    const info = await this.requireMain(repo);
    if (await this.mergeInProgress(info.top)) throw new GitError("MERGE_IN_PROGRESS", "un merge est déjà en cours");
    await this.assertMainWorktreeClean(info.top);

    const plan = await this.planMerge(info.top, branch);
    if (plan.fingerprint !== opts.approvalFingerprint) {
      throw new GitError(
        "APPROVAL_MISMATCH",
        "l'approbation ne correspond pas à l'état actuel (dépôt, branche ou commits)",
      );
    }
    const before = plan.targetHead;

    // Le commit exact approuvé (et non le nom de branche, qui a pu avancer) est fusionné, sans commit automatique.
    const m = await this.git(info.top, ["merge", "--no-ff", "--no-commit", "--no-stat", "--quiet", plan.branchTip], {
      ok: [0, 1, 2, 128],
      env: identityEnv(who),
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
    const unmerged = splitZ(
      (await this.git(info.top, ["diff", "--name-only", "--diff-filter=U", "-z"], { ok: [0, 1] })).stdout,
    ).slice(0, 1000);

    if (unmerged.length > 0) {
      await this.restore(info.top, before);
      return { status: "conflict", files: unmerged };
    }
    if (m.code !== 0) {
      await this.restore(info.top, before);
      throw new GitError("MERGE_FAILED", `merge impossible : ${bound(m.stderr.trim(), 400)}`);
    }
    if (!(await this.mergeInProgress(info.top))) {
      await this.restore(info.top, before);
      return { status: "up_to_date", commit: before };
    }

    const message =
      opts.message ??
      `Merge ${branch}\n\nNexus-Approval: ${opts.approvalFingerprint}\nNexus-Branch-Tip: ${plan.branchTip}\n`;
    try {
      await this.git(info.top, ["commit", "--quiet", "--no-verify", "-F", "-"], {
        stdin: message,
        env: identityEnv(who),
      });
    } catch (e) {
      await this.restore(info.top, before);
      throw new GitError("MERGE_FAILED", `commit de merge impossible : ${(e as Error).message}`);
    }
    const commit = await this.resolveCommit(info.top, "HEAD");
    const ns = await this.git(info.top, ["diff", ...DIFF_FLAGS, "--name-status", "-z", before, commit]);
    return { status: "merged", commit, files: parseNameStatusZ(ns.stdout).files };
  }

  /** Remet le dépôt principal exactement dans son état d'avant merge, ou lève MAIN_WORKTREE_NOT_RESTORED. */
  private async restore(top: string, before: string): Promise<void> {
    if (await this.mergeInProgress(top)) await this.git(top, ["merge", "--abort"], { ok: [0, 128] });
    let head = await this.resolveCommit(top, "HEAD").catch(() => "");
    let st = await this.status(top);
    if (head === before && st.clean) return;
    // Dernier recours non destructif pour l'historique : `reset --merge` (équivalent de merge --abort sans MERGE_HEAD).
    await this.git(top, ["reset", "--quiet", "--merge", before], { ok: [0, 128] });
    head = await this.resolveCommit(top, "HEAD").catch(() => "");
    st = await this.status(top);
    if (head !== before || !st.clean) {
      throw new GitError(
        "MAIN_WORKTREE_NOT_RESTORED",
        "le dépôt principal n'a pas pu être restauré : intervention requise",
        {
          files: st.entries.slice(0, 50).map((e) => e.path),
        },
      );
    }
  }
}

function identityEnv(a: GitAuthor): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: a.name,
    GIT_AUTHOR_EMAIL: a.email,
    GIT_COMMITTER_NAME: a.name,
    GIT_COMMITTER_EMAIL: a.email,
  };
}
