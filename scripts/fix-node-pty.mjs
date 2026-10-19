#!/usr/bin/env node
// node-pty publie `spawn-helper` (macOS, Linux) sans bit d'exécution dans certaines archives : tout PTY échoue alors
// avec « posix_spawnp failed ». Lancé après l'installation, avant l'empaquetage qui copie node_modules tel quel.
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pty = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "node-pty");
if (process.platform !== "win32" && existsSync(pty)) {
  const prebuilds = join(pty, "prebuilds");
  const candidates = [
    join(pty, "build", "Release", "spawn-helper"),
    ...(existsSync(prebuilds) ? readdirSync(prebuilds).map((d) => join(prebuilds, d, "spawn-helper")) : []),
  ];
  for (const file of candidates) {
    if (existsSync(file) && (statSync(file).mode & 0o111) === 0) chmodSync(file, 0o755);
  }
}
