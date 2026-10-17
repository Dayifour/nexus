// Menu de l'application. Le menu par défaut d'Electron lie Ctrl/Cmd+W à « Fermer la fenêtre » (l'application
// quittait au lieu de fermer l'onglet) : ici, Ctrl/Cmd+W est laissé à l'interface (fermer l'éditeur actif), comme
// dans VS Code. Fermer la fenêtre : Ctrl/Cmd+Maj+W ; quitter : Ctrl/Cmd+Q. Libellés dans la langue des réglages
// (le menu est reconstruit quand elle change).
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { mt } from "./i18n.ts";

export function installAppMenu(opts: { dev: boolean }): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: mt("menu.file"),
      submenu: [
        { label: mt("menu.closeWindow"), accelerator: "CmdOrCtrl+Shift+W", role: "close" },
        { type: "separator" },
        { label: mt("menu.quit"), accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    {
      label: mt("menu.edit"),
      submenu: [
        { role: "undo", label: mt("menu.undo") },
        { role: "redo", label: mt("menu.redo") },
        { type: "separator" },
        { role: "cut", label: mt("menu.cut") },
        { role: "copy", label: mt("menu.copy") },
        { role: "paste", label: mt("menu.paste") },
        { role: "selectAll", label: mt("menu.selectAll") },
      ],
    },
    {
      label: mt("menu.view"),
      submenu: [
        { role: "zoomIn", label: mt("menu.zoomIn"), accelerator: "CmdOrCtrl+=" },
        { role: "zoomOut", label: mt("menu.zoomOut") },
        { role: "resetZoom", label: mt("menu.resetZoom") },
        { type: "separator" },
        { role: "togglefullscreen", label: mt("menu.fullscreen") },
        ...(opts.dev
          ? [{ type: "separator" as const }, { role: "toggleDevTools" as const, label: mt("menu.devTools") }]
          : []),
      ],
    },
    { label: mt("menu.window"), submenu: [{ role: "minimize", label: mt("menu.minimize") }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
