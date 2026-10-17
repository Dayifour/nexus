import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_EXTERNALS } from "./vite.main.config.mts";

const hasRpmbuild = ["/usr/bin/rpmbuild", "/usr/local/bin/rpmbuild"].some((p) => existsSync(p));
const rootNodeModules = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules");

/**
 * Fermeture des dépendances des modules exclus du bundle Vite (dépendances + optionnelles installées,
 * ce qui inclut le binaire libsql de la plateforme courante).
 */
function runtimeClosure(roots: string[]): string[] {
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    const manifest = join(rootNodeModules, name, "package.json");
    if (!existsSync(manifest)) return; // dépendance optionnelle d'une autre plateforme
    seen.add(name);
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep);
  };
  roots.forEach(visit);
  return [...seen].sort();
}

/** Modules de construction seulement (en-têtes C++, types) : jamais chargés à l'exécution. */
const BUILD_ONLY = new Set(["node-addon-api"]);

/**
 * Filtre de copie de la fermeture d'exécution : on retire ce qui n'est jamais chargé par l'application empaquetée
 * (symboles .pdb, sources C++ de node-pty, binaires d'autres plateformes, types, cartes de sources, et compilateurs de
 * requêtes Prisma des autres bases : seul le compilateur « fast » SQLite sert, via l'adaptateur libsql).
 */
function keepRuntimeFile(name: string, rel: string, platform: string, arch: string): boolean {
  const p = rel.split(sep).join("/");
  if (p === "") return true;
  if (/\.(pdb|map|d\.ts|d\.mts|d\.cts)$/.test(p)) return false;
  if (name === "node-pty") {
    if (/^(deps|src|third_party|scripts|typings|node-addon-api)(\/|$)/.test(p) || p.endsWith(".test.js")) return false;
    if (p.startsWith("build/") && !p.startsWith("build/Release") && p !== "build") return false;
    if (p.startsWith("build/Release/") && !/\.node$|spawn-helper$/.test(p)) return false;
    const prebuild = /^prebuilds\/([^/]+)/.exec(p)?.[1];
    if (prebuild && prebuild !== `${platform}-${arch}`) return false;
  }
  if (name === "@prisma/client" && p.startsWith("runtime/")) {
    if (/query_compiler_small_bg\./.test(p)) return false;
    if (/query_compiler_fast_bg\.(?!sqlite\.)/.test(p)) return false;
  }
  return true;
}

const config: ForgeConfig = {
  // Nom d'exécutable explicite : le nom npm « @nexus/desktop » n'est pas un nom de binaire/paquet Debian valide.
  // node-pty lance des binaires auxiliaires (spawn-helper sur macOS/Linux, conpty/winpty-agent sous Windows) : ils
  // doivent exister sur le disque, donc hors de l'archive asar (le plugin AutoUnpackNatives y ajoute les *.node).
  packagerConfig: { asar: { unpack: "**/node_modules/node-pty/**" }, executableName: "nexus-ai" },
  rebuildConfig: {},
  hooks: {
    // Le plugin Vite n'embarque pas node_modules : on copie uniquement les modules chargés à l'exécution.
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => {
      for (const name of runtimeClosure(RUNTIME_EXTERNALS)) {
        if (BUILD_ONLY.has(name) || name.startsWith("@types/")) continue;
        const from = join(rootNodeModules, name);
        cpSync(from, join(buildPath, "node_modules", name), {
          recursive: true,
          dereference: true,
          filter: (src) => keepRuntimeFile(name, relative(from, src), platform, arch),
        });
      }
    },
  },
  makers: [
    // Squirrel dérive l'identifiant NuGet du nom npm « @nexus/desktop » : « @ » et « / » y sont invalides et font
    // échouer l'installeur Windows. Identifiant et auteurs explicites.
    new MakerSquirrel({ name: "nexus_ai", authors: "Dayifour", description: "Atelier local pour agents de code" }),
    new MakerZIP({}, ["darwin", "linux", "win32"]),
    new MakerDeb({
      options: {
        name: "nexus-ai",
        bin: "nexus-ai",
        productName: "Nexus AI",
        genericName: "Atelier d'agents de code",
        categories: ["Development"],
        // À compléter par le propriétaire avant toute publication.
        maintainer: "Dayifour <dayifour@users.noreply.github.com>",
        homepage: "https://github.com/Dayifour/nexus",
      },
    }),
    // .rpm seulement si `rpmbuild` est présent (installé par le workflow de publication ; absent en local).
    ...(hasRpmbuild
      ? [
          new MakerRpm({
            options: {
              name: "nexus-ai",
              bin: "nexus-ai",
              productName: "Nexus AI",
              homepage: "https://github.com/Dayifour/nexus",
              license: "Apache-2.0",
              categories: ["Development"],
            },
          }),
        ]
      : []),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.mts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.mts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.mts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
