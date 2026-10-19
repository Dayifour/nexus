// T-003 — E2E de la frontière de sécurité Electron, sur le build réel (.vite/build) lancé par Playwright.
// Prérequis : `electron-forge package` (produit .vite/) ; exécuter sous un serveur X (xvfb-run en CI).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

// Hérité d'un hôte Electron (terminal de VS Code…) : ferait démarrer l'application testée comme simple Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const appDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "nexus-e2e-"));
const projectDir = join(dataDir, "demo-project");
mkdirSync(join(projectDir, ".git"), { recursive: true });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // Interface en français (libellés vérifiés ci-dessous), quelle que soit la langue du système du runner.
    args: [appDir, "--lang=fr"],
    cwd: appDir,
    env: { ...process.env, NEXUS_USER_DATA_DIR: join(dataDir, "userdata") },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => "nexus" in window);
  return { app, page };
}

let app: ElectronApplication;
let page: Page;
before(async () => ({ app, page } = await launch()));
after(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("renderer sans accès Node : require, process, module, Buffer absents (NFR-003)", async () => {
  const globals = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    module: typeof (globalThis as Record<string, unknown>).module,
    buffer: typeof (globalThis as Record<string, unknown>).Buffer,
  }));
  assert.deepEqual(globals, { require: "undefined", process: "undefined", module: "undefined", buffer: "undefined" });
});

test("pont exposé minimal et gelé : invoke, onEvent, pathForFile ; pas d'ipcRenderer", async () => {
  const shape = await page.evaluate(() => {
    const api = (window as unknown as { nexus: Record<string, unknown> }).nexus;
    return {
      keys: Object.keys(api).sort(),
      frozen: Object.isFrozen(api),
      ipc: typeof (window as unknown as Record<string, unknown>).ipcRenderer,
    };
  });
  assert.deepEqual(shape, { keys: ["invoke", "onEvent", "pathForFile"], frozen: true, ipc: "undefined" });
});

test("IPC valide : app.info renvoie des métadonnées validées", async () => {
  const r = await page.evaluate(() => (window as any).nexus.invoke("app.info", {}));
  assert.equal(r.ok, true);
  assert.match(r.data.contractsVersion, /^1\./);
  assert.match(r.data.electron, /^44\./);
});

test("IPC invalide refusé : canal inconnu, canal piégé, charge utile invalide ou excédentaire", async () => {
  const results = await page.evaluate(async () => {
    const n = (window as any).nexus;
    return {
      unknown: await n.invoke("projects.delete", {}),
      proto: await n.invoke("__proto__", {}),
      badPayload: await n.invoke("projects.create", { name: "x", rootPath: "relatif" }),
      extra: await n.invoke("app.info", { injected: true }),
      notObject: await n.invoke("app.info", "x"),
    };
  });
  assert.equal(results.unknown.error.code, "unknown_channel");
  assert.equal(results.proto.error.code, "unknown_channel");
  assert.equal(results.badPayload.error.code, "invalid_request");
  assert.equal(results.extra.error.code, "invalid_request");
  assert.equal(results.notObject.error.code, "invalid_request");
});

test("CSP active dans la page : script inline et chaîne évaluée (setTimeout) bloqués, violations signalées", async () => {
  // page.evaluate passe par le protocole de débogage, exempté de CSP : les sondes doivent s'exécuter DANS la page.
  const r = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective));
    const s = document.createElement("script");
    s.textContent = "window.__injected = true";
    document.head.appendChild(s);
    // Chaîne passée à setTimeout = évaluation dynamique, soumise à script-src sans 'unsafe-eval'.
    (setTimeout as unknown as (code: string, ms: number) => void)("window.__evaluated = true", 0);
    await new Promise((res) => setTimeout(res, 200));
    const w = window as unknown as { __injected?: boolean; __evaluated?: boolean };
    return { injected: w.__injected === true, evaluated: w.__evaluated === true, violations };
  });
  assert.equal(r.injected, false);
  assert.equal(r.evaluated, false);
  assert.ok(r.violations.length >= 2, `violations CSP attendues, reçues: ${JSON.stringify(r.violations)}`);
});

test("CSP de l'application empaquetée : aucune connexion autorisée hors de l'application (pas de localhost)", async () => {
  const csp = await page.evaluate(
    () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
  );
  assert.match(csp, /connect-src 'self';/);
  assert.doesNotMatch(csp, /localhost/);
});

test("navigation externe et ouverture de fenêtre bloquées", async () => {
  const before = page.url();
  const opened = await page.evaluate(() => window.open("https://example.com") === null);
  assert.equal(opened, true);
  await page.evaluate(() => {
    window.location.href = "https://example.com/";
  });
  await page.waitForTimeout(500);
  assert.equal(page.url(), before);
  assert.equal(app.windows().length, 1);
});

test("permissions refusées par défaut (notifications, micro)", async () => {
  const r = await page.evaluate(async () => {
    const notif = await Notification.requestPermission();
    let media = "granted";
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      media = (e as Error).name;
    }
    return { notif, media };
  });
  assert.equal(r.notif, "denied");
  assert.notEqual(r.media, "granted");
});

test("projet créé via IPC puis retrouvé après redémarrage de l'application (UC-05)", async () => {
  const created = await page.evaluate(
    (root) => (window as any).nexus.invoke("projects.create", { name: "Démo", rootPath: root }),
    projectDir,
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.isGitRepository, true);
  await app.close();
  ({ app, page } = await launch());
  const listed = await page.evaluate(() => (window as any).nexus.invoke("projects.list", {}));
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.data.map((p: { name: string }) => p.name),
    ["Démo"],
  );
  const dup = await page.evaluate(
    (root) => (window as any).nexus.invoke("projects.create", { name: "Bis", rootPath: root }),
    projectDir,
  );
  assert.equal(dup.error.code, "conflict");
});
