// Plan de travail ancrable (dockview) : TOUT contenu est un panneau qu'on peut déplacer, ancrer, scinder,
// redimensionner, empiler en onglets, agrandir ou rendre flottant. Les vues sont des composants React montés par
// portail dans les éléments créés par dockview. Les terminaux vivent par défaut dans le groupe ancré en bas (repliable
// avec Ctrl+`), mais peuvent être glissés n'importe où. La disposition est sauvegardée par projet (localStorage).
import {
  createDockview,
  themeDark,
  type DockviewApi,
  type DockviewGroupPanel,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type IDockviewPanel,
  type IGroupHeaderProps,
  type IHeaderActionsRenderer,
  type ITabRenderer,
  type IWatermarkRenderer,
  type SerializedDockview,
  type TabPartInitParameters,
  type WatermarkRendererInitParameters,
} from "dockview";
import { create } from "zustand";
import { tNow } from "../i18n/index.ts";
import { useEditorsStore } from "../stores/editors.ts";
import { terminalPanels } from "../stores/terminals.ts";
import { readJsonPref, readPref, writeJsonPref, writePref } from "../stores/util.ts";
import { toast } from "sonner";

export type PanelComponent =
  | "editor"
  | "diff"
  | "terminal"
  | "session"
  | "settings"
  | "usage"
  | "deployment"
  | "shortcuts"
  | "agentOutput"
  | "orchestra"
  | "log";

const KNOWN_COMPONENTS = new Set<string>([
  "editor",
  "diff",
  "terminal",
  "session",
  "settings",
  "usage",
  "deployment",
  "shortcuts",
  "agentOutput",
  "orchestra",
  "log",
] satisfies PanelComponent[]);

export interface PanelParams {
  path?: string;
  preview?: boolean;
  protected?: boolean;
  /** Éditeur sans titre (Ctrl+N) : `path` est alors une clé interne « untitled:N ». */
  untitled?: boolean;
  taskId?: string;
  missionId?: string;
  cwd?: string;
  label?: string;
  [key: string]: unknown;
}

// --- Registre des portails React --------------------------------------------------------------------------------

export interface PortalEntry {
  key: string;
  kind: "content" | "tab" | "actions" | "watermark";
  element: HTMLElement;
  component?: PanelComponent;
  panelId?: string;
  params: PanelParams;
  panel?: GroupPanelPartInitParameters;
  group?: DockviewGroupPanel;
}

export const usePortals = create<{ entries: Record<string, PortalEntry> }>()(() => ({ entries: {} }));

let portalSeq = 0;
const register = (entry: PortalEntry) =>
  usePortals.setState((s) => ({ entries: { ...s.entries, [entry.key]: entry } }));
const unregister = (key: string) =>
  usePortals.setState((s) => {
    const entries = { ...s.entries };
    delete entries[key];
    return { entries };
  });
const updateParams = (key: string, params: PanelParams) =>
  usePortals.setState((s) => {
    const prev = s.entries[key];
    if (!prev) return s;
    return { entries: { ...s.entries, [key]: { ...prev, params: { ...prev.params, ...params } } } };
  });

class ReactPart implements IContentRenderer, ITabRenderer {
  readonly element: HTMLElement;
  private readonly key = `p${++portalSeq}`;
  private disposeParams?: { dispose(): void };
  private readonly kind: "content" | "tab";
  private readonly component: PanelComponent;
  constructor(kind: "content" | "tab", component: PanelComponent) {
    this.kind = kind;
    this.component = component;
    this.element = document.createElement("div");
    this.element.className = kind === "content" ? "dv-react-content" : "dv-react-tab";
  }
  init(parameters: GroupPanelPartInitParameters | TabPartInitParameters): void {
    register({
      key: this.key,
      kind: this.kind,
      element: this.element,
      component: this.component,
      panelId: parameters.api.id,
      params: (parameters.params ?? {}) as PanelParams,
      panel: parameters,
    });
    this.disposeParams = parameters.api.onDidParametersChange((p) => updateParams(this.key, p as PanelParams));
  }
  update(event: { params: Partial<PanelParams> }): void {
    updateParams(this.key, event.params as PanelParams);
  }
  dispose(): void {
    this.disposeParams?.dispose();
    unregister(this.key);
  }
}

class ReactHeaderActions implements IHeaderActionsRenderer {
  readonly element = document.createElement("div");
  private readonly key = `a${++portalSeq}`;
  private readonly group: DockviewGroupPanel;
  constructor(group: DockviewGroupPanel) {
    this.group = group;
    this.element.className = "dv-react-actions";
  }
  init(_params: IGroupHeaderProps): void {
    register({ key: this.key, kind: "actions", element: this.element, params: {}, group: this.group });
  }
  dispose(): void {
    unregister(this.key);
  }
}

class ReactWatermark implements IWatermarkRenderer {
  readonly element = document.createElement("div");
  private readonly key = `w${++portalSeq}`;
  init(_params: WatermarkRendererInitParameters): void {
    this.element.className = "dv-react-watermark";
    register({ key: this.key, kind: "watermark", element: this.element, params: {} });
  }
  dispose(): void {
    unregister(this.key);
  }
}

// --- Instance et suivi du groupe principal ---------------------------------------------------------------------

let api: DockviewApi | undefined;
let currentProjectId: string | undefined;
let lastMainGroupId: string | undefined;
const BOTTOM_ID = "nexus-bottom";

/** Version observable de la disposition (pour les composants qui affichent l'état des panneaux). */
export const useDockState = create<{
  activePanelId?: string;
  bottomVisible: boolean;
  maximized: boolean;
  bottomMaximized: boolean;
  panelCount: number;
}>()(() => ({
  activePanelId: undefined,
  bottomVisible: false,
  maximized: false,
  bottomMaximized: false,
  panelCount: 0,
}));

export function getDock(): DockviewApi | undefined {
  return api;
}

const isEdge = (group: DockviewGroupPanel | undefined) => group?.api.location.type === "edge";

function mainGroup(): DockviewGroupPanel | undefined {
  if (!api) return undefined;
  const active = api.activeGroup;
  if (active && !isEdge(active) && active.api.location.type === "grid") return active;
  const last = lastMainGroupId ? api.groups.find((g) => g.id === lastMainGroupId) : undefined;
  if (last && !isEdge(last)) return last;
  return api.groups.find((g) => !isEdge(g) && g.api.location.type === "grid");
}

/**
 * Onglets du panneau bas EN HAUT, comme dans VS Code. dockview remet l'en-tête d'un groupe de bord du côté du bord
 * (donc en bas) à la restauration d'une disposition : on le corrige à chaque accès et après chaque restauration.
 */
function ensureTopHeader(): void {
  const edge = api?.getEdgeGroup("bottom");
  try {
    if (edge && edge.getHeaderPosition() !== "top") edge.setHeaderPosition("top");
  } catch {
    // groupe en cours d'initialisation
  }
}

function bottomGroup(create: boolean): DockviewGroupPanel | undefined {
  if (!api) return undefined;
  let edge = api.getEdgeGroup("bottom");
  if (!edge && create) {
    try {
      edge = api.addEdgeGroup("bottom", { id: BOTTOM_ID, initialSize: 280, minimumSize: 120 });
      // Onglets en haut du panneau inférieur, comme dans VS Code.
      edge.setHeaderPosition("top");
    } catch {
      edge = undefined;
    }
  }
  if (!edge) return undefined;
  ensureTopHeader();
  return api.groups.find((g) => g.id === edge.id) ?? (api.getGroup(edge.id) as DockviewGroupPanel | undefined);
}

function syncDockState(): void {
  if (!api) return;
  let bottomVisible = false;
  try {
    bottomVisible = Boolean(api.getEdgeGroup("bottom")) && api.isEdgeGroupVisible("bottom");
  } catch {
    bottomVisible = false;
  }
  useDockState.setState({
    activePanelId: api.activePanel?.id,
    bottomVisible,
    maximized: api.hasMaximizedGroup(),
    panelCount: api.totalPanels,
  });
}

// --- Persistance par projet -------------------------------------------------------------------------------------

const layoutKey = (projectId: string) => `nexus.layout.${projectId}`;
/** Version du format de disposition : une disposition plus ancienne (ou illisible) est remplacée par celle par défaut. */
const LAYOUT_VERSION = 3;
interface StoredLayout {
  v: number;
  layout: SerializedDockview;
}
/** Contenus propres au panneau bas (terminaux, sortie de l'agent, journal) : jamais dans la zone d'édition par défaut. */
const UTILITY_COMPONENTS = new Set<string>(["settings", "usage", "shortcuts"]);
export const BOTTOM_COMPONENTS = new Set<string>(["terminal", "agentOutput", "log"]);
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function sanitizeLayout(layout: SerializedDockview): SerializedDockview {
  // Un PTY ne survit pas au redémarrage : seul le terminal (dossier, nom) est restauré, avec un nouveau shell.
  const panels: SerializedDockview["panels"] = {};
  for (const [id, p] of Object.entries(layout.panels)) {
    const params = { ...p.params };
    delete params.terminalId;
    delete params.attachTerminalId;
    panels[id] = { ...p, params };
  }
  return { ...layout, panels };
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!api || !currentProjectId) return;
    try {
      writeJsonPref(layoutKey(currentProjectId), {
        v: LAYOUT_VERSION,
        layout: sanitizeLayout(api.toJSON()),
      } satisfies StoredLayout);
    } catch {
      // Disposition non sérialisable : ignorée.
    }
  }, 400);
}

// --- Fermeture avec confirmation (fichiers modifiés) ----------------------------------------------------------

type CloseGuard = (panel: IDockviewPanel) => Promise<boolean>;
let closeGuard: CloseGuard = async () => true;
export function setCloseGuard(guard: CloseGuard): void {
  closeGuard = guard;
}

export async function requestClose(panel: IDockviewPanel): Promise<boolean> {
  if (!(await closeGuard(panel))) return false;
  panel.api.close();
  return true;
}

async function closeMany(panels: IDockviewPanel[]): Promise<void> {
  for (const p of panels) if (!(await requestClose(p))) return;
}

export type MenuEntry = { label: string; action: () => void; disabled?: boolean } | "separator";

/** Entrées du menu contextuel d'un onglet (rendu par Radix dans l'onglet React). */
export function tabMenuItems(panelId: string): MenuEntry[] {
  const panel = api?.getPanel(panelId);
  if (!panel) return [];
  const group = panel.group;
  const others = group.panels.filter((p) => p.id !== panel.id);
  const idx = group.panels.findIndex((p) => p.id === panel.id);
  const right = group.panels.slice(idx + 1);
  const path = (panel.params as PanelParams | undefined)?.path;
  const items: MenuEntry[] = [
    { label: tNow("dock.close"), action: () => void requestClose(panel) },
    { label: tNow("dock.closeOthers"), action: () => void closeMany(others), disabled: others.length === 0 },
    { label: tNow("dock.closeRight"), action: () => void closeMany(right), disabled: right.length === 0 },
    { label: tNow("dock.closeAll"), action: () => void closeMany([...group.panels]) },
    "separator",
    { label: tNow("dock.splitRight"), action: () => splitPanel(panel, "right") },
    { label: tNow("dock.splitDown"), action: () => splitPanel(panel, "bottom") },
    {
      label: api?.hasMaximizedGroup() ? tNow("dock.restore") : tNow("dock.maximize"),
      action: () => toggleMaximize(panel),
    },
    { label: tNow("dock.float"), action: () => api?.addFloatingGroup(panel) },
  ];
  if (path) {
    items.push("separator", {
      label: tNow("dock.copyPath"),
      action: () => void navigator.clipboard?.writeText(path).catch(() => {}),
    });
  }
  return items;
}

// --- Montage ---------------------------------------------------------------------------------------------------

// --- Historique : onglets récemment utilisés (Ctrl+Tab) et récemment fermés (Ctrl+Maj+T) -----------------------

/** Identifiants des panneaux, du plus récemment activé au plus ancien. */
let mru: string[] = [];
/** Parcours Ctrl+Tab en cours (tant que la touche Ctrl/Cmd reste enfoncée) : ordre figé au début du parcours. */
let mruCycle: { order: string[]; index: number } | undefined;
interface ClosedPanel {
  id: string;
  component: PanelComponent;
  title: string;
  params: PanelParams;
}
let closedStack: ClosedPanel[] = [];
/** Fermetures en masse (changement de projet, nettoyage) : non mémorisées pour Ctrl+Maj+T. */
let recordClosed = true;

function touchMru(id: string | undefined): void {
  if (!id || mruCycle) return;
  mru = [id, ...mru.filter((x) => x !== id)].slice(0, 100);
}

export function mountDock(element: HTMLElement, projectId: string): () => void {
  api?.dispose();
  currentProjectId = projectId;
  lastMainGroupId = undefined;
  mru = [];
  mruCycle = undefined;
  closedStack = [];
  const dock = createDockview(element, {
    theme: { ...themeDark, name: "nexus", className: "dockview-theme-nexus" },
    createComponent: ({ name }) => new ReactPart("content", name as PanelComponent),
    createTabComponent: ({ name }) => new ReactPart("tab", name as PanelComponent),
    defaultTabComponent: "editor",
    createRightHeaderActionComponent: (group) => new ReactHeaderActions(group),
    createWatermarkComponent: () => new ReactWatermark(),
    popoutUrl: undefined,
    disableFloatingGroups: false,
    singleTabMode: "default",
    scrollbars: "custom",
  });
  // Les onglets utilisent tous le même rendu React (icône, état modifié, aperçu en italique).
  api = dock;

  const subs = [
    dock.onDidLayoutChange(() => {
      scheduleSave();
      syncDockState();
    }),
    dock.onDidActiveGroupChange((g) => {
      if (g && !isEdge(g) && g.api.location.type === "grid") lastMainGroupId = g.id;
      syncDockState();
    }),
    dock.onDidActivePanelChange((p) => {
      touchMru(p?.panel?.id);
      syncDockState();
    }),
    dock.onDidMaximizedGroupChange(() => syncDockState()),
    // Le panneau bas n'accueille que terminaux, sortie de l'agent et journal : un éditeur ou une session glissés
    // dessus restent dans la zone d'édition (pas d'onglets de fichiers coincés en bas).
    dock.onWillDrop((e) => {
      const data = e.getData();
      const dragged = data?.panelId ? dock.getPanel(data.panelId) : undefined;
      const target = e.group;
      if (target && isEdge(target) && dragged && !BOTTOM_COMPONENTS.has(dragged.api.component)) e.preventDefault();
    }),
    dock.onDidMovePanel((e) => {
      const panel = e.panel;
      if (isEdge(panel.group) && !BOTTOM_COMPONENTS.has(panel.api.component)) {
        queueMicrotask(() => {
          const main = gridGroups()[0];
          try {
            panel.api.moveTo({ group: main ?? dock.addGroup({ direction: "left" }) });
          } catch {
            // disposition en cours de reconstruction : ignoré
          }
        });
      }
    }),
    dock.onDidRemovePanel((panel) => {
      const params = panel.params as PanelParams | undefined;
      mru = mru.filter((x) => x !== panel.id);
      // Un terminal (PTY terminé) ou un document sans titre ne se « rouvre » pas.
      const component = panel.api.component as PanelComponent;
      if (recordClosed && KNOWN_COMPONENTS.has(component) && component !== "terminal" && !params?.untitled) {
        closedStack = [
          ...closedStack.filter((c) => c.id !== panel.id),
          { id: panel.id, component, title: panel.title ?? panel.id, params: { ...params } },
        ].slice(-30);
      }
      if (panel.api.component === "editor" && params?.path) {
        const stillOpen = dock.panels.some(
          (p) =>
            p.id !== panel.id &&
            (p.params as PanelParams | undefined)?.path === params.path &&
            p.api.component === "editor",
        );
        if (!stillOpen) useEditorsStore.getState().release(params.path);
      }
    }),
  ];

  const stored = readJsonPref<StoredLayout | SerializedDockview>(layoutKey(projectId));
  // Ancien onglet « Architecture » (retiré) : notification unique pointant vers Déploiement.
  if (stored && JSON.stringify(stored).includes('"architecture"')) setTimeout(notifyArchitectureRemoved, 0);
  // Ancien format (sans version) ou version différente : disposition par défaut, sans erreur.
  const saved = stored && "v" in stored && stored.v === LAYOUT_VERSION ? stored.layout : undefined;
  if (saved) {
    try {
      dock.fromJSON(saved);
      // Vues retirées et éditeurs sans titre (contenu non enregistré, non persisté) ne sont pas restaurés.
      // Vues utilitaires (réglages, publication, consommation…) : jamais rouvertes automatiquement au démarrage.
      // Terminaux d'agent : leur PTY n'a pas survécu au redémarrage ; les restaurer afficherait un faux terminal
      // d'agent (un shell ordinaire). La session se rouvre depuis la liste (« Reprendre dans le terminal »).
      const stale = dock.panels.filter(
        (p) =>
          !KNOWN_COMPONENTS.has(p.api.component) ||
          UTILITY_COMPONENTS.has(p.api.component) ||
          p.id.startsWith("agent-term:") ||
          (p.params as PanelParams | undefined)?.untitled,
      );
      recordClosed = false;
      for (const p of stale) p.api.close();
      recordClosed = true;
      ensureTopHeader();
      // Contenus du panneau bas restés dans la grille (anciennes dispositions) : ramenés dans le panneau bas.
      const strays = dock.panels.filter((p) => BOTTOM_COMPONENTS.has(p.api.component) && !isEdge(p.group));
      if (strays.length > 0) {
        const bottom = bottomGroup(true);
        if (bottom) for (const p of strays) p.api.moveTo({ group: bottom });
      }
    } catch {
      recordClosed = false;
      dock.clear();
      recordClosed = true;
    }
  }
  syncDockState();

  return () => {
    if (saveTimer) clearTimeout(saveTimer);
    try {
      writeJsonPref(layoutKey(projectId), {
        v: LAYOUT_VERSION,
        layout: sanitizeLayout(dock.toJSON()),
      } satisfies StoredLayout);
    } catch {
      // ignoré
    }
    for (const s of subs) s.dispose();
    dock.dispose();
    if (api === dock) api = undefined;
    usePortals.setState({ entries: {} });
  };
}

const ARCHITECTURE_NOTICE = "nexus.notice.architectureRemoved";
function notifyArchitectureRemoved(): void {
  if (readPref(ARCHITECTURE_NOTICE)) return;
  writePref(ARCHITECTURE_NOTICE, "1");
  toast.info(tNow("dock.architectureRemoved"), {
    id: ARCHITECTURE_NOTICE,
    duration: 15_000,
    action: { label: tNow("dock.openDeployment"), onClick: () => openView("deployment") },
  });
}

// --- Ouverture de contenus -------------------------------------------------------------------------------------

function addToMain(options: {
  id: string;
  component: PanelComponent;
  title: string;
  params: PanelParams;
  renderer?: "always" | "onlyWhenVisible";
  inactive?: boolean;
}): IDockviewPanel | undefined {
  if (!api) return undefined;
  const group = mainGroup();
  return api.addPanel({
    id: options.id,
    component: options.component,
    tabComponent: options.component,
    title: options.title,
    params: options.params,
    renderer: options.renderer ?? "onlyWhenVisible",
    inactive: options.inactive ?? false,
    ...(group ? { position: { referenceGroup: group } } : {}),
  });
}

const fileName = (path: string) => path.split("/").pop() ?? path;

export function openFile(path: string, opts: { preview?: boolean; protected?: boolean } = {}): void {
  if (!api) return;
  const preview = opts.preview ?? true;
  const id = `editor:${path}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    if (!preview && (existing.params as PanelParams | undefined)?.preview)
      existing.api.updateParameters({ preview: false });
    return;
  }
  // Aperçu : l'onglet d'aperçu non modifié du groupe est remplacé (comme dans VS Code).
  if (preview) {
    const group = mainGroup();
    const previewPanel = group?.panels.find(
      (p) =>
        p.api.component === "editor" &&
        (p.params as PanelParams | undefined)?.preview &&
        !useEditorsStore.getState().docs[(p.params as PanelParams).path ?? ""]?.dirty,
    );
    if (previewPanel && group) {
      const index = group.panels.indexOf(previewPanel);
      const panel = api.addPanel({
        id,
        component: "editor",
        tabComponent: "editor",
        title: fileName(path),
        params: { path, preview: true, protected: opts.protected ?? false },
        position: { referenceGroup: group, index },
      });
      // Aperçu remplacé (pas une fermeture demandée) : non mémorisé pour Ctrl+Maj+T.
      recordClosed = false;
      previewPanel.api.close();
      recordClosed = true;
      panel.api.setActive();
      return;
    }
  }
  addToMain({
    id,
    component: "editor",
    title: fileName(path),
    params: { path, preview, protected: opts.protected ?? false },
  });
}

export function pinPanel(panelId: string): void {
  const panel = api?.getPanel(panelId);
  if (panel && (panel.params as PanelParams | undefined)?.preview) panel.api.updateParameters({ preview: false });
}

export function openDiff(path: string, taskId?: string): void {
  if (!api) return;
  const id = `diff:${taskId ?? "work"}:${path}`;
  const existing = api.getPanel(id);
  if (existing) return existing.api.setActive();
  addToMain({ id, component: "diff", title: `${fileName(path)} ↔`, params: { path, taskId } });
}

let terminalSeq = 0;

export function openTerminal(opts: { cwd?: string; label?: string; split?: boolean } = {}): void {
  if (!api) return;
  const id = `terminal:${Date.now().toString(36)}${++terminalSeq}`;
  const count = api.panels.filter((p) => p.api.component === "terminal").length;
  const title = opts.label ?? (count === 0 ? tNow("term.title") : `${tNow("term.title")} ${count + 1}`);
  // Scinder : un second volet dans l'onglet terminal actif (ou le dernier du panneau bas), jamais dans l'éditeur.
  if (opts.split) {
    const active = api.activePanel?.api.component === "terminal" ? api.activePanel : undefined;
    const target = active ?? bottomGroup(false)?.activePanel;
    const ctrl = target ? terminalPanels.get(target.id) : undefined;
    if (target && ctrl) {
      showBottom();
      target.api.setActive();
      ctrl.split();
      return;
    }
  }
  const bottom = bottomGroup(true);
  if (bottom) {
    try {
      api.setEdgeGroupVisible("bottom", true);
    } catch {
      // ignoré
    }
  }
  api.addPanel({
    id,
    component: "terminal",
    tabComponent: "terminal",
    title,
    params: { cwd: opts.cwd, label: opts.label },
    renderer: "always",
    ...(bottom ? { position: { referenceGroup: bottom } } : { position: { direction: "below" } }),
  });
  syncDockState();
}

/** Affiche le panneau bas (s'il existe). */
function showBottom(): void {
  if (!api) return;
  try {
    if (api.getEdgeGroup("bottom")) api.setEdgeGroupVisible("bottom", true);
  } catch {
    // ignoré
  }
}

/** Agrandir / restaurer le panneau bas (hauteur presque totale de la zone de travail). */
let bottomHeightBeforeMax: number | undefined;
export function toggleBottomMaximize(): void {
  if (!api) return;
  const edge = api.getEdgeGroup("bottom");
  if (!edge) return;
  showBottom();
  if (bottomHeightBeforeMax !== undefined) {
    edge.setSize({ height: bottomHeightBeforeMax });
    bottomHeightBeforeMax = undefined;
  } else {
    bottomHeightBeforeMax = edge.height;
    edge.setSize({ height: Math.max(200, api.height - 90) });
  }
  useDockState.setState({ bottomMaximized: bottomHeightBeforeMax !== undefined });
}

/** Corbeille du panneau bas : ferme le volet focalisé du terminal actif (ou l'onglet actif du panneau). */
export function killActiveTerminal(): void {
  const group = bottomGroup(false);
  const panel = api?.activePanel?.api.component === "terminal" ? api.activePanel : group?.activePanel;
  if (!panel) return;
  const ctrl = terminalPanels.get(panel.id);
  if (ctrl) ctrl.killFocused();
  else panel.api.close();
}

/** Panneau bas : « Sortie de l'agent » ou « Journal » (onglet unique, réactivé s'il existe). */
export function openBottomView(component: "agentOutput" | "log"): void {
  if (!api) return;
  const id = `bottom:${component}`;
  const existing = api.getPanel(id);
  const bottom = bottomGroup(true);
  showBottom();
  if (existing) {
    if (bottom && !isEdge(existing.group)) existing.api.moveTo({ group: bottom });
    existing.api.setActive();
  } else {
    api.addPanel({
      id,
      component,
      tabComponent: component,
      title: tNow(component === "log" ? "bottom.log" : "bottom.agentOutput"),
      params: {},
      renderer: "onlyWhenVisible",
      ...(bottom ? { position: { referenceGroup: bottom } } : { position: { direction: "below" } }),
    });
  }
  syncDockState();
}

/** Session interactive : le terminal de l'agent (PTY du main) s'ouvre comme onglet du panneau bas. */
export function openAgentTerminal(opts: {
  terminalId: string;
  title: string;
  cwd?: string;
  taskId: string;
  agent?: string;
  inactive?: boolean;
}): void {
  if (!api) return;
  const title = (opts.agent ? `${opts.agent} · ${opts.title}` : opts.title).slice(0, 80);
  const id = `agent-term:${opts.taskId}`;
  const existing = api.getPanel(id);
  if (existing) {
    // Même PTY : on réactive l'onglet, sans créer de terminal.
    if ((existing.params as PanelParams | undefined)?.attachTerminalId === opts.terminalId)
      return existing.api.setActive();
    // Nouveau PTY (session reprise) : l'ancien onglet, rattaché à un terminal terminé, est remplacé.
    existing.api.close();
  }
  const bottom = bottomGroup(true);
  showBottom();
  api.addPanel({
    id,
    component: "terminal",
    tabComponent: "terminal",
    title,
    params: { attachTerminalId: opts.terminalId, cwd: opts.cwd, label: title, taskId: opts.taskId },
    renderer: "always",
    inactive: opts.inactive ?? false,
    ...(bottom ? { position: { referenceGroup: bottom } } : { position: { direction: "below" } }),
  });
  syncDockState();
}

/** Ctrl+` : affiche ou masque le panneau inférieur (crée un terminal s'il est vide). */
export function toggleBottomPanel(): void {
  if (!api) return;
  const edge = api.getEdgeGroup("bottom");
  const visible = edge ? api.isEdgeGroupVisible("bottom") : false;
  if (edge && visible) {
    api.setEdgeGroupVisible("bottom", false);
    mainGroup()?.activePanel?.api.setActive();
  } else {
    const group = bottomGroup(true);
    if (!group || group.panels.length === 0) {
      openTerminal();
    } else {
      api.setEdgeGroupVisible("bottom", true);
      group.activePanel?.api.setActive();
    }
  }
  syncDockState();
}

export function openSession(taskId: string, title: string): void {
  if (!api) return;
  const id = `session:${taskId}`;
  const existing = api.getPanel(id);
  if (existing) return existing.api.setActive();
  addToMain({ id, component: "session", title, params: { taskId }, renderer: "always" });
}

/**
 * Comparaison d'agents : une colonne par agent, côte à côte dans la zone principale. En mode Terminal, ce sont les
 * terminaux des agents (TUI) qui sont alignés en colonnes — pas des onglets empilés dans le panneau bas — pour suivre
 * les agents d'un même coup d'œil ; en mode Conversation, leurs panneaux de session.
 */
export function openSideBySide(
  items: Array<{ taskId: string; title: string; terminalId?: string; cwd?: string }>,
): void {
  if (!api) return;
  // Disposition : colonnes (≤ 3 agents et assez de largeur), grille 2×N au-delà ou si la zone est moyenne, onglets
  // d'un même groupe si elle est étroite — jamais 6 colonnes écrasées.
  const width = api.width || window.innerWidth;
  const n = items.length;
  const cols = n <= 3 && width / n >= 380 ? n : width >= 760 ? 2 : 1;
  const placed: IDockviewPanel[] = [];
  items.forEach((it, i) => {
    if (!api) return;
    const asTerminal = Boolean(it.terminalId);
    const id = asTerminal ? `agent-term:${it.taskId}` : `session:${it.taskId}`;
    const existing = api.getPanel(id);
    // Même PTY déjà affiché : l'onglet est déplacé dans la grille (le fermer tuerait l'agent).
    if (existing && asTerminal && (existing.params as PanelParams | undefined)?.attachTerminalId === it.terminalId) {
      const first = placed[0];
      try {
        if (!first) existing.api.moveTo({ group: mainGroup() ?? api.addGroup({ direction: "left" }) });
        else
          existing.api.moveTo({ group: api.addGroup({ referencePanel: placed[i - 1] ?? first, direction: "right" }) });
      } catch {
        // disposition en cours de reconstruction : l'onglet reste où il est
      }
      placed.push(existing);
      return;
    }
    existing?.api.close();
    const title = it.title.slice(0, 80);
    const common = {
      id,
      component: (asTerminal ? "terminal" : "session") as PanelComponent,
      tabComponent: asTerminal ? "terminal" : "session",
      title,
      renderer: "always" as const,
      params: (asTerminal
        ? { attachTerminalId: it.terminalId, cwd: it.cwd, label: title, taskId: it.taskId }
        : { taskId: it.taskId }) satisfies PanelParams,
    };
    const first = placed[0];
    let panel: IDockviewPanel | undefined;
    if (!first) panel = addToMain(common);
    else if (cols === 1) panel = api.addPanel({ ...common, position: { referenceGroup: first.group } });
    else if (i % cols !== 0) {
      const left = placed[i - 1] ?? first;
      panel = api.addPanel({ ...common, position: { referencePanel: left, direction: "right" } });
    } else {
      const above = placed[i - cols] ?? first;
      panel = api.addPanel({ ...common, position: { referencePanel: above, direction: "below" } });
    }
    if (panel) placed.push(panel);
  });
  placed[0]?.api.setActive();
  syncDockState();
}

/** Vue Orchestre d'une mission (onglet de la zone d'édition, toujours montée pour garder le fil et le graphe). */
export function openOrchestra(missionId: string, title: string): void {
  if (!api) return;
  const id = `orchestra:${missionId}`;
  const existing = api.getPanel(id);
  if (existing) return existing.api.setActive();
  addToMain({ id, component: "orchestra", title: title.slice(0, 60), params: { missionId }, renderer: "always" });
}

export function openView(component: "settings" | "usage" | "deployment" | "shortcuts"): void {
  if (!api) return;
  const id = `view:${component}`;
  const existing = api.getPanel(id);
  if (existing) return existing.api.setActive();
  addToMain({ id, component, title: tNow(`view.${component}`), params: {} });
}

// --- Actions sur le panneau actif ------------------------------------------------------------------------------

export function activePanel(): IDockviewPanel | undefined {
  return api?.activePanel;
}

export function splitPanel(
  panel: IDockviewPanel | undefined = api?.activePanel,
  direction: "right" | "bottom" = "right",
): void {
  if (!api || !panel) return;
  // Panneau bas : on scinde le terminal (second volet), jamais un groupe d'éditeurs partiel en bas.
  if (isEdge(panel.group)) {
    terminalPanels.get(panel.id)?.split();
    return;
  }
  const params = panel.params as PanelParams | undefined;
  // Un éditeur scindé ouvre une seconde vue du même fichier (même modèle Monaco) ; les autres panneaux sont déplacés.
  if (panel.api.component === "editor" && params?.path) {
    const id = `editor:${params.path}#${Date.now().toString(36)}`;
    api.addPanel({
      id,
      component: "editor",
      tabComponent: "editor",
      title: panel.title ?? fileName(params.path),
      params: { ...params, preview: false },
      position: { referencePanel: panel, direction: direction === "right" ? "right" : "below" },
    });
    return;
  }
  const group = api.addGroup({ referenceGroup: panel.group, direction: direction === "right" ? "right" : "below" });
  panel.api.moveTo({ group });
}

export function toggleMaximize(panel: IDockviewPanel | undefined = api?.activePanel): void {
  if (!api || !panel) return;
  if (isEdge(panel.group)) return toggleBottomMaximize();
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  else api.maximizeGroup(panel);
  syncDockState();
}

/** Groupe suivant : groupes de la zone d'édition de gauche à droite, puis le panneau bas s'il est visible. */
export function focusNextGroup(): void {
  if (!api) return;
  const groups = [...gridGroups()];
  const bottom = bottomGroup(false);
  if (bottom && api.isEdgeGroupVisible("bottom") && bottom.panels.length > 0) groups.push(bottom);
  if (groups.length < 2) return;
  const idx = groups.findIndex((g) => g.id === api?.activeGroup?.id);
  const next = groups[(idx + 1) % groups.length];
  (next?.activePanel ?? next?.panels[0])?.api.setActive();
}

/** Ferme tous les terminaux et éditeurs (changement de projet). */
export function resetLayout(): void {
  recordClosed = false;
  try {
    api?.clear();
  } finally {
    recordClosed = true;
  }
  syncDockState();
}

/** « Réinitialiser la disposition » : onglets de la zone d'édition gardés, groupes fusionnés, panneau bas remis à zéro. */
export function resetLayoutToDefault(): void {
  if (!api) return;
  const keep = api.panels
    .filter((p) => !BOTTOM_COMPONENTS.has(p.api.component) && !(p.params as PanelParams | undefined)?.untitled)
    .map((p) => ({
      id: p.id,
      component: p.api.component as PanelComponent,
      title: p.title ?? p.id,
      params: { ...(p.params as PanelParams) },
    }));
  const terminals = api.panels.filter((p) => p.api.component === "terminal");
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  // Terminaux en cours conservés : ramenés dans le panneau bas, les autres contenus rouverts dans un seul groupe.
  const bottom = bottomGroup(true);
  if (bottom) for (const t of terminals) if (!isEdge(t.group)) t.api.moveTo({ group: bottom });
  recordClosed = false;
  for (const p of api.panels.filter((x) => !BOTTOM_COMPONENTS.has(x.api.component))) p.api.close();
  for (const g of api.groups.filter((g) => !isEdge(g) && g.panels.length === 0 && g.api.location.type !== "grid"))
    g.api.close();
  recordClosed = true;
  for (const p of keep)
    addToMain({ ...p, renderer: p.component === "session" ? "always" : "onlyWhenVisible", inactive: true });
  api.panels.find((p) => !isEdge(p.group))?.api.setActive();
  if (currentProjectId) scheduleSave();
  syncDockState();
}

// --- Navigation au clavier entre onglets et groupes (raccourcis façon VS Code) ---------------------------------

/** Groupes de la grille principale (hors panneau inférieur et fenêtres flottantes), de gauche à droite. */
function gridGroups(): DockviewGroupPanel[] {
  if (!api) return [];
  const pos = (g: DockviewGroupPanel) => {
    const r = g.element.getBoundingClientRect();
    return [r.left, r.top] as const;
  };
  return api.groups
    .filter((g) => !isEdge(g) && g.api.location.type === "grid")
    .sort((a, b) => {
      const [ax, ay] = pos(a);
      const [bx, by] = pos(b);
      return Math.abs(ax - bx) > 4 ? ax - bx : ay - by;
    });
}

/** Ctrl+W : ferme l'onglet actif (éditeur, diff, session, réglages, terminal…). */
export function closeActive(): void {
  const panel = api?.activePanel;
  if (panel) void requestClose(panel);
}

/** Ctrl+K Ctrl+W : ferme tous les onglets du groupe actif (confirmation pour les fichiers modifiés). */
export function closeGroupPanels(): void {
  const group = api?.activeGroup;
  if (group) void closeMany([...group.panels]);
}

/** Ctrl+Maj+T : rouvre le dernier onglet fermé. */
export function reopenClosed(): boolean {
  if (!api) return false;
  while (closedStack.length > 0) {
    const last = closedStack.pop();
    if (!last) break;
    const existing = api.getPanel(last.id);
    if (existing) {
      existing.api.setActive();
      return true;
    }
    addToMain({
      id: last.id,
      component: last.component,
      title: last.title,
      params: last.params,
      renderer: last.component === "session" ? "always" : "onlyWhenVisible",
    });
    return true;
  }
  return false;
}

/** Ctrl+Tab / Ctrl+Maj+Tab : onglets dans l'ordre d'utilisation récente (parcours tant que Ctrl est tenu). */
export function cycleRecent(direction: 1 | -1): void {
  if (!api) return;
  const open = new Set(api.panels.map((p) => p.id));
  if (!mruCycle) {
    const order = mru.filter((id) => open.has(id));
    for (const p of api.panels) if (!order.includes(p.id)) order.push(p.id);
    if (order.length < 2) return;
    mruCycle = { order, index: 0 };
  }
  const { order } = mruCycle;
  mruCycle.index = (mruCycle.index + direction + order.length) % order.length;
  const target = api.getPanel(order[mruCycle.index] ?? "");
  target?.api.setActive();
}

/** Fin du parcours Ctrl+Tab (touche Ctrl relâchée) : l'onglet atteint devient le plus récent. */
export function endRecentCycle(): void {
  if (!mruCycle) return;
  mruCycle = undefined;
  touchMru(api?.activePanel?.id);
}

/** Ctrl+PgDn / Ctrl+PgUp : onglet suivant / précédent du groupe actif (circulaire). */
export function cycleInGroup(direction: 1 | -1): void {
  const group = api?.activeGroup;
  if (!group || group.panels.length < 2) return;
  const idx = group.panels.findIndex((p) => p.id === group.activePanel?.id);
  group.panels[(idx + direction + group.panels.length) % group.panels.length]?.api.setActive();
}

/** Alt+1…9 : n-ième onglet du groupe actif (9 = le dernier). */
export function goToTab(n: number): void {
  const group = api?.activeGroup;
  if (!group || group.panels.length === 0) return;
  const panel = n >= 9 ? group.panels[group.panels.length - 1] : group.panels[n - 1];
  panel?.api.setActive();
}

/** Ctrl+1/2/3 : focus du n-ième groupe ; le groupe suivant inexistant est créé en scindant l'onglet actif. */
export function focusGroup(n: number): void {
  if (!api) return;
  const groups = gridGroups();
  const target = groups[n - 1];
  if (target) {
    (target.activePanel ?? target.panels[0])?.api.setActive();
    if (!target.activePanel) target.api.setActive();
    return;
  }
  const active = api.activePanel;
  if (n === groups.length + 1 && active && !isEdge(active.group)) splitPanel(active, "right");
}

/** Ctrl+K ← / → : déplace l'onglet actif vers le groupe voisin (créé s'il n'existe pas). */
export function moveToNeighborGroup(direction: "left" | "right"): void {
  if (!api) return;
  const panel = api.activePanel;
  if (!panel || isEdge(panel.group)) return;
  const groups = gridGroups();
  const idx = groups.findIndex((g) => g.id === panel.group.id);
  const neighbor = groups[direction === "left" ? idx - 1 : idx + 1];
  if (neighbor) {
    panel.api.moveTo({ group: neighbor });
  } else {
    if (panel.group.panels.length < 2) return; // seul dans son groupe : rien à déplacer
    const group = api.addGroup({ referenceGroup: panel.group, direction });
    panel.api.moveTo({ group });
  }
  panel.api.setActive();
}

/** Mode zen : masque le panneau inférieur (les barres sont masquées par le plan de travail). */
let bottomBeforeZen = false;
export function setZenDock(on: boolean): void {
  if (!api) return;
  try {
    if (on) {
      bottomBeforeZen = Boolean(api.getEdgeGroup("bottom")) && api.isEdgeGroupVisible("bottom");
      if (bottomBeforeZen) api.setEdgeGroupVisible("bottom", false);
      if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
    } else if (bottomBeforeZen && api.getEdgeGroup("bottom")) {
      api.setEdgeGroupVisible("bottom", true);
    }
  } catch {
    // panneau inférieur absent
  }
  syncDockState();
}

let untitledSeq = 0;
/** Ctrl+N : nouvel éditeur sans titre (enregistré sous un chemin choisi au premier Ctrl+S). */
export function openUntitled(key: string): void {
  if (!api) return;
  untitledSeq += 1;
  addToMain({
    id: `editor:${key}`,
    component: "editor",
    title: `${tNow("editor.untitled")}-${untitledSeq}`,
    params: { path: key, preview: false, untitled: true },
  });
}

/** Remplace un onglet sans titre par l'éditeur du fichier enregistré. */
export function replaceUntitled(key: string, path: string): void {
  if (!api) return;
  const panel = api.getPanel(`editor:${key}`);
  const existing = api.getPanel(`editor:${path}`);
  if (existing) existing.api.close();
  const group = panel?.group;
  const index = group ? group.panels.indexOf(panel) : undefined;
  api.addPanel({
    id: `editor:${path}`,
    component: "editor",
    tabComponent: "editor",
    title: fileName(path),
    params: { path, preview: false, protected: false },
    ...(group ? { position: { referenceGroup: group, index } } : {}),
  });
  panel?.api.close();
}
