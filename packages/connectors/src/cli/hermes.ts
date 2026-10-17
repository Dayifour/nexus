// Intégration propre à Hermes Agent (Nous Research), vérifiée dans les sources de Hermes 0.18 :
// - serveurs MCP lus dans `mcp_servers` de `$HERMES_HOME/config.yaml` (tools/mcp_tool.py). La découverte n'a lieu
//   que si le fichier BRUT de l'utilisateur en déclare (hermes_cli/mcp_startup.py) : le serveur de Nexus passe donc
//   par un HERMES_HOME de remplacement (liens vers chaque entrée du vrai dossier, sauf config.yaml qui est une copie
//   complétée) — connexion, sessions, mémoire et historique restent ceux de l'utilisateur ;
// - « portée gérée » (`HERMES_MANAGED_DIR`, hermes_cli/managed_scope.py) : `config.yaml` et `.env` dont les valeurs
//   l'emportent sur celles de l'utilisateur (hooks d'état, racine d'écriture de la lecture seule) ;
// - écriture de fichiers refusée hors de `HERMES_WRITE_SAFE_ROOT` (agent/file_safety.py, appliqué par write_file,
//   patch et la suppression) ;
// - hooks de commande (`hooks:`, agent/shell_hooks.py) exécutés sans shell, environnement hérité ;
// - `session_id: <id>` écrit sur stderr à la fin d'une exécution `chat -Q` (cli.py), repris par `--resume <id>`.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentTaskRequest } from "@nexus/contracts";

/**
 * Jeux d'outils en lecture seule (`-t`) : lecture et recherche de fichiers, web, vision, liste de tâches, historique
 * des sessions. Absents : terminal/process, execute_code, delegate_task (sous-agents), navigateur, cron, mémoire et
 * compétences (qui modifient l'état de l'utilisateur), clarify (personne ne répond en exécution non interactive).
 * Le jeu « file » contient aussi write_file et patch : ils sont neutralisés par `HERMES_WRITE_SAFE_ROOT`.
 */
export const HERMES_READ_ONLY_TOOLSETS = ["file", "web", "vision", "todo", "session_search"] as const;
/** Racine d'écriture « sûre » qui n'admet aucun fichier : tout write_file / patch / suppression est refusé. */
export const HERMES_NO_WRITE_ROOT = "/dev/null";
/** Portée gérée de l'administrateur : Nexus ne la masque jamais par la sienne. */
export const HERMES_SYSTEM_MANAGED_DIR = "/etc/hermes";

/** Identifiant de session rapporté par `hermes chat -Q` sur stderr. */
export function parseHermesSessionId(line: string): string | undefined {
  const m = /^\s*session_id:\s*([A-Za-z0-9._:-]{1,200})\s*$/.exec(line);
  return m?.[1];
}

/** Dossier de configuration de l'utilisateur (HERMES_HOME, sinon ~/.hermes, profil actif compris). */
export function hermesUserHome(home: string, env: Record<string, string | undefined> = {}): string {
  const base = env.HERMES_HOME?.trim() || join(home, ".hermes");
  if (basename(dirname(base)) === "profiles") return base;
  try {
    const profile = readFileSync(join(base, "active_profile"), "utf8").trim();
    if (profile && profile !== "default" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) {
      const dir = join(base, "profiles", profile);
      if (existsSync(dir)) return dir;
    }
  } catch {
    /* pas de profil actif */
  }
  return base;
}

/** La configuration de l'utilisateur déclare-t-elle ses propres hooks ? (détection prudente, sans analyse YAML) */
export function hermesUserHasHooks(userHome: string): boolean {
  try {
    return /^hooks\s*:/m.test(readFileSync(join(userHome, "config.yaml"), "utf8"));
  } catch {
    return false;
  }
}

/** États d'un agent interactif écrits par les hooks dans `$NEXUS_HOOK_FILE`. */
const HOOK_STATUS: Record<string, "working" | "idle" | "needs_input"> = {
  pre_llm_call: "working",
  post_tool_call: "working",
  post_approval_response: "working",
  pre_approval_request: "needs_input",
  // Émis à la fin de chaque tour (agent/turn_finalizer.py) : la main revient à l'utilisateur.
  on_session_end: "idle",
};

/**
 * Ajoute des serveurs MCP au texte YAML de la configuration de l'utilisateur, sans l'analyser : bloc `mcp_servers`
 * ajouté s'il n'existe pas, complété (même indentation que ses entrées) s'il existe, remplacé s'il est vide.
 * Chaque entrée est une table JSON (le JSON est du YAML valide). `undefined` si la forme n'est pas reconnue
 * (ex. table en ligne non vide) ou si un serveur du même nom existe déjà : la configuration n'est jamais devinée.
 */
export function injectHermesMcpServers(
  yaml: string,
  servers: NonNullable<AgentTaskRequest["mcpServers"]>,
): string | undefined {
  const entries = servers.map(
    (s) =>
      // ask_lead peut attendre la réponse du chef : délai d'outil de 5 minutes.
      `${s.name}: ${JSON.stringify({ command: s.command, args: s.args, env: s.env, timeout: 300, connect_timeout: 30 })}`,
  );
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => /^mcp_servers\s*:/.test(l));
  if (at < 0) {
    const head = yaml.replace(/\s*$/, "");
    return `${head ? `${head}\n` : ""}mcp_servers:\n${entries.map((e) => `  ${e}`).join("\n")}\n`;
  }
  const rest = lines[at]!.replace(/^mcp_servers\s*:/, "")
    .replace(/\s+#.*$/, "")
    .trim();
  let next = at + 1;
  while (next < lines.length && /^\s*(#.*)?$/.test(lines[next]!)) next++;
  const indent = next < lines.length ? /^([ ]+)\S/.exec(lines[next]!)?.[1] : undefined;
  if (rest === "" && indent) {
    for (const s of servers) {
      const re = new RegExp(`^${indent}["']?${s.name}["']?\\s*:`);
      if (lines.some((l) => re.test(l))) return undefined;
    }
    lines.splice(at + 1, 0, ...entries.map((e) => `${indent}${e}`));
    return lines.join("\n");
  }
  if (["", "{}", "null", "~"].includes(rest) && !indent) {
    lines.splice(at, 1, "mcp_servers:", ...entries.map((e) => `  ${e}`));
    return lines.join("\n");
  }
  return undefined;
}

export type HermesScopeOptions = {
  servers?: AgentTaskRequest["mcpServers"];
  readOnly?: boolean;
  /** Hooks d'état (sessions interactives) ; `autoAccept` : la configuration de l'utilisateur n'a pas de hooks. */
  statusHooks?: { autoAccept: boolean };
  /** Dossier privé (0700) où créer les fichiers de l'exécution ; par défaut, le dossier temporaire du système. */
  baseDir?: string;
  /** Dossier personnel et environnement de l'utilisateur (HERMES_HOME), pour retrouver sa configuration. */
  home?: string;
  env?: Record<string, string | undefined>;
  /** Portée gérée de l'administrateur (tests). */
  systemManagedDir?: string;
};

export type HermesScope = {
  /** Arguments à ajouter (jeux d'outils en lecture seule). */
  args: string[];
  /** Variables d'environnement du processus Hermes. */
  env: Record<string, string>;
  /** Dossier privé de l'exécution (supprimé par `cleanup`). */
  dir?: string;
  /** Vrai si le serveur MCP de Nexus a pu être ajouté (configuration de l'utilisateur de forme reconnue). */
  mcpInjected: boolean;
  /** Rapatrie dans le vrai dossier les entrées créées pendant l'exécution, puis supprime les fichiers temporaires. */
  cleanup: () => void;
};

/**
 * Prépare une exécution de Hermes : serveur MCP de l'équipe, lecture seule réelle et hooks d'état, sans modifier la
 * configuration de l'utilisateur. Les fichiers générés (dont le jeton du bus) sont en 0600 dans un dossier 0700.
 * La lecture seule ne dépend d'aucun fichier : `-t` (argv) et `HERMES_WRITE_SAFE_ROOT` (environnement ; aussi dans le
 * `.env` géré, qui l'emporte sur celui de l'utilisateur) suffisent.
 */
export function hermesScope(o: HermesScopeOptions): HermesScope | undefined {
  const servers = o.servers ?? [];
  if (!servers.length && !o.readOnly && !o.statusHooks) return undefined;
  const env: Record<string, string> = o.readOnly ? { HERMES_WRITE_SAFE_ROOT: HERMES_NO_WRITE_ROOT } : {};
  if (o.baseDir) mkdirSync(o.baseDir, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(o.baseDir ?? tmpdir(), "hermes-"));
  const cleanups: Array<() => void> = [];

  // Serveur MCP : HERMES_HOME de remplacement `<racine>/profiles/<nom>` (Hermes fait alors confiance à HERMES_HOME et
  // ne suit pas `active_profile`).
  let mcpInjected = servers.length === 0;
  if (servers.length) {
    const real = hermesUserHome(o.home ?? process.env.HOME ?? "", o.env);
    let text = "";
    try {
      text = readFileSync(join(real, "config.yaml"), "utf8");
    } catch {
      /* pas encore de configuration */
    }
    const config = injectHermesMcpServers(text, servers);
    if (config !== undefined) {
      const home = join(root, "profiles", "nexus");
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const linked = new Set<string>(["config.yaml"]);
      if (existsSync(real))
        for (const name of readdirSync(real)) {
          if (name === "config.yaml") continue;
          symlinkSync(join(real, name), join(home, name));
          linked.add(name);
        }
      writeFileSync(join(home, "config.yaml"), config, { mode: 0o600 });
      env.HERMES_HOME = home;
      mcpInjected = true;
      // Entrées créées par Hermes pendant l'exécution (ex. premier `state.db`) : déplacées dans le vrai dossier.
      cleanups.push(() => {
        if (!existsSync(real)) return;
        for (const name of readdirSync(home)) {
          if (linked.has(name) || existsSync(join(real, name))) continue;
          const from = join(home, name);
          if (lstatSync(from).isSymbolicLink()) continue;
          try {
            renameSync(from, join(real, name));
          } catch {
            cpSync(from, join(real, name), { recursive: true, errorOnExist: false, force: false });
          }
        }
      });
    }
  }

  // `HERMES_MANAGED_DIR` remplace `/etc/hermes` : jamais quand l'administrateur en a défini une.
  if ((o.readOnly || o.statusHooks) && !existsSync(o.systemManagedDir ?? HERMES_SYSTEM_MANAGED_DIR)) {
    const managed = join(root, "managed");
    mkdirSync(managed, { mode: 0o700 });
    const config: Record<string, unknown> = {};
    if (o.statusHooks) {
      config.hooks = Object.fromEntries(
        Object.entries(HOOK_STATUS).map(([event, status]) => [
          event,
          [{ command: `/bin/sh -c 'printf "${status}\\n" >> "$NEXUS_HOOK_FILE"'`, timeout: 5 }],
        ]),
      );
      // Sans accord, Hermes demanderait la permission pour chaque hook. Jamais quand l'utilisateur a ses propres
      // hooks : l'accord automatique vaudrait aussi pour eux (Hermes posera alors la question dans le terminal).
      if (o.statusHooks.autoAccept) config.hooks_auto_accept = true;
    }
    writeFileSync(join(managed, "config.yaml"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
    writeFileSync(join(managed, ".env"), o.readOnly ? `HERMES_WRITE_SAFE_ROOT=${HERMES_NO_WRITE_ROOT}\n` : "", {
      mode: 0o600,
    });
    env.HERMES_MANAGED_DIR = managed;
  }

  return {
    args: o.readOnly
      ? ["-t", [...HERMES_READ_ONLY_TOOLSETS, ...(mcpInjected ? servers.map((s) => s.name) : [])].join(",")]
      : [],
    env,
    dir: root,
    mcpInjected,
    cleanup: () => {
      for (const c of cleanups) {
        try {
          c();
        } catch {
          /* rapatriement au mieux */
        }
      }
      // Les liens sont supprimés, jamais suivis.
      rmSync(root, { recursive: true, force: true });
    },
  };
}
