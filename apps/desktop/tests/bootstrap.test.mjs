import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

const readAppFile = (relativePath) => readFile(join(appDirectory, relativePath), "utf8");

test("desktop bootstrap declares Forge and TypeScript commands", async () => {
  const manifest = JSON.parse(await readAppFile("package.json"));

  assert.equal(manifest.name, "@nexus/desktop");
  assert.equal(manifest.private, true);
  assert.equal(manifest.scripts.start, "electron-forge start");
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit");
  assert.equal(manifest.scripts.test, 'node --test "tests/**/*.test.mjs" "tests/**/*.test.mts"');
});

test("main process creates a sandboxed renderer without Node integration", async () => {
  const source = await readAppFile("src/main.ts");

  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.doesNotMatch(source, /openDevTools\(/);
});

test("renderer : point d'entrée React, CSP stricte sans eval ni origine distante", async () => {
  const html = await readAppFile("index.html");
  const source = await readAppFile("src/renderer.ts");

  assert.match(html, /<title>Nexus AI<\/title>/);
  assert.match(source, /mount\(root\)/);
  const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /https?:\/\/(?!localhost)/, "aucune origine distante autorisée");
  // Production : pas même localhost (les origines du serveur de dev sont ajoutées par Vite en `serve` uniquement).
  assert.doesNotMatch(csp, /localhost/, "CSP de production sans origine localhost");
  assert.match(csp, /connect-src 'self';/);
  const viteConfig = await readAppFile("vite.renderer.config.mts");
  assert.match(viteConfig, /apply: "serve",\s*transformIndexHtml\(html\)/);
});
