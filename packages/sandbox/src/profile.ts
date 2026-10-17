// Construction des arguments bubblewrap à partir du contrat `SandboxProfile` (ADR-001 §5, T-014).
// Principe : rien n'est visible sauf ce qui est monté. Les secrets de l'hôte (HOME, ~/.ssh, magasins d'identifiants)
// ne sont jamais montés. Dans le workspace :
//  - fichiers d'identifiants (.npmrc, .git-credentials, clés privées, .ssh/, .aws/…) : toujours masqués ;
//  - fichiers `.env*` : masqués seulement si `protectEnvFiles` (décision D-4 du propriétaire : visibles par défaut) ;
//  - métadonnées git (`.git`, gitdir et commondir d'un worktree s'ils sont visibles) : LECTURE SEULE. Git est exécuté
//    sur l'hôte par le Git broker ; un agent qui écrirait `.git/config` (filtres clean/smudge, sshCommand…) ou le
//    pointeur `gitdir` d'un worktree obtiendrait une exécution de code hors sandbox. Les commits sont faits par Nexus.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxProfile } from "@nexus/contracts";

export const WORKSPACE_MOUNT = "/workspace";
export const EGRESS_SOCKET_MOUNT = "/run/nexus/egress.sock";

const ENV_FILE = /^\.env(\..+)?$|^\.envrc$/;
const CREDENTIAL_DIRS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".kube",
  ".azure",
  ".vercel",
  ".claude",
  ".codex",
  ".config",
]);
const CREDENTIAL_FILES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
]);
const CREDENTIAL_PATTERNS = [/^id_(rsa|dsa|ecdsa|ed25519)$/, /\.(pem|key|p12|pfx)$/];

export function isCredentialName(name: string): boolean {
  return CREDENTIAL_DIRS.has(name) || CREDENTIAL_FILES.has(name) || CREDENTIAL_PATTERNS.some((re) => re.test(name));
}

export function isEnvFileName(name: string): boolean {
  return ENV_FILE.test(name);
}

/**
 * Fichiers à masquer dans le workspace (sans suivre les liens, sans lire de contenu).
 * Limite connue : un fichier créé APRÈS le démarrage du sandbox n'est pas masqué (ADR-001 constat 2).
 */
export function findMaskedPaths(root: string, opts: { protectEnvFiles: boolean; maxEntries?: number }): string[] {
  const max = opts.maxEntries ?? 100_000;
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++seen > max) throw new Error("findMaskedPaths: workspace too large to scan");
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // la cible d'un lien sortant n'est de toute façon pas montée
      if ((entry.name === ".git" || entry.name === "node_modules") && entry.isDirectory()) continue;
      if (isCredentialName(entry.name) || (opts.protectEnvFiles && isEnvFileName(entry.name))) found.push(p);
      else if (entry.isDirectory()) walk(p);
    }
  };
  walk(root);
  return found;
}

const insideOrEqual = (child: string, parent: string): string | null => {
  const rel = relative(parent, child);
  if (rel === "") return "";
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
};

/**
 * Chemins réels (hôte) des métadonnées git du workspace, à monter en lecture seule : `.git` (dossier ou fichier
 * pointeur d'un worktree), et pour un worktree le gitdir désigné et son commondir.
 */
export function gitMetadataPaths(ws: string): string[] {
  const dotgit = join(ws, ".git");
  const out = new Set<string>();
  const add = (p: string) => {
    try {
      out.add(realpathSync(p));
    } catch {
      /* cible absente : rien à protéger */
    }
  };
  let st;
  try {
    st = lstatSync(dotgit);
  } catch {
    return [];
  }
  if (st.isDirectory() || st.isSymbolicLink()) add(dotgit);
  else if (st.isFile()) {
    out.add(dotgit);
    let gitdir: string | undefined;
    try {
      gitdir = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(dotgit, "utf8").slice(0, 4096))?.[1];
    } catch {
      gitdir = undefined;
    }
    if (gitdir) {
      const gd = resolve(ws, gitdir);
      add(gd);
      try {
        const cd = readFileSync(join(gd, "commondir"), "utf8").trim();
        if (cd) add(resolve(gd, cd));
      } catch {
        /* pas de commondir (dépôt séparé via --separate-git-dir) */
      }
    }
  }
  return [...out];
}

const SYSTEM_RO = [
  "/etc/alternatives",
  "/etc/ld.so.cache",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/localtime",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
];

export type BwrapBuild = { args: string[]; masked: string[]; gitReadOnly: string[] };

/** `seccompFd` : descripteur (vu par bwrap) contenant le programme BPF, ex. 3. */
export function buildBwrapArgs(
  profile: SandboxProfile,
  opts: { seccompFd?: number; egressSocketPath?: string } = {},
): BwrapBuild {
  const ws = realpathSync(profile.workspace);
  if (profile.network.mode === "proxy" && !opts.egressSocketPath)
    throw new Error("proxy network requires egressSocketPath");

  const a: string[] = [
    "--unshare-all", // user, pid, net, ipc, uts, cgroup : jamais de partage du réseau de l'hôte
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--setenv",
    "PATH",
    "/opt/nexus/bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/home/agent",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--symlink",
    "usr/sbin",
    "/sbin",
  ];
  for (const etc of SYSTEM_RO) if (existsSync(etc)) a.push("--ro-bind", etc, etc);
  a.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--dir",
    "/home/agent",
    "--dir",
    "/opt/nexus/bin",
  );
  a.push("--bind", ws, WORKSPACE_MOUNT);

  const masked = findMaskedPaths(ws, { protectEnvFiles: profile.protectEnvFiles });
  for (const p of masked) {
    const real = realpathSync(p);
    if (!real.startsWith(`${ws}/`)) throw new Error(`mask target outside workspace: ${p}`);
    const target = WORKSPACE_MOUNT + real.slice(ws.length);
    if (lstatSync(real).isDirectory()) a.push("--tmpfs", target, "--remount-ro", target);
    else a.push("--ro-bind", "/dev/null", target);
  }
  for (const [src, dest] of profile.readOnlyBinds) a.push("--ro-bind", realpathSync(src), dest);
  const writable = (profile.writableBinds ?? []).map(([src, dest]) => [realpathSync(src), dest] as const);
  for (const [src, dest] of writable) a.push("--bind", src, dest);
  // Métadonnées git en lecture seule partout où elles sont visibles en écriture (workspace, montages inscriptibles).
  // Montées APRÈS les montages inscriptibles pour les recouvrir. Un point de montage ne peut être ni supprimé ni renommé.
  const gitReadOnly: string[] = [];
  for (const p of gitMetadataPaths(ws)) {
    for (const [src, dest] of [[ws, WORKSPACE_MOUNT] as const, ...writable]) {
      const rel = insideOrEqual(p, src);
      if (rel === null) continue;
      const target = rel === "" ? dest : `${dest}/${rel}`;
      a.push("--ro-bind", p, target);
      gitReadOnly.push(target);
    }
  }
  if (profile.network.mode === "proxy") {
    a.push("--dir", "/run/nexus", "--bind", realpathSync(opts.egressSocketPath!), EGRESS_SOCKET_MOUNT);
    a.push("--setenv", "NEXUS_EGRESS_SOCKET", EGRESS_SOCKET_MOUNT);
  }
  for (const [k, v] of Object.entries(profile.env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`invalid env name: ${k}`);
    a.push("--setenv", k, v);
  }
  if (opts.seccompFd !== undefined) a.push("--seccomp", String(opts.seccompFd));
  // La racine tmpfs de bwrap est inscriptible : remontée en lecture seule (ADR-001 constat 1).
  a.push("--remount-ro", "/", "--chdir", WORKSPACE_MOUNT);
  return { args: a, masked, gitReadOnly };
}
