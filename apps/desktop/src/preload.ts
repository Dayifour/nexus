// Pont minimal renderer -> main. Trois fonctions seulement (invoke, onEvent, pathForFile) ; aucun objet Electron ni Node
// (ipcRenderer, require, process) ne traverse contextBridge. La requête est validée ici puis dans le main.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import {
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
  ipcChannels,
  isIpcChannel,
} from "@nexus/contracts";

const api = {
  invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>> {
    const requestId = globalThis.crypto.randomUUID();
    if (typeof channel !== "string" || !isIpcChannel(channel)) {
      return Promise.resolve({ requestId, ok: false, error: { code: "unknown_channel", message: "Unknown channel" } });
    }
    const parsed = ipcChannels[channel].request.safeParse(payload);
    if (!parsed.success) {
      return Promise.resolve({ requestId, ok: false, error: { code: "invalid_request", message: "Invalid payload" } });
    }
    return ipcRenderer.invoke(IPC_INVOKE_CHANNEL, { requestId, channel, payload: parsed.data });
  },
  /**
   * Chemin absolu d'un fichier ou dossier déposé (glisser-déposer). Electron ne l'expose plus sur `File` :
   * seul `webUtils` le fournit. Ne donne accès à rien d'autre : le main valide ensuite le chemin.
   */
  pathForFile(file: File): string {
    if (!(file instanceof File)) throw new TypeError("expected a File");
    return webUtils.getPathForFile(file);
  },
  /** Abonnement aux événements poussés par le main ; renvoie la fonction de désabonnement. */
  onEvent(listener: (event: unknown) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const wrapped = (_e: IpcRendererEvent, data: unknown) => listener(data);
    ipcRenderer.on(IPC_EVENT_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, wrapped);
    };
  },
};

export type NexusApi = typeof api;

contextBridge.exposeInMainWorld("nexus", Object.freeze(api));

// Thème initial (transmis par le main) posé sur <html> avant le premier rendu : pas d'éclair du mauvais thème au
// démarrage. Le store du renderer prend ensuite le relais (changements en direct, mode Système).
const initialTheme = process.argv.find((a) => a.startsWith("--nexus-theme="))?.slice("--nexus-theme=".length);
if (initialTheme === "dark" || initialTheme === "light") {
  const apply = (): boolean => {
    const root = document.documentElement;
    if (!root) return false;
    if (!root.dataset.theme) {
      root.dataset.theme = initialTheme;
      root.style.colorScheme = initialTheme;
    }
    return true;
  };
  if (!apply()) {
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(document, { childList: true });
  }
}
