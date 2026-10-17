// Libellés du processus principal (boîtes natives, notifications, menu) dans la langue des réglages de Nexus.
// Petit dictionnaire autonome : le main n'embarque pas les traductions de l'interface.
import { app } from "electron";

export type MainLang = "fr" | "en";

const fr = {
  "dialog.export.title": "Exporter le projet",
  "dialog.archive": "Archive Nexus",
  "dialog.openFolder.title": "Ouvrir un dossier",
  "dialog.import.title": "Importer un projet",
  "dialog.cancel": "Annuler",
  "dialog.allow": "Autoriser",
  "notify.needs_input": "attend votre réponse",
  "notify.idle": "a terminé son tour",
  "notify.done": "a terminé",
  "notify.error": "s'est arrêté sur une erreur",
  "notify.title": "Agent : {what}",
  "notify.session": "Session",
  "menu.file": "Fichier",
  "menu.closeWindow": "Fermer la fenêtre",
  "menu.quit": "Quitter Nexus AI",
  "menu.edit": "Édition",
  "menu.undo": "Annuler",
  "menu.redo": "Rétablir",
  "menu.cut": "Couper",
  "menu.copy": "Copier",
  "menu.paste": "Coller",
  "menu.selectAll": "Tout sélectionner",
  "menu.view": "Affichage",
  "menu.zoomIn": "Zoom avant",
  "menu.zoomOut": "Zoom arrière",
  "menu.resetZoom": "Taille réelle",
  "menu.fullscreen": "Plein écran",
  "menu.devTools": "Outils de développement",
  "menu.window": "Fenêtre",
  "menu.minimize": "Réduire",
} as const;

export type MainKey = keyof typeof fr;

const en: Record<MainKey, string> = {
  "dialog.export.title": "Export project",
  "dialog.archive": "Nexus archive",
  "dialog.openFolder.title": "Open folder",
  "dialog.import.title": "Import project",
  "dialog.cancel": "Cancel",
  "dialog.allow": "Allow",
  "notify.needs_input": "is waiting for your answer",
  "notify.idle": "finished its turn",
  "notify.done": "has finished",
  "notify.error": "stopped with an error",
  "notify.title": "Agent {what}",
  "notify.session": "Session",
  "menu.file": "File",
  "menu.closeWindow": "Close Window",
  "menu.quit": "Quit Nexus AI",
  "menu.edit": "Edit",
  "menu.undo": "Undo",
  "menu.redo": "Redo",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.selectAll": "Select All",
  "menu.view": "View",
  "menu.zoomIn": "Zoom In",
  "menu.zoomOut": "Zoom Out",
  "menu.resetZoom": "Actual Size",
  "menu.fullscreen": "Toggle Full Screen",
  "menu.devTools": "Developer Tools",
  "menu.window": "Window",
  "menu.minimize": "Minimize",
};

/** Langue du système (premier lancement) : fr* → français, sinon anglais. */
export function systemLang(): MainLang {
  try {
    return app.getLocale().toLowerCase().startsWith("fr") ? "fr" : "en";
  } catch {
    return "en";
  }
}

let current: () => MainLang = systemLang;

/** Source de la langue courante (les réglages, une fois les services ouverts). */
export function setLangSource(source: () => MainLang): void {
  current = source;
}

export function mt(key: MainKey, vars?: Record<string, string>): string {
  let text: string = (current() === "en" ? en : fr)[key];
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
  return text;
}
