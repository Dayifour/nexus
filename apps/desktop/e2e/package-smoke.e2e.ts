// T-024 — smoke test du paquet Linux RÉEL (.deb) : extraction sans installation, lancement de l'exécutable empaqueté
// (fuses actives, asar, binaire libsql dépaqueté), pilotage du renderer via le protocole de débogage Chromium.
// Prérequis : `npm run make:linux` (produit out/make/deb/x64/*.deb) ; exécuter sous xvfb-run.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

// Hérité d'un hôte Electron (terminal de VS Code…) : ferait démarrer l'application testée comme simple Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const appDir = fileURLToPath(new URL("..", import.meta.url));
const debDir = join(appDir, "out", "make", "deb", "x64");
const deb = existsSync(debDir) ? readdirSync(debDir).find((f) => f.endsWith(".deb")) : undefined;

const work = mkdtempSync(join(tmpdir(), "nexus-smoke-"));
let child: ChildProcess | undefined;
let browser: Browser | undefined;
after(async () => {
  await browser?.close().catch(() => {});
  child?.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  const root = join(work, "pkg");
  execFileSync("dpkg-deb", ["-x", join(debDir, deb!), root]);
  const bin = join(root, "usr", "lib", "nexus-ai", "nexus-ai");
  assert.ok(existsSync(bin), "exécutable présent dans le paquet");
  const port = 9300 + Math.floor(Math.random() * 500);
  child = spawn(bin, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, NEXUS_USER_DATA_DIR: join(work, "userdata") },
    stdio: "ignore",
  });
  const end = Date.now() + 30_000;
  for (;;) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      if (Date.now() > end) throw new Error("l'application empaquetée n'a pas exposé son renderer");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  for (;;) {
    const page = browser.contexts().flatMap((c) => c.pages())[0];
    if (page) {
      await page.waitForFunction(() => "nexus" in window, undefined, { timeout: 20_000 });
      return page;
    }
    if (Date.now() > end) throw new Error("aucune fenêtre");
    await new Promise((r) => setTimeout(r, 300));
  }
}

test(
  "paquet .deb : démarre, IPC fonctionnel, base migrée, renderer sans Node",
  { skip: !deb && "paquet absent (npm run make:linux)" },
  async () => {
    const page = await launch();
    const info = await page.evaluate(() => (window as any).nexus.invoke("app.info", {}));
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.match(info.data.electron, /^44\./);
    const caps = await page.evaluate(() => (window as any).nexus.invoke("app.capabilities", {}));
    assert.equal(caps.ok, true);
    const globals = await page.evaluate(() => typeof (globalThis as Record<string, unknown>).require);
    assert.equal(globals, "undefined");
    // Persistance (Prisma + binaire libsql N-API chargé depuis app.asar.unpacked).
    const projectDir = join(work, "projet");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    const created = await page.evaluate(
      (p) => (window as any).nexus.invoke("projects.create", { name: "Smoke", rootPath: p }),
      projectDir,
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(existsSync(join(work, "userdata", "nexus.db")));
    const title = await page.title();
    assert.equal(title, "Nexus AI");
  },
);
