// E2E du thème (Clair / Sombre / Système) sur le build réel (.vite/build), via Playwright (_electron) :
// - chaque thème s'applique au renderer (data-theme, fond), au thème natif (nativeTheme.themeSource) et à la fenêtre ;
// - en sombre, aucun grand élément visible n'a de fond blanc (couleur en dur oubliée) ;
// - au redémarrage, la fenêtre naît directement dans le bon thème (pas d'éclair du mauvais thème).
// Prérequis : `electron-forge package` ; exécuter sous un serveur X (xvfb-run en CI).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "nexus-theme-e2e-"));
let app: ElectronApplication | undefined;

after(async () => {
  await app?.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  app = await electron.launch({
    // Interface en français (libellés de la palette), quelle que soit la langue du système.
    args: [appDir, "--lang=fr"],
    cwd: appDir,
    env: { ...process.env, NEXUS_USER_DATA_DIR: join(dataDir, "userdata") },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("heading", { level: 1 }).waitFor();
  return page;
}

async function setTheme(page: Page, id: "dark" | "light" | "system"): Promise<void> {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+Shift+P`);
  const input = page.getByPlaceholder("Tapez une commande…");
  await input.waitFor();
  await input.fill(`theme.${id}`);
  await page.locator(`[data-command="theme.${id}"]`).click();
  // Le réglage passe par le main (settings.set) qui met à jour nativeTheme : attente de la propagation.
  await app!.evaluate(async ({ nativeTheme }, want) => {
    for (let i = 0; i < 50 && nativeTheme.themeSource !== want; i++) await new Promise((r) => setTimeout(r, 100));
  }, id);
}

/** Luminance relative (0 = noir, 1 = blanc) du fond calculé d'un élément. */
async function bodyLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) ?? ["0", "0", "0"];
    const [r, g, b] = m.slice(0, 3).map((x) => {
      const c = Number(x) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  });
}

/** Grands éléments visibles au fond (quasi) blanc et opaque : interdits en thème sombre. */
async function whiteSurfaces(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    // Transitions de couleur encore en cours après la bascule (ex. `.btn`) : on mesure l'état final, pas un entre-deux.
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const box = el.getBoundingClientRect();
      if (box.width < 16 || box.height < 16) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      const v = cs.backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (!v) continue;
      const [r = 0, g = 0, b = 0, a = 1] = v;
      if (a > 0.5 && r > 200 && g > 200 && b > 200) bad.push(`${el.tagName.toLowerCase()}.${el.className}`);
    }
    return bad;
  });
}

test("thèmes clair, sombre et système : renderer, thème natif et fenêtre synchronisés", async () => {
  const page = await launch();

  await setTheme(page, "dark");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  assert.equal(await app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource), "dark");
  assert.ok((await bodyLuminance(page)) < 0.05, "fond sombre en thème sombre");
  assert.deepEqual(await whiteSurfaces(page), [], "aucun fond blanc en thème sombre");

  await setTheme(page, "light");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  assert.equal(await app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource), "light");
  assert.ok((await bodyLuminance(page)) > 0.8, "fond clair en thème clair");

  // Système : le renderer suit prefers-color-scheme, lui-même piloté par le thème natif.
  await setTheme(page, "system");
  assert.equal(await app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource), "system");
  const osDark = await app!.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await page.waitForFunction((want) => document.documentElement.dataset.theme === want, osDark ? "dark" : "light", {
    timeout: 5_000,
  });

  await setTheme(page, "light");
  await app!.close();
  app = undefined;

  // Redémarrage : la fenêtre est créée avec le fond du thème choisi, et <html> porte ce thème dès le chargement.
  const again = await launch();
  const bg = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor());
  assert.equal(bg?.toLowerCase(), "#f5f6f8");
  assert.equal(await again.evaluate(() => document.documentElement.dataset.theme), "light");
  await setTheme(again, "dark");
  assert.deepEqual(await whiteSurfaces(again), [], "aucun fond blanc en thème sombre après bascule");
});
