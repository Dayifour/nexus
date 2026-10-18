import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import started from "electron-squirrel-startup";
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL, IpcPushEvent } from "@nexus/contracts";
import { AppServices, createAppHandlers, ExposedError } from "@nexus/app-services";
import { dispatchIpc, IpcHandlerError, type IpcHandlers } from "./main/ipc-dispatch.ts";
import { safeStorageCipher } from "./main/safe-storage-cipher.ts";
import { hardenApp, isTrustedAppUrl } from "./main/security.ts";
import { installAppMenu } from "./main/app-menu.ts";
import { mt, setLangSource, systemLang, type MainKey } from "./main/i18n.ts";

if (started) {
  app.quit();
}

const devServerUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string" ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
const rendererDir = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);

// NEXUS_USER_DATA_DIR permet aux tests E2E d'isoler leurs données ; sinon dossier standard de l'utilisateur.
if (process.env.NEXUS_USER_DATA_DIR) app.setPath("userData", process.env.NEXUS_USER_DATA_DIR);

let handlers: IpcHandlers = {};
let services: AppServices | undefined;
hardenApp({ devServerUrl, rendererDir, canGrantMicrophone: () => services?.voice.mayGrantMicrophone() ?? false });
const ready = (async () => {
  await app.whenReady();
  services = await AppServices.open({
    userDataDir: app.getPath("userData"),
    cipher: safeStorageCipher(),
    pathEnv: process.env.PATH ?? "/usr/bin:/bin",
    home: app.getPath("home"),
    pickSavePath: async (defaultName) => {
      const r = await dialog.showSaveDialog({
        title: mt("dialog.export.title"),
        defaultPath: defaultName,
        filters: [{ name: mt("dialog.archive"), extensions: ["json"] }],
      });
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    pickFolder: async () => {
      const r = await dialog.showOpenDialog({
        title: mt("dialog.openFolder.title"),
        properties: ["openDirectory", "createDirectory"],
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    trash: (absolutePath) => shell.trashItem(absolutePath),
    confirm: async (message, detail) => {
      const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const opts = {
        type: "warning" as const,
        message,
        detail,
        buttons: [mt("dialog.cancel"), mt("dialog.allow")],
        defaultId: 0,
        cancelId: 0,
      };
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      return r.response === 1;
    },
    // Terminaux de l'utilisateur : son environnement normal (comme dans un terminal ou VS Code). Jamais pour les agents.
    userEnv: Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
    pickOpenPath: async () => {
      const r = await dialog.showOpenDialog({
        title: mt("dialog.import.title"),
        properties: ["openFile"],
        filters: [{ name: mt("dialog.archive"), extensions: ["json"] }],
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    push: (event) => {
      // Validé avant envoi : seul un événement conforme au contrat atteint le renderer.
      const parsed = IpcPushEvent.safeParse(event);
      if (!parsed.success) return;
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC_EVENT_CHANNEL, parsed.data);
      if (parsed.data.type === "agent-status") void notifyAgent(parsed.data.taskId, parsed.data.status);
    },
  });
  // Langue du main = celle des réglages. Premier lancement (aucun réglage enregistré) : langue du système.
  if (!existsSync(path.join(app.getPath("userData"), "settings.json"))) {
    services.settings.set({ ...services.settings.get(), language: systemLang() });
  }
  setLangSource(() => services?.settings.get().language ?? systemLang());
  // Notification système quand un agent a besoin de l'utilisateur ou a fini, si la fenêtre n'a pas le focus.
  // Un clic ramène la fenêtre et ouvre la session concernée.
  const NOTIFY: Partial<Record<string, MainKey>> = {
    needs_input: "notify.needs_input",
    idle: "notify.idle",
    done: "notify.done",
    error: "notify.error",
  };
  async function notifyAgent(taskId: string, status: string) {
    const key = NOTIFY[status];
    const what = key ? mt(key) : undefined;
    if (!what || !Notification.isSupported() || BrowserWindow.getFocusedWindow()) return;
    if (!services) return;
    const title = await services.core.missions.getTask(taskId).then(
      (t) => t.title,
      () => mt("notify.session"),
    );
    const n = new Notification({
      title: mt("notify.title", { what }),
      body: title.slice(0, 120),
      silent: status === "idle",
    });
    n.on("click", () => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.focus();
      w.webContents.send(IPC_EVENT_CHANNEL, { type: "navigate", taskId });
    });
    n.show();
  }
  const appHandlers = createAppHandlers(services, {
    appVersion: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
  });
  // Les erreurs exposables des services deviennent des erreurs IPC contrôlées ; le reste est masqué par le dispatcher.
  handlers = Object.fromEntries(
    Object.entries(appHandlers).map(([channel, fn]) => [
      channel,
      async (req: unknown) => {
        try {
          return await (fn as (r: unknown) => unknown)(req);
        } catch (e) {
          if (e instanceof ExposedError) throw new IpcHandlerError(e.code, e.message);
          throw e;
        }
      },
    ]),
  ) as IpcHandlers;
})();

ipcMain.handle(IPC_INVOKE_CHANNEL, async (event, raw) => {
  // Seul le contenu de l'application peut invoquer le main (pas une page tierce chargée par erreur).
  const url = event.senderFrame?.url ?? "";
  if (!isTrustedAppUrl(url, devServerUrl, rendererDir)) {
    return {
      requestId: "00000000-0000-0000-0000-000000000000",
      ok: false,
      error: { code: "policy_denied", message: "Untrusted sender" },
    };
  }
  await ready;
  return dispatchIpc(raw, handlers);
});

/** Thème effectif de la fenêtre : préférence de l'utilisateur (Clair / Sombre / Système). */
function resolvedTheme(): "dark" | "light" {
  const pref = services?.settings.get().theme ?? "dark";
  return (pref === "system" ? nativeTheme.shouldUseDarkColors : pref === "dark") ? "dark" : "light";
}
// Couleurs alignées sur les jetons --bg / --chrome / --fg de styles.css (fond avant le premier rendu, boutons de fenêtre).
const WINDOW_COLORS = {
  dark: { bg: "#0a0b10", chrome: "#0d0f15", fg: "#e7e9ef" },
  light: { bg: "#f5f6f8", chrome: "#eef0f4", fg: "#1a1d26" },
} as const;

/** Couleurs des boutons de fenêtre, alignées sur la barre de Nexus (--chrome / --fg). */
function titleBarColors(): { color: string; symbolColor: string; height: number } {
  const c = WINDOW_COLORS[resolvedTheme()];
  return { color: c.chrome, symbolColor: c.fg, height: 40 };
}
/**
 * Applique la préférence au thème natif (menus, boîtes de dialogue, barre de titre et `prefers-color-scheme`
 * du renderer, qui suit donc aussi le choix « Système »), puis recolore les fenêtres ouvertes.
 */
function applyNativeTheme(): void {
  const pref = services?.settings.get().theme ?? "dark";
  if (nativeTheme.themeSource !== pref) nativeTheme.themeSource = pref;
  for (const w of BrowserWindow.getAllWindows()) {
    w.setBackgroundColor(WINDOW_COLORS[resolvedTheme()].bg);
    if (process.platform !== "darwin") w.setTitleBarOverlay(titleBarColors());
    sendSystemTheme(w);
  }
}

/** Thème « Système » : apparence réelle de l'OS envoyée au renderer (voir l'événement `system-theme`). */
function sendSystemTheme(w: BrowserWindow): void {
  if ((services?.settings.get().theme ?? "dark") !== "system" || w.webContents.isLoading()) return;
  w.webContents.send(IPC_EVENT_CHANNEL, { type: "system-theme", dark: nativeTheme.shouldUseDarkColors });
}

const createWindow = (): BrowserWindow => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "Nexus AI",
    // Barre de menus masquée (aspect IDE) ; Alt l'affiche.
    autoHideMenuBar: true,
    // Barre de titre intégrée : pas de barre du système ; les boutons de fenêtre s'affichent dans la barre de Nexus,
    // aux couleurs du thème (macOS : boutons natifs à gauche).
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarColors(),
    // Fond du thème courant dès la création : aucun éclair blanc ou sombre avant le premier rendu.
    backgroundColor: WINDOW_COLORS[resolvedTheme()].bg,
    webPreferences: {
      // Thème initial lu par le preload, qui le pose sur <html> avant le premier rendu (la CSP interdit le script inline).
      additionalArguments: [`--nexus-theme=${resolvedTheme()}`],
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow.webContents.on("did-finish-load", () => sendSystemTheme(mainWindow));
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(rendererDir, "index.html"));
  }

  return mainWindow;
};

void ready.then(() => {
  installAppMenu({ dev: Boolean(devServerUrl) });
  // Menu natif reconstruit quand la langue des réglages change.
  let menuLang = services?.settings.get().language;
  services?.settings.onChange((next) => {
    if (next.language === menuLang) return;
    menuLang = next.language;
    installAppMenu({ dev: Boolean(devServerUrl) });
  });
  applyNativeTheme();
  services?.settings.onChange(() => applyNativeTheme());
  nativeTheme.on("updated", () => applyNativeTheme());
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Arrêt des agents en cours puis fermeture propre de la base (UC-05) : la sortie attend la fermeture des services,
// bornée à 5 s pour qu'un service bloqué n'empêche jamais de quitter. app.exit() ne réémet pas will-quit.
const QUIT_TIMEOUT_MS = 5000;
let exitCode = 0;
let closing: Promise<void> | undefined;
app.on("will-quit", (event) => {
  event.preventDefault();
  closing ??= Promise.race([
    Promise.resolve(services?.close()),
    new Promise<void>((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS).unref()).then(() =>
      console.error(`[nexus] arrêt des services non terminé après ${QUIT_TIMEOUT_MS} ms : sortie forcée`),
    ),
  ])
    .catch((e: unknown) => console.error("[nexus] échec de la fermeture des services", e))
    .finally(() => app.exit(exitCode));
});

// Erreurs non rattrapées : journalisées, jamais silencieuses. Une promesse rejetée est seulement journalisée ;
// une exception non rattrapée laisse le processus dans un état incertain : arrêt propre (agents, base) puis code 1.
process.on("unhandledRejection", (reason) => console.error("[nexus] promesse rejetée non gérée", reason));
process.on("uncaughtException", (error, origin) => {
  console.error(`[nexus] exception non rattrapée (${origin})`, error);
  exitCode = 1;
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
