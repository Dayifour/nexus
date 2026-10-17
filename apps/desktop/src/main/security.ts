// Durcissement Electron (cahier maître §7, T-003). Le renderer est non fiable.
import { app, session, shell, type WebContents } from "electron";
import { isCatalogDocsUrl } from "../shared/agent-catalog.ts";

/** Origines autorisées pour le contenu de l'application : serveur Vite en dev, fichiers empaquetés sinon. */
export function isTrustedAppUrl(url: string, devServerUrl: string | undefined, rendererDir: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (devServerUrl) {
    const dev = new URL(devServerUrl);
    if (parsed.origin === dev.origin) return true;
  }
  if (parsed.protocol === "file:") {
    const path = decodeURIComponent(parsed.pathname);
    return path === rendererDir || path.startsWith(rendererDir.endsWith("/") ? rendererDir : `${rendererDir}/`);
  }
  return false;
}

export function hardenApp(options: {
  devServerUrl: string | undefined;
  rendererDir: string;
  /** Dictée (T-020) : vrai uniquement pendant la courte fenêtre ouverte par un clic explicite sur le micro. */
  canGrantMicrophone?: () => boolean;
}): void {
  // Sandbox Chromium pour tous les renderers, avant toute création de fenêtre.
  app.enableSandbox();

  app.on("web-contents-created", (_event, contents: WebContents) => {
    // Aucune nouvelle fenêtre. Seule exception : les pages de documentation des agents (liste fermée, comparaison
    // exacte), ouvertes dans le navigateur du système sur un clic explicite de l'utilisateur.
    contents.setWindowOpenHandler(({ url }) => {
      if (isCatalogDocsUrl(url)) void shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!isTrustedAppUrl(url, options.devServerUrl, options.rendererDir)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isTrustedAppUrl(url, options.devServerUrl, options.rendererDir)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  void app.whenReady().then(() => {
    const ses = session.defaultSession;
    // Refus par défaut de toute permission (caméra, notifications, géolocalisation…). Seule exception : le micro
    // (audio seul, jamais la vidéo) pendant la fenêtre armée par un clic de dictée, depuis le contenu de l'application.
    const micAllowed = (permission: string, mediaTypes: readonly string[] | undefined, origin: string) =>
      permission === "media" &&
      (mediaTypes ?? []).length > 0 &&
      (mediaTypes ?? []).every((m) => m === "audio") &&
      isTrustedAppUrl(origin, options.devServerUrl, options.rendererDir) &&
      options.canGrantMicrophone?.() === true;
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const d = details as { mediaTypes?: string[]; requestingUrl?: string };
      callback(micAllowed(permission, d.mediaTypes, d.requestingUrl ?? ""));
    });
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
  });
}
