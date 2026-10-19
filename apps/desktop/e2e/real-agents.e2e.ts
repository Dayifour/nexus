// Parcours RÉELS dans l'application empaquetée, avec de vrais agents (Claude Code, Codex CLI connectés sur la machine).
// Désactivé par défaut (consomme des requêtes chez les fournisseurs) : NEXUS_REAL_AGENTS=1 pour l'exécuter.
// Prérequis : `electron-forge package`, puis `xvfb-run -a node --test e2e/real-agents.e2e.ts`.
// Données isolées (dossier temporaire) ; seuls les identifiants des CLI de l'utilisateur sont utilisés, par les CLI.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

// Hérité d'un hôte Electron (terminal de VS Code…) : ferait démarrer l'application testée comme simple Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const REAL = process.env.NEXUS_REAL_AGENTS === "1";
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.NEXUS_E2E_SCREENSHOTS;
let app: ElectronApplication;
let page: Page;
let root: string;
let projectDir: string;

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`délai dépassé : ${what}`);
}
const shot = async (name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `real-${name}.png`) });
};

before(async () => {
  if (!REAL) return;
  root = mkdtempSync(join(tmpdir(), "nexus-real-"));
  projectDir = join(root, "site");
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, "README.md"), "# Site\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "add", "-A"], { cwd: projectDir });
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "-m", "init"], {
    cwd: projectDir,
  });
  app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, NEXUS_USER_DATA_DIR: join(root, "userdata") },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1500, height: 940 });
  await page.getByRole("button", { name: "Saisir un chemin" }).click();
  const dialog = page.getByRole("dialog", { name: "Ouvrir un dossier" });
  await dialog.getByLabel("Chemin du dossier").fill(projectDir);
  await dialog.getByRole("button", { name: "Ouvrir", exact: true }).click();
  await page.getByTestId("workbench").waitFor();
});

after(async () => {
  if (!REAL) return;
  await app?.close().catch(() => undefined);
  // NEXUS_REAL_KEEP=1 : données conservées pour analyse (journal de l'orchestre, sessions).
  if (process.env.NEXUS_REAL_KEEP === "1") console.log(`données conservées : ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

async function newSession(agent: RegExp, view: "Conversation" | "Terminal", prompt: string) {
  await page.getByRole("button", { name: "Session", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nouvelle session" });
  await dialog.waitFor();
  await dialog.getByRole("radio", { name: agent }).first().click();
  await dialog
    .getByRole("radiogroup", { name: "Affichage de la session" })
    .getByRole("radio", { name: new RegExp(view) })
    .click();
  await dialog.getByRole("radio", { name: /Autonome\s*L'agent agit directement/ }).click();
  await dialog.getByRole("textbox", { name: "Consigne" }).fill(prompt);
  await dialog.getByRole("button", { name: "Lancer la session" }).click();
  await dialog.waitFor({ state: "hidden" });
}

test(
  "RÉEL : session en conversation (Claude), puis nouveau message dans la même conversation",
  { skip: !REAL && "NEXUS_REAL_AGENTS=1 requis", timeout: 600_000 },
  async () => {
    await newSession(
      /Claude Code/,
      "Conversation",
      "Crée le fichier hello.txt contenant exactement la ligne : bonjour",
    );
    await waitFor(() => existsSync(join(projectDir, "hello.txt")), 240_000, "hello.txt créé par Claude");
    assert.match(readFileSync(join(projectDir, "hello.txt"), "utf8"), /bonjour/);
    const panel = page.getByTestId("session-panel").last();
    const composer = panel.getByRole("textbox", { name: "Nouvelle consigne" });
    await composer.waitFor();
    // Attendre la fin du tour avant d'envoyer le suivant (le bouton Envoyer redevient actif).
    await waitFor(() => true, 3000, "");
    await composer.fill("Ajoute une deuxième ligne au fichier hello.txt : salut");
    await panel.getByRole("button", { name: "Envoyer" }).click();
    await waitFor(
      () => /salut/.test(readFileSync(join(projectDir, "hello.txt"), "utf8")),
      240_000,
      "deuxième ligne ajoutée",
    );
    await shot("1-conversation");
  },
);

test(
  "RÉEL : session dans le vrai terminal de l'agent (Codex)",
  { skip: !REAL && "NEXUS_REAL_AGENTS=1 requis", timeout: 600_000 },
  async () => {
    await newSession(/Codex CLI/, "Terminal", "Crée le fichier codex.txt contenant exactement : ok");
    await waitFor(
      () => existsSync(join(projectDir, "codex.txt")),
      300_000,
      "codex.txt créé par Codex dans son terminal",
    );
    await shot("2-terminal");
  },
);

test(
  "RÉEL : orchestre (chef Claude, équipe Codex) jusqu'à « Terminé »",
  { skip: !REAL && "NEXUS_REAL_AGENTS=1 requis", timeout: 1_500_000 },
  async () => {
    await page.getByRole("button", { name: "Orchestre", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Nouvel orchestre" });
    await dialog.waitFor();
    await dialog
      .getByLabel("Objectif")
      .fill(
        "Crée calc.js qui exporte add(a, b) et sub(a, b), et un test calc.test.js (node:test) qui passe avec `node --test`.",
      );
    await dialog
      .getByRole("radiogroup", { name: "Chef d'orchestre" })
      .getByRole("radio", { name: /Claude Code/ })
      .click();
    for (const id of ["claude-cli", "gemini-cli", "qwen-cli", "hermes-cli", "opencode-cli", "codex-cli"]) {
      const box = dialog.getByTestId(`orch-member-${id}`).getByRole("checkbox");
      if (!(await box.count())) continue;
      const on = (await box.getAttribute("aria-checked")) === "true";
      if (on !== (id === "codex-cli")) await box.click();
    }
    await dialog.getByTestId("orch-mode-autonomous").click();
    await dialog.getByRole("radio", { name: "Totale" }).click();
    await dialog.getByRole("button", { name: "Lancer un orchestre" }).click();
    await dialog.waitFor({ state: "hidden" });
    const panel = page.getByTestId("orchestra-panel");
    await panel.waitFor();
    // Une tâche en cours : un clic montre ce que fait l'agent (flux en direct).
    const running = panel.locator("button.orch-task.is-running").first();
    await running.waitFor({ timeout: 900_000 });
    await running.click();
    const activity = page.getByTestId("session-panel").last();
    await activity.waitFor();
    await activity
      .locator('[data-testid="activity-working"], [data-testid="session-transcript"] > *')
      .first()
      .waitFor({ timeout: 120_000 });
    await shot("3a-tache-en-cours");
    await panel
      .getByText(/^(Terminé|Échec)$/)
      .first()
      .waitFor({ state: "attached", timeout: 1_400_000 });
    await shot("3-orchestre");
    assert.equal(
      (await panel.getByText("Terminé", { exact: true }).count()) > 0,
      true,
      "orchestre terminé avec succès",
    );
    assert.ok(existsSync(join(projectDir, "calc.js")) && existsSync(join(projectDir, "calc.test.js")));
    execFileSync(process.execPath, ["--test", "calc.test.js"], { cwd: projectDir });
  },
);

test(
  "RÉEL : session dans le vrai terminal de l'agent (Claude)",
  { skip: !REAL && "NEXUS_REAL_AGENTS=1 requis", timeout: 600_000 },
  async () => {
    await newSession(/Claude Code/, "Terminal", "Crée le fichier claude.txt contenant exactement : ok");
    await waitFor(
      () => existsSync(join(projectDir, "claude.txt")),
      300_000,
      "claude.txt créé par Claude dans son terminal",
    );
    await shot("4-terminal-claude");
  },
);
