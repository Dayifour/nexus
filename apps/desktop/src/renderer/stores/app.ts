// État global de l'interface : langue, thème, réglages, diagnostics, et état de la coque (barre latérale,
// palette, dialogues). Les réglages viennent du main (`settings.get/set`) ; s'il ne les sert pas encore, la langue
// et le thème restent mémorisés localement (préférences non sensibles).
import { create } from "zustand";
import { toast } from "sonner";
import { call, isUnavailable } from "../api.ts";
import type { AppInfo, AppSettings, Capabilities, ProbeResult, Res } from "../types.ts";
import { done, failed, pending, readJsonPref, readPref, writeJsonPref, writePref } from "./util.ts";

export type Lang = "fr" | "en";
export type ThemePref = "dark" | "light" | "system";
export type SidebarView = "orchestra" | "explorer" | "search" | "scm" | "agents";
const SIDEBAR_VIEWS = new Set<string>(["orchestra", "explorer", "search", "scm", "agents"]);

interface UiPrefs {
  sidebarWidth: number;
  sidebarVisible: boolean;
  view: SidebarView;
}

const DEFAULT_UI: UiPrefs = { sidebarWidth: 280, sidebarVisible: true, view: "explorer" };
const storedUi = { ...DEFAULT_UI, ...readJsonPref<Partial<UiPrefs>>("nexus.ui") };
// Vue retirée (ex. l'ancienne vue « missions ») ou préférence corrompue : retour à l'explorateur.
if (!SIDEBAR_VIEWS.has(storedUi.view)) storedUi.view = DEFAULT_UI.view;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  language: "fr",
  defaultMode: "supervised",
  apiConnectors: [],
  voice: { cloudOptIn: false },
  sandboxExtraAllow: [],
};

interface AppState {
  lang: Lang;
  theme: ThemePref;
  resolvedTheme: "dark" | "light";
  info: Res<AppInfo>;
  capabilities: Res<Capabilities>;
  inventory: Res<ProbeResult[]>;
  settings: Res<AppSettings>;
  /** Faux tant que le main ne sert pas `settings.*` : les réglages sont alors locaux et partiels. */
  settingsServed: boolean;

  sidebarView: SidebarView;
  sidebarVisible: boolean;
  sidebarWidth: number;
  paletteOpen: boolean;
  quickOpenOpen: boolean;
  newSessionOpen: boolean;
  settingsDialogOpen: boolean;

  setLang(lang: Lang): void;
  setTheme(theme: ThemePref): void;
  loadInfo(): Promise<void>;
  loadDiagnostics(force?: boolean): Promise<void>;
  loadSettings(): Promise<void>;
  saveSettings(patch: Partial<AppSettings>): Promise<boolean>;

  showView(view: SidebarView): void;
  toggleSidebar(force?: boolean): void;
  /** Mode zen (Ctrl+K Z) : barres d'activité, latérale et d'état masquées. */
  zen: boolean;
  shortcutsDialogOpen: boolean;
  orchestraDialogOpen: boolean;
  setOrchestraDialogOpen(open: boolean): void;
  setShortcutsDialogOpen(open: boolean): void;
  setZen(on: boolean): void;
  setSidebarWidth(width: number): void;
  setPaletteOpen(open: boolean): void;
  setQuickOpenOpen(open: boolean): void;
  setNewSessionOpen(open: boolean): void;
  setSettingsDialogOpen(open: boolean): void;
}

const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : undefined;
/** Apparence de l'OS donnée par le main (événement `system-theme`) ; à défaut, `prefers-color-scheme`. */
let systemDark: boolean | undefined;
const resolve = (theme: ThemePref): "dark" | "light" =>
  theme === "system" ? ((systemDark ?? !media?.matches) ? "dark" : "light") : theme;

function applyTheme(resolved: "dark" | "light"): void {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function applyLang(lang: Lang): void {
  document.documentElement.lang = lang;
}

/** Premier lancement : langue du système (fr* → français, sinon anglais) ; ensuite le choix enregistré. */
function systemLang(): Lang {
  const lang = typeof navigator === "undefined" ? "" : (navigator.language ?? "");
  return lang.toLowerCase().startsWith("fr") ? "fr" : "en";
}
const storedLang = readPref("nexus.lang");
const initialLang: Lang = storedLang === "en" || storedLang === "fr" ? storedLang : systemLang();
const storedTheme = readPref("nexus.theme");
const initialTheme: ThemePref = storedTheme === "light" || storedTheme === "system" ? storedTheme : "dark";

function persistUi(s: Pick<AppState, "sidebarView" | "sidebarVisible" | "sidebarWidth">): void {
  writeJsonPref("nexus.ui", { view: s.sidebarView, sidebarVisible: s.sidebarVisible, sidebarWidth: s.sidebarWidth });
}

export const useAppStore = create<AppState>()((set, get) => ({
  lang: initialLang,
  theme: initialTheme,
  resolvedTheme: resolve(initialTheme),
  info: { loading: false },
  capabilities: { loading: false },
  inventory: { loading: false },
  settings: { loading: false },
  settingsServed: false,

  sidebarView: storedUi.view,
  sidebarVisible: storedUi.sidebarVisible,
  zen: false,
  shortcutsDialogOpen: false,
  orchestraDialogOpen: false,
  setOrchestraDialogOpen(open) {
    set({ orchestraDialogOpen: open });
  },
  setShortcutsDialogOpen(open) {
    set({ shortcutsDialogOpen: open });
  },
  setZen(on) {
    set({ zen: on });
  },
  sidebarWidth: Math.min(640, Math.max(180, storedUi.sidebarWidth)),
  paletteOpen: false,
  quickOpenOpen: false,
  newSessionOpen: false,
  settingsDialogOpen: false,

  setLang(lang) {
    writePref("nexus.lang", lang);
    applyLang(lang);
    set({ lang });
    if (get().settingsServed && get().settings.data?.language !== lang) void get().saveSettings({ language: lang });
  },
  setTheme(theme) {
    writePref("nexus.theme", theme);
    const resolved = resolve(theme);
    applyTheme(resolved);
    set({ theme, resolvedTheme: resolved });
    if (get().settingsServed && get().settings.data?.theme !== theme) void get().saveSettings({ theme });
  },
  async loadInfo() {
    set((s) => ({ info: pending(s.info) }));
    try {
      set({ info: done(await call("app.info", {})) });
    } catch (e) {
      set((s) => ({ info: failed(s.info, e) }));
    }
  },
  async loadDiagnostics(force = false) {
    const s0 = get();
    if (!force && (s0.inventory.data || s0.inventory.loading)) return;
    lastScan = Date.now();
    set((s) => ({ capabilities: pending(s.capabilities), inventory: pending(s.inventory) }));
    await Promise.all([
      call("app.capabilities", {}).then(
        (data) => set({ capabilities: done(data) }),
        (e: unknown) => set((s) => ({ capabilities: failed(s.capabilities, e) })),
      ),
      call("agents.inventory", {}).then(
        (data) => set({ inventory: done(data) }),
        (e: unknown) => set((s) => ({ inventory: failed(s.inventory, e) })),
      ),
    ]);
  },
  async loadSettings() {
    set((s) => ({ settings: pending(s.settings) }));
    try {
      const data = await call("settings.get", {});
      set({ settings: done(data), settingsServed: true });
      // Le main fait foi pour la langue et le thème une fois servis.
      if (data.language !== get().lang) {
        writePref("nexus.lang", data.language);
        applyLang(data.language);
        set({ lang: data.language });
      }
      if (data.theme !== get().theme) {
        writePref("nexus.theme", data.theme);
        const resolved = resolve(data.theme);
        applyTheme(resolved);
        set({ theme: data.theme, resolvedTheme: resolved });
      }
    } catch (e) {
      const local: AppSettings = { ...DEFAULT_SETTINGS, theme: get().theme, language: get().lang };
      set({
        settings: { data: local, error: isUnavailable(e) ? undefined : failed(undefined, e).error, loading: false },
      });
    }
  },
  async saveSettings(patch) {
    const current = get().settings.data ?? { ...DEFAULT_SETTINGS, theme: get().theme, language: get().lang };
    const next: AppSettings = { ...current, ...patch };
    set({ settings: { data: next, loading: false } });
    if (!get().settingsServed) return false;
    try {
      const saved = await call("settings.set", next);
      set({ settings: done(saved) });
      return true;
    } catch (e) {
      set({ settings: { data: current, loading: false, error: failed(undefined, e).error } });
      toast.error(failed(undefined, e).error?.message ?? "settings");
      return false;
    }
  },

  showView(view) {
    const s = get();
    // Cliquer sur l'icône de la vue déjà affichée replie la barre latérale (comme VS Code).
    const visible = s.sidebarView === view ? !s.sidebarVisible : true;
    set({ sidebarView: view, sidebarVisible: visible });
    persistUi({ ...get() });
  },
  toggleSidebar(force) {
    set((s) => ({ sidebarVisible: force ?? !s.sidebarVisible }));
    persistUi(get());
  },
  setSidebarWidth(width) {
    set({ sidebarWidth: Math.round(Math.min(640, Math.max(180, width))) });
    persistUi(get());
  },
  setPaletteOpen(open) {
    set({ paletteOpen: open, ...(open && { quickOpenOpen: false }) });
  },
  setQuickOpenOpen(open) {
    set({ quickOpenOpen: open, ...(open && { paletteOpen: false }) });
  },
  setNewSessionOpen(open) {
    set({ newSessionOpen: open, ...(open && { paletteOpen: false, quickOpenOpen: false }) });
  },
  setSettingsDialogOpen(open) {
    set({ settingsDialogOpen: open });
  },
}));

// Application immédiate (avant le premier rendu) et suivi du thème système.
applyTheme(resolve(initialTheme));
applyLang(initialLang);
function followSystemTheme(): void {
  const { theme } = useAppStore.getState();
  if (theme !== "system") return;
  const resolved = resolve(theme);
  applyTheme(resolved);
  useAppStore.setState({ resolvedTheme: resolved });
}
media?.addEventListener?.("change", () => {
  systemDark = undefined; // changement observé par le renderer lui-même : plus récent que le dernier envoi du main
  followSystemTheme();
});

/** Apparence de l'OS envoyée par le main pour le thème « Système ». */
export function setSystemAppearance(dark: boolean): void {
  systemDark = dark;
  followSystemTheme();
}

/** Délai minimal entre deux détections automatiques des agents (retour sur la fenêtre). */
const RESCAN_THROTTLE_MS = 30_000;
let lastScan = 0;

/**
 * Agents installés pendant que Nexus tourne (ex. `npm i -g @openai/codex` dans un terminal) : la détection est relancée
 * au retour sur la fenêtre, au plus une fois toutes les 30 s, et seulement si elle a déjà été faite.
 */
export function installInventoryRescan(): () => void {
  const onFocus = () => {
    const s = useAppStore.getState();
    if (!s.inventory.data || s.inventory.loading) return;
    const now = Date.now();
    if (now - lastScan < RESCAN_THROTTLE_MS) return;
    lastScan = now;
    void s.loadDiagnostics(true);
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}
