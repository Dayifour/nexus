// Terminaux interactifs (PTY côté main). Ce store suit l'état de chaque terminal ouvert (pour la barre d'état et les
// titres) ; les octets de sortie transitent par un petit bus hors React, avec tampon tant que la vue n'est pas prête.
import { create } from "zustand";

export interface TerminalInfo {
  panelId: string;
  terminalId?: string;
  title: string;
  cwd?: string;
  shell?: string;
  status: "starting" | "running" | "exited" | "unavailable" | "error";
  exitCode?: number | null;
}

interface TerminalsState {
  byPanel: Record<string, TerminalInfo>;
  upsert(panelId: string, info: Partial<TerminalInfo>): void;
  remove(panelId: string): void;
  panelOfTerminal(terminalId: string): string | undefined;
}

export const useTerminalsStore = create<TerminalsState>()((set, get) => ({
  byPanel: {},
  upsert(panelId, info) {
    set((s) => {
      const prev: TerminalInfo = s.byPanel[panelId] ?? { panelId, title: "Terminal", status: "starting" };
      return { byPanel: { ...s.byPanel, [panelId]: { ...prev, ...info } } };
    });
  },
  remove(panelId) {
    set((s) => {
      const byPanel = { ...s.byPanel };
      delete byPanel[panelId];
      return { byPanel };
    });
  },
  panelOfTerminal(terminalId) {
    return Object.values(get().byPanel).find((t) => t.terminalId === terminalId)?.panelId;
  },
}));

type DataListener = (data: string) => void;
type ExitListener = (code: number | null) => void;

const dataListeners = new Map<string, DataListener>();
const exitListeners = new Map<string, ExitListener>();
const buffered = new Map<string, string[]>();
const MAX_BUFFER = 2000;

export const terminalBus = {
  emitData(terminalId: string, data: string): void {
    const l = dataListeners.get(terminalId);
    if (l) {
      l(data);
      return;
    }
    const buf = buffered.get(terminalId) ?? [];
    buf.push(data);
    if (buf.length > MAX_BUFFER) buf.shift();
    buffered.set(terminalId, buf);
  },
  emitExit(terminalId: string, code: number | null): void {
    const listener = exitListeners.get(terminalId);
    if (listener) {
      listener(code);
      return;
    }
    // Terminal terminé sans vue rattachée (agent en arrière-plan, session lancée puis onglet fermé) : sa sortie
    // tamponnée ne sera jamais affichée (la session relit son enregistrement) ; elle est libérée.
    buffered.delete(terminalId);
  },
  attach(terminalId: string, onData: DataListener, onExit: ExitListener): () => void {
    dataListeners.set(terminalId, onData);
    exitListeners.set(terminalId, onExit);
    const buf = buffered.get(terminalId);
    if (buf) {
      buffered.delete(terminalId);
      for (const chunk of buf) onData(chunk);
    }
    return () => {
      if (dataListeners.get(terminalId) === onData) dataListeners.delete(terminalId);
      if (exitListeners.get(terminalId) === onExit) exitListeners.delete(terminalId);
    };
  },
};

/**
 * Terminaux d'agent dont l'onglet est fermé sans arrêter l'agent (« Laisser tourner en arrière-plan ») : le PTY reste
 * vivant côté main et se rouvre depuis la liste des sessions (sa sortie est mise en tampon entre-temps).
 */
export const backgroundTerminals = new Set<string>();

/** Actions clavier d'un terminal affiché (copier, coller, effacer), par panneau : utilisées par la palette. */
export interface TerminalControls {
  copySelection(): void;
  paste(): void;
  clear(): void;
  focus(): void;
  search(): void;
  restart(): void;
}
/** Par volet (clé du volet) et par onglet (`<panelId>#panel`, qui délègue au volet focalisé). */
export const terminalControls = new Map<string, TerminalControls>();
/** Actions d'un onglet terminal : scinder, fermer le volet focalisé. */
export const terminalPanels = new Map<string, { split(): void; killFocused(): void }>();
