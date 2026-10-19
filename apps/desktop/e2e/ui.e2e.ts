// E2E de l'interface (plan de travail façon IDE) sur le build réel (.vite/build), via Playwright (_electron).
// Les canaux encore en cours d'implémentation côté main peuvent répondre `unavailable` : chaque assertion accepte
// alors l'état « indisponible » propre affiché par l'interface, jamais un plantage.
// Prérequis : `electron-forge package` (ou build Vite) ; exécuter sous un serveur X (xvfb-run en CI).
// NEXUS_E2E_SCREENSHOTS=<dossier> enregistre des captures d'écran du parcours.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

// Hérité d'un hôte Electron (terminal de VS Code…) : ferait démarrer l'application testée comme simple Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const appDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "nexus-ui-e2e-"));
const projectDir = join(dataDir, "stock-app");
const shots = process.env.NEXUS_E2E_SCREENSHOTS;

mkdirSync(join(projectDir, "src", "utils"), { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# Stock app\n\nGestion de stock.\n");
writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "stock-app", version: "1.0.0" }, null, 2));
writeFileSync(join(projectDir, "src", "index.ts"), 'export const hello = "world";\n');
writeFileSync(join(projectDir, "src", "utils", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
writeFileSync(join(projectDir, ".npmrc"), "//registry.example/:_authToken=not-a-real-token\n");
try {
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
} catch {
  mkdirSync(join(projectDir, ".git"), { recursive: true });
}

let app: ElectronApplication;
let page: Page;
const pageErrors: string[] = [];
const cspViolations: string[] = [];
const consoleErrors: string[] = [];

async function shot(name: string): Promise<void> {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

const mod = process.platform === "darwin" ? "Meta" : "Control";

/** Identifiants des commandes visibles dans la palette (attribut data-command). */
async function paletteCommandIds(): Promise<string[]> {
  await page.keyboard.press(`${mod}+Shift+P`);
  await page.getByPlaceholder("Tapez une commande…").waitFor();
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-command]")].map((e) => e.dataset.command ?? ""),
  );
  await page.keyboard.press("Escape");
  return ids.filter(Boolean);
}

/** Exécute une commande depuis la palette, puis referme toute boîte ouverte. */
async function runFromPalette(id: string): Promise<void> {
  // Une boîte restée ouverte (commande précédente lente à s'afficher) intercepterait le clic suivant.
  await closeDialogs();
  await page.keyboard.press(`${mod}+Shift+P`);
  const input = page.getByPlaceholder("Tapez une commande…");
  await input.waitFor();
  await input.fill(id);
  await page.locator(`[data-command="${id}"]`).click();
  await input.waitFor({ state: "hidden" });
  await settle();
  await closeDialogs();
}

/**
 * La palette lance la commande dans un setTimeout(0) après sa fermeture : on laisse ce minuteur partir puis React
 * peindre (deux images) avant de compter les boîtes ouvertes. Sans cela, une machine lente (CI) compte zéro boîte,
 * puis la boîte apparaît et bloque la commande suivante.
 */
async function settle(): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 50),
      ),
  );
}

/**
 * Referme les boîtes de dialogue ouvertes (Échap), en attendant que chacune ait réellement disparu. Une boîte qui
 * s'affiche en retard est rattrapée (deux comptages séparés par une attente), une boîte qui ignore Échap est fermée
 * par son bouton ; s'il en reste une, le test échoue ici en la nommant plutôt que plus loin sur un clic intercepté.
 */
async function closeDialogs(strict = true): Promise<void> {
  const dialogs = page.getByRole("dialog");
  for (let i = 0; i < 6; i++) {
    await settle();
    let count = await dialogs.count();
    if (count === 0) {
      await settle();
      count = await dialogs.count();
      if (count === 0) return;
    }
    await page.keyboard.press("Escape");
    await page
      .waitForFunction((n) => document.querySelectorAll('[role="dialog"]').length < n, count, { timeout: 3000 })
      .catch(() => {});
  }
  const close = page.locator('[role="dialog"] .modal-header button[aria-label="Fermer"]');
  for (let i = 0; i < 3 && (await close.count()) > 0; i++)
    await close
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});
  await dialogs
    .first()
    .waitFor({ state: "detached", timeout: 3000 })
    .catch(() => {});
  const left = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"]')].map((d) => d.textContent?.slice(0, 80) ?? ""),
  );
  if (strict) assert.deepEqual(left, [], `boîte restée ouverte malgré Échap : ${left.join(" | ")}`);
}

// Un test qui échoue en laissant une boîte de dialogue ouverte ne doit pas faire échouer tous les suivants.
beforeEach(async () => {
  if (!page) return;
  await closeDialogs(false);
});

/** Commandes à effets externes (boîtes natives, fermeture du projet, langue) : non exécutées en boucle. */
const SKIP_COMMANDS = new Set(["openFolder", "importArchive", "exportProject", "closeProject", "lang.toggle"]);

before(async () => {
  app = await electron.launch({
    // Interface en français (libellés vérifiés ci-dessous), quelle que soit la langue du système du runner.
    args: [appDir, "--lang=fr"],
    cwd: appDir,
    // NEXUS_E2E_PATH : PATH de l'application (ex. « /usr/bin:/bin » pour reproduire un runner CI sans agent installé).
    env: {
      ...process.env,
      NEXUS_USER_DATA_DIR: join(dataDir, "userdata"),
      ...(process.env.NEXUS_E2E_PATH && { PATH: process.env.NEXUS_E2E_PATH }),
    },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
    else if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.getByRole("heading", { level: 1 }).waitFor();
});

after(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("accueil : zone de dépôt, ouverture de dossier, récents", async () => {
  await page
    .getByRole("heading", { level: 1, name: "Décrivez un objectif. Une équipe d'agents IA s'en charge." })
    .waitFor();
  await page.getByTestId("orchestra-hero").getByRole("button", { name: "Lancer un orchestre" }).waitFor();
  const dropzone = page.getByTestId("dropzone");
  await dropzone.getByText("Glissez un dossier ici").waitFor();
  assert.equal(await page.getByRole("button", { name: "Ouvrir un dossier" }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "Saisir un chemin" }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: /Importer une archive/ }).isVisible(), true);
  await page.getByRole("heading", { name: "Récents" }).waitFor();
  await shot("01-accueil");
});

test("palette sans projet : chaque commande s'exécute sans erreur", async () => {
  const before = pageErrors.length;
  const ids = await paletteCommandIds();
  assert.ok(ids.length >= 5, `commandes sans projet : ${ids.join(", ")}`);
  for (const id of ids) {
    if (SKIP_COMMANDS.has(id)) continue;
    await runFromPalette(id);
    assert.equal(pageErrors.length, before, `erreur JS après « ${id} » : ${pageErrors.slice(before).join(" | ")}`);
  }
  await runFromPalette("theme.dark");
  await page.getByRole("heading", { level: 1 }).waitFor();
});

test("glisser-déposer simulé : survol mis en évidence, élément sans chemin refusé proprement", async () => {
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(["x"], "dossier-simule"));
    return d;
  });
  await page.dispatchEvent("[data-testid=dropzone]", "dragenter", { dataTransfer: dt });
  await page.getByText("Relâchez pour ouvrir le dossier").waitFor();
  await shot("02-glisser");
  await page.dispatchEvent("[data-testid=dropzone]", "drop", { dataTransfer: dt });
  // Fichier synthétique : pas de chemin réel (ou pas un dossier) -> message clair, aucun plantage.
  await page
    .getByText(/Impossible de lire le chemin|Déposez un dossier/)
    .first()
    .waitFor();
  await page.getByText("Glissez un dossier ici").waitFor();
});

test("ouverture d'un projet par son chemin : le plan de travail s'affiche", async () => {
  await page.getByRole("button", { name: "Saisir un chemin" }).click();
  const dialog = page.getByRole("dialog", { name: "Ouvrir un dossier" });
  await dialog.waitFor();
  await dialog.getByLabel("Chemin du dossier").fill(projectDir);
  await dialog.getByRole("button", { name: "Ouvrir", exact: true }).click();
  await page.getByTestId("workbench").waitFor();
  await page.getByRole("button", { name: "Menu du projet" }).getByText("stock-app").waitFor();
  await page.getByRole("navigation", { name: "Barre d'activité" }).waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Barre d'activité" }).getByRole("button").count(), 8);
  await page.getByRole("contentinfo", { name: "Barre d'état" }).waitFor();
});

test("explorateur : arbre paresseux, fichier protégé verrouillé, navigation clavier", async () => {
  const tree = page.getByTestId("explorer-tree");
  await tree.getByRole("treeitem", { name: "src" }).waitFor();
  await tree.getByRole("treeitem", { name: "README.md" }).waitFor();
  const npmrc = tree.getByRole("treeitem", { name: ".npmrc" });
  await npmrc.waitFor();
  assert.equal(await npmrc.getByLabel("Fichier protégé").count(), 1);

  await tree.getByRole("treeitem", { name: "src" }).click();
  await tree.getByRole("treeitem", { name: "index.ts" }).waitFor();
  assert.equal(await tree.getByRole("treeitem", { name: "src" }).getAttribute("aria-expanded"), "true");

  // Clavier : Origine puis flèche bas déplacent la sélection.
  await tree.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  const selected = await tree.locator("[aria-selected=true]").getAttribute("data-path");
  assert.ok(selected && selected !== "src", `sélection après flèche bas : ${selected}`);
  await shot("03-explorateur");
});

test("explorateur : création dans le dossier sélectionné (saisie en ligne), glisser-déposer, révéler", async () => {
  const tree = page.getByTestId("explorer-tree");
  const sidebar = page.getByTestId("sidebar");
  // Dossier sélectionné → « Nouveau fichier » crée l'élément DANS ce dossier, saisie en ligne à cet endroit.
  const src = tree.getByRole("treeitem", { name: "src", exact: true });
  await src.click();
  if ((await src.getAttribute("aria-expanded")) !== "true") await src.click();
  await tree.getByRole("treeitem", { name: "index.ts" }).waitFor();
  assert.equal(await src.getAttribute("aria-selected"), "true");
  await sidebar.getByRole("button", { name: "Nouveau fichier" }).click();
  const inline = tree.locator(".tree-row.is-editing input");
  await inline.waitFor();
  const srcRow = await tree.getByRole("treeitem", { name: "src", exact: true }).boundingBox();
  const inputRow = await tree.locator(".tree-row.is-editing").boundingBox();
  assert.ok(srcRow && inputRow && inputRow.y > srcRow.y, "saisie sous le dossier sélectionné");
  assert.ok(inputRow && srcRow && inputRow.x >= srcRow.x, "saisie indentée dans le dossier");
  await inline.fill("created.ts");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-path="src/created.ts"]') !== null);
  assert.ok(existsSync(join(projectDir, "src", "created.ts")));

  // Glisser-déposer : src/created.ts → src/utils (files.rename).
  await tree.getByRole("treeitem", { name: "utils" }).click();
  await tree.locator('[data-path="src/created.ts"]').dragTo(tree.getByRole("treeitem", { name: "utils" }));
  const moved = join(projectDir, "src", "utils", "created.ts");
  for (let i = 0; i < 40 && !existsSync(moved); i++) await page.waitForTimeout(100);
  assert.ok(existsSync(moved), "fichier déplacé par glisser-déposer");
  rmSync(moved, { force: true });

  // Tout replier : les dossiers dépliés se referment.
  await sidebar.getByRole("button", { name: "Tout replier" }).click();
  await tree.getByRole("treeitem", { name: "index.ts" }).waitFor({ state: "detached" });
  await src.click(); // redéplié pour la suite du parcours
  await tree.getByRole("treeitem", { name: "index.ts" }).waitFor();
  await shot("03b-explorateur-creation");
});

test("éditeur Monaco : aperçu en italique, modification, Ctrl+S enregistre sur le disque", async () => {
  await page.getByTestId("explorer-tree").getByRole("treeitem", { name: "index.ts" }).click();
  const editor = page.locator('[data-testid=editor-panel][data-path="src/index.ts"]');
  await editor.locator(".monaco-editor").waitFor({ timeout: 20_000 });
  const tab = page.locator(".tab-inner", { hasText: "index.ts" });
  await tab.waitFor();
  assert.match((await tab.getAttribute("class")) ?? "", /is-preview/);

  await editor.locator(".view-lines").click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type("\nexport const e2e = 42;");
  // La modification épingle l'onglet (plus en italique) et le marque modifié.
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll(".tab-inner")].find((n) => n.textContent?.includes("index.ts"));
    return el && !el.classList.contains("is-preview") && el.classList.contains("is-dirty");
  });
  await shot("04-editeur-modifie");
  // Fermer le projet avec un fichier modifié : question (Enregistrer / Ne pas enregistrer / Annuler) ; Annuler garde
  // le projet ouvert et la modification intacte.
  await page.keyboard.press(`${mod}+Shift+P`);
  const palette = page.getByPlaceholder("Tapez une commande…");
  await palette.fill("closeProject");
  await page.locator('[data-command="closeProject"]').click();
  const unsaved = page.getByRole("dialog", { name: "Enregistrer les modifications de « index.ts » ?" });
  await unsaved.waitFor();
  await unsaved.getByRole("button", { name: "Ne pas enregistrer" }).waitFor();
  await unsaved.getByRole("button", { name: "Annuler" }).click();
  await unsaved.waitFor({ state: "hidden" });
  await page.getByTestId("workbench-dock").waitFor();
  assert.match((await tab.getAttribute("class")) ?? "", /is-dirty/);
  await editor.locator(".view-lines").click();
  await page.keyboard.press(`${mod}+s`);
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll(".tab-inner")].find((n) => n.textContent?.includes("index.ts"));
    return el && !el.classList.contains("is-dirty");
  });
  assert.match(readFileSync(join(projectDir, "src", "index.ts"), "utf8"), /export const e2e = 42;/);
});

test("fichier protégé : jamais lu, affiché en lecture seule verrouillée", async () => {
  await page.getByTestId("explorer-tree").getByRole("treeitem", { name: ".npmrc" }).click();
  await page.getByText("Fichier protégé", { exact: true }).first().waitFor();
  await page.getByText(/Nexus ne l'affiche pas et ne le modifie pas/).waitFor();
  assert.equal(await page.getByText("not-a-real-token").count(), 0);
});

test("terminal : Ctrl+` ouvre un terminal réel (ou un état indisponible propre), puis le masque", async () => {
  await page.keyboard.press(`${mod}+Backquote`);
  const panel = page.getByTestId("terminal-panel").first();
  await panel.waitFor();
  const unavailable = page.getByTestId("terminal-unavailable");
  const xterm = panel.locator(".xterm");
  await xterm.waitFor();
  // terminal.create a répondu : PTY en cours (data-status) ou état indisponible propre.
  const running = panel.locator('[data-testid="terminal-pane"][data-status="running"]');
  await running.or(unavailable).first().waitFor({ timeout: 15_000 });
  if (await unavailable.isVisible()) {
    await unavailable.getByText("Terminal pas encore disponible").waitFor();
  } else {
    // Le shell exécute réellement la saisie : la commande crée un fichier vérifié sur le disque.
    const marker = join(dataDir, "terminal-e2e-marker");
    await panel.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(`echo nexus-e2e-$((40+2)) > '${marker}'`);
    await page.keyboard.press("Enter");
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(marker), "la commande tapée dans le terminal s'est exécutée");
    for (let i = 0; i < 50 && readFileSync(marker, "utf8").trim() === ""; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(readFileSync(marker, "utf8").trim(), "nexus-e2e-42");
  }
  await shot("05-terminal");
  await page.keyboard.press(`${mod}+Backquote`);
  await panel.waitFor({ state: "hidden" });
});

test("palette de commandes (Ctrl+Maj+P) et ouverture rapide (Ctrl+P)", async () => {
  await page.keyboard.press(`${mod}+Shift+P`);
  const input = page.getByPlaceholder("Tapez une commande…");
  await input.waitFor();
  await input.fill("terminal");
  await page.getByRole("option", { name: /Nouveau terminal/ }).waitFor();
  await shot("06-palette");
  await page.keyboard.press("Escape");
  await input.waitFor({ state: "hidden" });

  await page.keyboard.press(`${mod}+P`);
  const quick = page.getByPlaceholder(/Aller au fichier/);
  await quick.waitFor();
  await quick.fill("math");
  await page.getByRole("option", { name: /math\.ts/ }).waitFor({ timeout: 15_000 });
  await page.keyboard.press("Enter");
  await page
    .locator('[data-testid=editor-panel][data-path="src/utils/math.ts"] .monaco-editor')
    .waitFor({ timeout: 20_000 });
});

test("onglets : menu contextuel (scinder, agrandir…), puis scission à droite", async () => {
  await page.locator(".tab-inner", { hasText: "math.ts" }).click({ button: "right" });
  const split = page.getByText("Scinder à droite", { exact: true }).last();
  await split.waitFor();
  await shot("06b-menu-onglet");
  await split.click();
  // Deux vues du même fichier (même modèle) côte à côte.
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid=editor-panel][data-path="src/utils/math.ts"]').length === 2,
  );
  await page.keyboard.press(`${mod}+w`);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid=editor-panel][data-path="src/utils/math.ts"]').length === 1,
  );
});

test("Ctrl+W ferme l'onglet actif sans fermer la fenêtre", async () => {
  const mathEditor = page.locator('[data-testid=editor-panel][data-path="src/utils/math.ts"]');
  await mathEditor.locator(".view-lines").click();
  await page.keyboard.press(`${mod}+w`);
  await mathEditor.waitFor({ state: "detached" });
  assert.equal(app.windows().length, 1);
  await page.getByTestId("workbench").waitFor();
});

test("raccourcis : Ctrl+Maj+T rouvre, Ctrl+Tab change d'onglet, accord Ctrl+K Ctrl+W, page des raccourcis", async () => {
  const mathEditor = page.locator('[data-testid=editor-panel][data-path="src/utils/math.ts"]');
  // Ctrl+Maj+T : l'onglet fermé au test précédent revient ; la fenêtre reste ouverte.
  await page.keyboard.press(`${mod}+Shift+T`);
  await mathEditor.waitFor({ timeout: 15_000 });
  assert.equal(app.windows().length, 1);

  // Ctrl+Tab (Ctrl relâché) : onglet utilisé juste avant ; une seconde fois : retour sur math.ts.
  await page.keyboard.press("Control+Tab");
  await mathEditor.waitFor({ state: "detached" });
  await page.keyboard.press("Control+Tab");
  await mathEditor.waitFor();

  // Accord Ctrl+K Ctrl+W : indication dans la barre d'état, puis fermeture de tous les onglets du groupe.
  await mathEditor.locator(".view-lines").click();
  await page.keyboard.press(`${mod}+Backslash`); // scinde : nouveau groupe avec une seconde vue de math.ts
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid=editor-panel][data-path="src/utils/math.ts"]').length === 2,
  );
  await page.keyboard.press(`${mod}+K`);
  await page
    .getByTestId("chord-pending")
    .getByText(/en attente d'une seconde touche/)
    .waitFor();
  await page.keyboard.press(`${mod}+W`);
  await page.getByTestId("chord-pending").waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid=editor-panel][data-path="src/utils/math.ts"]').length === 1,
  );
  assert.equal(app.windows().length, 1);

  // Ctrl+K Ctrl+S : page « Raccourcis clavier », filtrable, avec les accords affichés.
  await page.keyboard.press(`${mod}+K`);
  await page.keyboard.press(`${mod}+S`);
  const keysPanel = page.getByTestId("shortcuts-panel");
  await keysPanel.getByRole("heading", { level: 2, name: "Raccourcis clavier" }).waitFor({ timeout: 15_000 });
  const reopenRow = keysPanel.getByRole("row", { name: /Rouvrir l'onglet fermé/ });
  await reopenRow.waitFor();
  assert.match(await reopenRow.innerText(), /Ctrl\+Maj\+T|⌘⇧T/);
  assert.match(
    await keysPanel.getByRole("row", { name: /Fermer tous les onglets du groupe/ }).innerText(),
    /Ctrl\+K Ctrl\+W|⌘K ⌘W/,
  );
  await keysPanel.getByLabel("Filtrer par commande ou touche").fill("zen");
  await keysPanel.getByRole("row", { name: /Mode zen/ }).waitFor();
  assert.equal(await keysPanel.getByRole("row", { name: /Rouvrir l'onglet fermé/ }).count(), 0);
  await shot("06c-raccourcis");
  // Ctrl+W ferme aussi une vue (pas seulement un fichier).
  await page.keyboard.press(`${mod}+W`);
  await keysPanel.waitFor({ state: "detached" });
  assert.equal(app.windows().length, 1);
});

test("nouvelle session : agent, consigne et trois grandes cartes de mode", async () => {
  await page.getByRole("button", { name: "Session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nouvelle session" });
  await dialog.waitFor();
  const modes = dialog.getByRole("radiogroup", { name: "Mode" }).getByRole("radio");
  assert.equal(await modes.count(), 3);
  await dialog.getByRole("radio", { name: /Autonome\s*L'agent agit directement/ }).waitFor();
  await dialog.getByRole("radio", { name: /Autonome en sandbox/ }).waitFor();
  // TUI interactive (« Terminal ») choisie par défaut pour claude-cli/codex-cli/gemini-cli.
  const claude = dialog.getByRole("radio", { name: /Claude Code/ });
  if ((await claude.isVisible().catch(() => false)) && (await claude.isEnabled())) {
    await claude.click();
    const view = dialog.getByRole("radiogroup", { name: "Affichage de la session" });
    assert.equal(await view.getByRole("radio", { name: /Terminal/ }).getAttribute("aria-checked"), "true");
    assert.equal(await view.getByRole("radio", { name: /Conversation/ }).isEnabled(), true);
  }
  // Mode Autonome : l'absence d'isolation est annoncée sur sa carte.
  await dialog
    .getByTestId("mode-autonomous")
    .getByText(/Aucune isolation/)
    .waitFor();
  // Comparaison : multi-sélection, mode Autonome désactivé avec une explication.
  const compare = dialog.getByRole("checkbox", { name: "Comparer plusieurs agents" });
  if (await compare.isVisible().catch(() => false)) {
    await compare.check();
    assert.equal(await dialog.getByTestId("mode-autonomous").isDisabled(), true);
    await dialog.getByText(/plusieurs agents écriraient dans le même dossier/).waitFor();
    await shot("07b-comparer");
    await compare.uncheck();
    assert.equal(await dialog.getByTestId("mode-autonomous").isDisabled(), false);
  }
  const supervised = dialog.getByRole("radio", { name: /Avec validation/ });
  await supervised.click();
  assert.equal(await supervised.getAttribute("aria-checked"), "true");

  await dialog.getByRole("textbox", { name: "Consigne" }).fill("Ajoute un test pour la fonction add.");
  // Sans agent détecté : accueil d'installation (commandes officielles, Rescanner) ; un connecteur personnalisé se
  // saisit seulement dans « Autre… ».
  const other = dialog.getByText("Autre…", { exact: true });
  if (await other.isVisible().catch(() => false)) {
    const setup = dialog.getByTestId("agent-setup");
    await setup.getByText("npm install -g @openai/codex").waitFor();
    await setup.getByRole("button", { name: "Rescanner" }).waitFor();
    await other.click();
    await dialog.getByLabel("Identifiant du connecteur").fill("claude-code");
  }
  await shot("07-nouvelle-session");
  // Le bouton de lancement est prêt ; on ne lance PAS de vraie session (elle consommerait un agent réel).
  const start = dialog.getByRole("button", { name: "Lancer la session" });
  assert.equal(await start.isEnabled(), true);
  if (await dialog.isVisible()) {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
});

test("contrôle de source : branche, fichiers modifiés et boutons Commit / Push", async () => {
  await page.keyboard.press(`${mod}+Shift+G`);
  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByText("Contrôle de source", { exact: true }).first().waitFor();
  const commit = sidebar.getByRole("button", { name: "Commit" });
  const unavailable = sidebar.getByText(/Contrôle de source indisponible|pas encore disponible/);
  await commit.or(unavailable).first().waitFor({ timeout: 15_000 });
  if (await commit.isVisible()) {
    await sidebar.getByText("README.md").first().waitFor();
    assert.equal(await sidebar.getByRole("button", { name: "Push", exact: true }).isVisible(), true);
    // Pull request : petit dialogue (titre, description, base, brouillon), annulé sans rien créer.
    await sidebar.getByRole("button", { name: "Créer une pull request" }).click();
    const pr = page.getByRole("dialog", { name: "Créer une pull request" });
    await pr.waitFor();
    assert.equal(await pr.getByLabel("Branche de base").inputValue(), "main");
    await pr.getByLabel("Brouillon").waitFor();
    await shot("09b-pull-request");
    await pr.getByRole("button", { name: "Annuler" }).click();
    await pr.waitFor({ state: "hidden" });
    await shot("09-controle-source");
  }
});

test("sandbox : connexion refusée -> toast « Autoriser ce domaine »", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("nexus:event", {
      type: "sandbox-denied",
      target: "registry.example.org:443",
      reason: "hors liste d'autorisation",
    });
  });
  const toastEl = page.locator("[data-sonner-toast]", { hasText: "Connexion bloquée : registry.example.org:443" });
  await toastEl.waitFor();
  await shot("09c-sandbox-refus");
  // Confirmation native du processus principal : simulée ici (l'utilisateur clique « Autoriser »).
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __nexusConfirms: string[] };
    g.__nexusConfirms = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args.at(-1) as { detail?: string };
      g.__nexusConfirms.push(o.detail ?? "");
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  await toastEl.getByRole("button", { name: "Autoriser ce domaine" }).click();
  await page
    .getByText(/registry\.example\.org:443.*(autorisé|déjà autorisé)|Les réglages ne sont pas encore servis/)
    .first()
    .waitFor();
  const confirms = await app.evaluate(() => (globalThis as unknown as { __nexusConfirms: string[] }).__nexusConfirms);
  assert.ok(
    confirms.some((d) => d.includes("registry.example.org:443")),
    "confirmation native demandée",
  );
});

test("orchestre : dialogue (chef, équipe et spécialités, mode, autonomie) et validation des champs", async () => {
  await page.getByRole("button", { name: "Orchestre", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nouvel orchestre" });
  await dialog.waitFor();
  // Avec des agents détectés : choix du chef ; sans agent (runner CI) : message explicite à la place.
  await dialog
    .getByRole("radiogroup", { name: "Chef d'orchestre" })
    .or(dialog.getByText(/Aucun agent détecté|Aucun agent/))
    .first()
    .waitFor();
  await dialog.getByText("Messagerie directe entre agents indisponible en sandbox").waitFor();
  await dialog.getByRole("radio", { name: "Je valide le plan" }).waitFor();
  // Spécialités affichées pour les agents détectés (si Claude/Codex sont installés).
  if ((await dialog.getByTestId("orch-member-codex-cli").count()) > 0)
    await dialog.getByTestId("orch-member-codex-cli").getByText("Implémentation, tests").waitFor();
  // Objectif vide : le lancement est refusé avec un message clair, aucun agent n'est lancé.
  await dialog.getByRole("button", { name: "Lancer un orchestre" }).click();
  await dialog.getByTestId("orch-problems").getByText("Décrivez l'objectif de l'orchestre.").waitFor();
  await dialog.getByLabel("Objectif").fill("Ajouter une page de connexion");
  await dialog.getByTestId("orch-problems").getByText("Décrivez l'objectif").waitFor({ state: "detached" });
  await shot("18-nouvel-orchestre");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
});

test("orchestre : vue alimentée par des événements injectés (fil, messages entre agents, revue, synthèse)", async () => {
  const missionId = "7d1f3c2a-9b4e-4c1d-8a2f-0e5b6c7d8e9f";
  const entries = [
    { kind: "phase", text: "planning", from: "Chef d'orchestre" },
    { kind: "plan", text: "1. API d'authentification\n2. Page de connexion\n3. Tests", from: "Chef d'orchestre" },
    { kind: "assign", text: "API d'authentification", from: "Chef d'orchestre", to: "Claude Code" },
    { kind: "phase", text: "running", from: "Chef d'orchestre" },
    { kind: "message", text: "Quel format pour le jeton ?", from: "Codex CLI", to: "Claude Code" },
    { kind: "handoff", text: "Schéma de l'API transmis", from: "Claude Code", to: "Codex CLI" },
    { kind: "review", text: "Accepté : tests verts.", from: "Chef d'orchestre", to: "Codex CLI" },
    { kind: "summary", text: "Authentification livrée avec tests.", from: "Chef d'orchestre" },
    { kind: "phase", text: "done", from: "Chef d'orchestre" },
  ];
  await app.evaluate(
    ({ BrowserWindow }, { missionId, entries }) => {
      const w = BrowserWindow.getAllWindows()[0];
      entries.forEach((e, i) =>
        w?.webContents.send("nexus:event", {
          type: "orchestra",
          missionId,
          entry: { ...e, at: new Date(Date.UTC(2026, 9, 11, 10, 0, i)).toISOString() },
        }),
      );
    },
    { missionId, entries },
  );
  await page.getByRole("navigation", { name: "Barre d'activité" }).getByRole("button", { name: "Orchestres" }).click();
  const row = page.getByTestId("orchestra-row").first();
  await row.waitFor();
  await row.click();
  const panel = page.getByTestId("orchestra-panel");
  await panel.waitFor();
  const feed = panel.getByTestId("orch-feed");
  await feed.getByTestId("orch-message").getByText("Quel format pour le jeton ?").waitFor();
  assert.match(await feed.getByTestId("orch-message").innerText(), /Codex CLI[\s\S]*Claude Code/);
  await feed.getByTestId("orch-review").getByText("Accepté", { exact: true }).waitFor();
  await feed.getByTestId("orch-handoff").waitFor();
  await feed.getByTestId("orch-summary").getByText("Authentification livrée avec tests.").waitFor();
  await panel.getByTestId("orch-phase").getByText("Terminé").waitFor();
  await panel.getByLabel("Message au chef d'orchestre").waitFor();
  await shot("19-orchestre");
});

test("orchestre en échec : bandeau des erreurs, réattribution mise en forme", async () => {
  const missionId = "8e2a4d3b-0c5f-4d2e-9b3a-1f6c7d8e9fa0";
  const entries = [
    { kind: "phase", text: "running", from: "Chef d'orchestre" },
    { kind: "plan", text: "1. Migration de la base\n2. API", from: "Chef d'orchestre" },
    { kind: "error", text: "Gemini CLI : délai dépassé pendant « Migration de la base »", from: "Gemini CLI" },
    {
      kind: "assign",
      text: "Migration de la base : échec de Gemini CLI (délai dépassé) — réattribuée à Codex CLI",
      from: "Chef d'orchestre",
      to: "Codex CLI",
    },
    { kind: "error", text: "Codex CLI : tests en échec après 2 tours de revue", from: "Codex CLI" },
    { kind: "phase", text: "failed", from: "Chef d'orchestre" },
  ];
  await app.evaluate(
    ({ BrowserWindow }, { missionId, entries }) => {
      const w = BrowserWindow.getAllWindows()[0];
      entries.forEach((e, i) =>
        w?.webContents.send("nexus:event", {
          type: "orchestra",
          missionId,
          entry: { ...e, at: new Date(Date.UTC(2026, 9, 11, 11, 0, i)).toISOString() },
        }),
      );
    },
    { missionId, entries },
  );
  await page.getByTestId("orchestra-list").getByText("1. Migration de la base").click();
  const panel = page.locator("[data-testid=orchestra-panel]:visible");
  const banner = panel.getByTestId("orch-failed");
  await banner.getByText("L'orchestre a échoué").waitFor();
  await banner.getByText(/délai dépassé pendant/).waitFor();
  await banner.getByText(/tests en échec/).waitFor();
  const reassign = panel.getByTestId("orch-reassign");
  await reassign.getByText("réattribuée", { exact: true }).waitFor();
  await reassign.locator(".orch-reason").getByText("délai dépassé").waitFor();
  await shot("20-orchestre-echec");
});

test("activité d'une tâche : ouverture par notification, flux en direct, séparateur de relance", async () => {
  // Aucun agent requis : la tâche est ouverte comme depuis une notification, ses exécutions sont injectées par le main.
  const taskId = "3c9d2e1f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
  await app.evaluate(
    ({ BrowserWindow }, { taskId }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("nexus:event", { type: "navigate", taskId });
    },
    { taskId },
  );
  const view = page.locator("[data-testid=session-panel]:visible");
  await view.waitFor();
  // Deux exécutions (relance) injectées depuis le main.
  await app.evaluate(
    ({ BrowserWindow }, { taskId }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const runA = "11111111-1111-4111-8111-111111111111";
      const runB = "22222222-2222-4222-8222-222222222222";
      const send = (runId: string, event: Record<string, unknown>) =>
        w?.webContents.send("nexus:event", { type: "run", taskId, runId, event: { taskId, ...event } });
      send(runA, { kind: "started", sequence: 1 });
      send(runA, { kind: "output", sequence: 2, channel: "message", text: "Je lis le dépôt." });
      send(runA, { kind: "tool-request", sequence: 3, tool: "read_file", payloadRef: "src/index.ts" });
      send(runA, { kind: "failed", sequence: 4, code: "timeout", message: "délai dépassé" });
      send(runB, { kind: "started", sequence: 1 });
      send(runB, { kind: "output", sequence: 2, channel: "message", text: "Nouvelle tentative en cours." });
    },
    { taskId },
  );
  await view.getByText("Je lis le dépôt.").waitFor();
  await view.getByText("Relance 1").waitFor();
  await view.getByText("Nouvelle tentative en cours.").waitFor();
  await view
    .getByText(/délai dépassé/)
    .first()
    .waitFor();
  await shot("21-activite-tache");
});

test("cadrage : boîte modale à 1024×700 (pied visible, corps qui défile), plan de travail à 1920×1080", async () => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.getByRole("button", { name: "Orchestre", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nouvel orchestre" });
  await dialog.waitFor();
  const box = await dialog.boundingBox();
  assert.ok(
    box && box.x >= 0 && box.x + box.width <= 1024 && box.y >= 0 && box.y + box.height <= 700,
    "modale dans la fenêtre",
  );
  assert.ok(box && box.height <= 700 * 0.86, "hauteur max 85vh");
  const launch = dialog.getByRole("button", { name: "Lancer un orchestre" });
  const lb = await launch.boundingBox();
  assert.ok(lb && lb.y + lb.height <= 700, "bouton du pied visible sans défiler");
  const scrolls = await dialog.locator(".modal-body").evaluate((el) => el.scrollHeight > el.clientHeight);
  assert.ok(scrolls, "le corps défile");
  const noOverflowX = await dialog.locator(".modal-body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  assert.ok(noOverflowX, "pas de débordement horizontal");
  await shot("22-modale-1024");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await shot("23-plan-1024");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByTestId("workbench").waitFor();
  await shot("24-plan-1920");
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("agents : liste des sessions et bouton Nouvelle session", async () => {
  await page.getByRole("navigation", { name: "Barre d'activité" }).getByRole("button", { name: "Agents" }).click();
  await page.getByTestId("sessions-list").waitFor();
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: /Nouvelle session/ })
    .waitFor();
});

test("réglages : thème clair puis sombre, langue EN puis FR", async () => {
  await page.keyboard.press(`${mod}+Comma`);
  const group = page.getByRole("radiogroup", { name: "Thème" });
  await group.waitFor();
  await group.getByRole("radio", { name: "Clair" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await shot("10-reglages-clair");
  await group.getByRole("radio", { name: "Sombre" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");

  await page.getByRole("button", { name: "Langue : français / English" }).first().click();
  await page.getByRole("navigation", { name: "Activity bar" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
  await page.getByRole("button", { name: "Language: français / English" }).first().click();
  await page.getByRole("navigation", { name: "Barre d'activité" }).waitFor();
});

test("consommation et déploiement : accessibles depuis la barre d'activité, plus d'anciennes vues", async () => {
  const bar = page.getByRole("navigation", { name: "Barre d'activité" });
  assert.equal(await bar.getByRole("button", { name: "Missions avancées" }).count(), 0);
  await bar.getByRole("button", { name: "Consommation", exact: true }).click();
  await page.getByRole("heading", { level: 2, name: "Consommation", exact: true }).waitFor({ timeout: 15_000 });
  await bar.getByRole("button", { name: "Déploiement", exact: true }).click();
  await page.locator(".tab-inner", { hasText: "Déploiement" }).first().waitFor({ timeout: 15_000 });
  // Anciennes vues retirées (missions, équipes, approbations, publication Vercel) et plus de panneau Architecture.
  for (const legacy of ["Missions", "Équipes", "Approbations", "Publier", "Architecture"]) {
    await page.keyboard.press(`${mod}+Shift+P`);
    await page.getByPlaceholder("Tapez une commande…").fill(legacy);
    await page.getByText("Aucune commande").or(page.getByRole("listbox")).first().waitFor();
    assert.equal(
      await page.getByRole("option", { name: new RegExp(legacy) }).count(),
      0,
      `commande « ${legacy} » retirée`,
    );
    await page.keyboard.press("Escape");
  }
  assert.equal(
    await page
      .getByTestId("sidebar")
      .getByText(/Architecture/)
      .count(),
    0,
  );
  assert.equal(await page.locator(".mermaid, figure.diagram").count(), 0);
});

test("déploiement : analyse, propositions, choix, secret jamais réaffiché (sans réseau)", async () => {
  // Projet MERN minimal ajouté au projet de test : un front (Vite/React) et un back (Express + Mongoose).
  mkdirSync(join(projectDir, "client"), { recursive: true });
  mkdirSync(join(projectDir, "server"), { recursive: true });
  writeFileSync(
    join(projectDir, "client", "package.json"),
    JSON.stringify({
      name: "stock-client",
      scripts: { build: "vite build" },
      dependencies: { react: "19", vite: "7" },
    }),
  );
  writeFileSync(join(projectDir, "client", ".env.example"), "VITE_API_URL=http://localhost:3000\n");
  writeFileSync(
    join(projectDir, "server", "package.json"),
    JSON.stringify({
      name: "stock-api",
      scripts: { start: "node index.js" },
      dependencies: { express: "5", mongoose: "8" },
    }),
  );
  writeFileSync(join(projectDir, "server", ".env.example"), "MONGODB_URI=\nJWT_SECRET=change-me\n");

  // Entrée dans la barre d'activité.
  await page.getByRole("navigation", { name: "Barre d'activité" }).getByRole("button", { name: "Déploiement" }).click();
  const panel = page.getByTestId("deployment-panel");
  await panel.getByRole("heading", { level: 2, name: "Déploiement" }).waitFor({ timeout: 15_000 });
  const analyze = panel.getByRole("button", { name: /Analyser mon projet|Réanalyser/ });
  await analyze.click();
  // Résumé : composants détectés avec leurs variables attendues.
  const profile = panel.getByTestId("deploy-profile");
  await profile.getByText("stock-client").waitFor({ timeout: 20_000 });
  await profile.getByText("stock-api").waitFor();
  await profile.getByText("JWT_SECRET").waitFor();
  await profile.getByText("mongodb", { exact: true }).waitFor();
  // Propositions comparables avec schéma de placement, coût et badge d'origine.
  const cards = panel.getByTestId("proposal-card");
  await cards.first().waitFor();
  assert.ok((await cards.count()) >= 2, "au moins deux propositions");
  const first = cards.first();
  assert.ok((await first.locator(".placement-row").count()) >= 2);
  await first.getByText("Catalogue", { exact: true }).waitFor();
  await first.getByText("Coût mensuel").waitFor();
  await panel.getByTestId("deploy-lead").getByLabel("Votre demande").waitFor();
  await shot("14-deploiement-propositions");

  // Choix d'une proposition -> étapes « Préparer » puis « Déployer ».
  await first.getByRole("button", { name: "Choisir" }).click();
  await first.getByText("Choisie", { exact: true }).waitFor();
  const prepare = panel.getByTestId("deploy-prepare");
  await prepare.waitFor();
  assert.ok((await panel.getByTestId("deploy-step").count()) >= 1);
  // Étape automatique sans ses prérequis (jetons, paramètres, étapes amont) : « Lancer » désactivé, liste cliquable.
  const blocked = panel
    .getByTestId("deploy-step")
    .filter({ has: page.getByTestId("step-missing") })
    .first();
  await blocked.waitFor();
  assert.equal(await blocked.getByRole("button", { name: "Lancer" }).isDisabled(), true);
  const missingLink = blocked.getByTestId("step-missing").getByRole("button").first();
  await missingLink.click();
  await page.waitForFunction(() => (document.activeElement?.id ?? "").startsWith("dplan-"));

  // Saisie d'un secret : le champ est vidé aussitôt, la valeur n'apparaît nulle part dans le DOM.
  const secretValue = "e2e-ultra-secret-value-123456";
  const field = prepare.locator('.secret-field[data-ref="deploy.env.backend-1.jwt_secret"]');
  await field.waitFor();
  const input = field.locator('input[type="password"]');
  await input.fill(secretValue);
  await field.getByRole("button", { name: "Enregistrer" }).click();
  assert.equal(await input.inputValue(), "");
  // Coffre disponible : coche « enregistré » ; sinon, erreur expliquée en toast.
  await field
    .getByTestId("secret-present")
    .or(page.locator("[data-sonner-toast]", { hasText: /coffre|indisponible/i }))
    .first()
    .waitFor({ timeout: 15_000 });
  const html = await page.content();
  assert.ok(!html.includes(secretValue), "le secret ne doit apparaître nulle part dans le DOM");
  const values = await page.evaluate(() =>
    [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value),
  );
  assert.ok(!values.some((v) => v.includes(secretValue)));
  await shot("15-deploiement-preparer");

  // Étape manuelle éventuelle : « Marquer comme fait » (aucune étape automatique lancée : pas de réseau).
  const manual = panel.getByTestId("deploy-step").filter({ hasText: "Manuelle" }).first();
  if ((await manual.count()) > 0) {
    await manual.getByRole("button", { name: "Marquer comme fait" }).click();
    await manual.getByRole("button", { name: "À refaire" }).waitFor();
  }
  await panel.getByTestId("deploy-step").first().scrollIntoViewIfNeeded();
  await shot("16-deploiement-etapes");
});

test("dépôt d'un dossier sur le plan de travail : survol accepté (dragover) avec retour visuel", async () => {
  const accepted = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=workbench]");
    if (!el) return { enter: false, over: false };
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "dossier"));
    const enter = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt });
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
    el.dispatchEvent(enter);
    el.dispatchEvent(over);
    return { enter: enter.defaultPrevented, over: over.defaultPrevented };
  });
  assert.deepEqual(accepted, { enter: true, over: true });
  await page.getByTestId("workbench-drop").getByText("Relâchez pour ouvrir le dossier").waitFor();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "dossier"));
    document
      .querySelector("[data-testid=workbench]")
      ?.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.getByTestId("workbench-drop").waitFor({ state: "detached" });
});

test("fermer puis rouvrir le projet depuis les récents : disposition restaurée", async () => {
  await page.getByRole("button", { name: "Menu du projet" }).click();
  await page.getByRole("menuitem", { name: "Fermer le projet" }).click();
  const recent = page.getByTestId("recent-projects");
  await recent.getByText("stock-app", { exact: true }).first().waitFor();
  await shot("12-accueil-recents");
  await recent.getByRole("button", { name: /stock-app/ }).click();
  await page.getByTestId("workbench").waitFor();
  // L'onglet index.ts (épinglé) est restauré avec son contenu enregistré.
  await page.locator(".tab-inner", { hasText: "index.ts" }).click();
  await page
    .locator('[data-testid=editor-panel][data-path="src/index.ts"] .monaco-editor')
    .waitFor({ timeout: 20_000 });
});

test("disposition : panneau bas pleine largeur (Terminal / Sortie de l'agent / Journal), jamais d'éditeur en bas", async () => {
  await runFromPalette("panel.log");
  const bottom = page.locator(".dv-edge-group");
  await bottom.getByTestId("log-panel").waitFor();
  await runFromPalette("panel.agentOutput");
  await bottom.getByTestId("agent-output").waitFor();
  await runFromPalette("terminal.new");
  // Rendu « toujours monté » de dockview : le terminal est dans une couche superposée, placée sur le panneau bas.
  const term = page.locator("[data-testid=terminal-panel]:visible");
  await term.waitFor();
  const termBox = await term.boundingBox();
  const bottomBox = await bottom.boundingBox();
  assert.ok(
    termBox &&
      bottomBox &&
      termBox.y >= bottomBox.y - 2 &&
      termBox.y + termBox.height <= bottomBox.y + bottomBox.height + 2,
    "terminal affiché dans le panneau bas",
  );
  // Scinder : un second volet dans le même onglet du panneau bas (pas un groupe dans la zone d'édition).
  await runFromPalette("terminal.split");
  await term.getByTestId("terminal-pane").nth(1).waitFor();
  assert.equal(await page.locator(".dv-edge-group [data-testid=editor-panel]").count(), 0);
  const main = await page.locator("main.workbench-main").boundingBox();
  const panel = await bottom.boundingBox();
  assert.ok(main && panel && panel.width >= main.width - 4, "panneau bas sur toute la largeur de la zone de travail");
  await shot("17-panneau-bas");
  await runFromPalette("terminal.kill");
  await term.getByTestId("terminal-pane").nth(1).waitFor({ state: "detached" });
  // Réinitialiser la disposition : aucune erreur, la zone d'édition reste utilisable.
  await runFromPalette("layout.reset");
  await page.getByTestId("workbench").waitFor();
});

test("palette avec projet : chaque commande s'exécute sans erreur", async () => {
  const before = pageErrors.length;
  const ids = await paletteCommandIds();
  assert.ok(ids.length >= 40, `commandes avec projet : ${ids.length}`);
  for (const id of ids) {
    if (SKIP_COMMANDS.has(id)) continue;
    await runFromPalette(id);
    assert.equal(pageErrors.length, before, `erreur JS après « ${id} » : ${pageErrors.slice(before).join(" | ")}`);
  }
  // Remise en état pour la suite : thème sombre, pas de mode zen, barre latérale visible.
  await runFromPalette("theme.dark");
  if ((await page.locator(".workbench.is-zen").count()) > 0) await page.locator(".zen-exit").click();
  if ((await page.getByTestId("sidebar").count()) === 0) await page.keyboard.press(`${mod}+B`);
  await page.getByTestId("workbench").waitFor();
});

test("ancien onglet Architecture dans une disposition sauvegardée : notification unique vers Déploiement", async () => {
  await page.getByRole("button", { name: "Menu du projet" }).click();
  await page.getByRole("menuitem", { name: "Fermer le projet" }).click();
  const recent = page.getByTestId("recent-projects");
  await recent.getByText("stock-app", { exact: true }).first().waitFor();
  // Disposition d'une ancienne version contenant l'onglet « Architecture ».
  await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? "";
      if (!k.startsWith("nexus.layout.")) continue;
      localStorage.setItem(
        k,
        JSON.stringify({
          grid: { root: { type: "branch", data: [] }, width: 0, height: 0, orientation: "HORIZONTAL" },
          panels: { "view:architecture": { id: "view:architecture", contentComponent: "architecture" } },
        }),
      );
    }
  });
  await recent.getByRole("button", { name: /stock-app/ }).click();
  await page.getByTestId("workbench").waitFor();
  const notice = page.locator("[data-sonner-toast]", { hasText: "La vue Architecture est remplacée par Déploiement" });
  await notice.waitFor();
  await notice.getByRole("button", { name: "Ouvrir Déploiement" }).click();
  await page.getByTestId("deployment-panel").waitFor();
});

test("disposition sauvegardée par projet, aucun secret en stockage local", async () => {
  // Enregistrement différé de la disposition : on attend qu'elle soit écrite plutôt qu'un délai fixe.
  await page.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith("nexus.layout.")));
  const storage = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) as string;
      out[k] = localStorage.getItem(k) ?? "";
    }
    return out;
  });
  const keys = Object.keys(storage);
  assert.ok(
    keys.every((k) => k.startsWith("nexus.")),
    JSON.stringify(keys),
  );
  assert.ok(
    keys.some((k) => k.startsWith("nexus.layout.")),
    JSON.stringify(keys),
  );
  assert.ok(!JSON.stringify(storage).includes("not-a-real-token"));
  await shot("11-plan-de-travail");
});

test("aucune erreur JavaScript ni violation CSP pendant le parcours", () => {
  // Informations : erreurs console non bloquantes (ex. refus d'un canal), utiles au diagnostic.
  if (consoleErrors.length > 0) console.log("console.error :", consoleErrors.slice(0, 20));
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(cspViolations, []);
});
