// Registre unique des commandes : la palette (Ctrl+Maj+P), les raccourcis clavier et les menus puisent ici.
import {
  ArrowLeftToLine,
  Orbit,
  CircleStop,
  GitCommitHorizontal,
  GitPullRequest,
  ChevronsUp,
  LayoutTemplate,
  ScrollText,
  Trash2,
  ChevronsDownUp,
  LocateFixed,
  ArrowRightLeft,
  ArrowRightToLine,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Eraser,
  FilePlus2,
  Keyboard,
  Maximize,
  SaveAll,
  Undo2,
  Bot,
  Columns2,
  Command as CommandIcon,
  FilePlus,
  FileSearch,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Languages,
  LayoutPanelLeft,
  CloudUpload,
  Gauge,
  Maximize2,
  Moon,
  OctagonX,
  PanelBottom,
  PanelLeft,
  RefreshCw,
  Save,
  Search,
  Settings,
  SquareTerminal,
  Sun,
  Monitor,
  Upload,
  X,
  Archive,
  LogOut,
  Files,
  type LucideIcon,
} from "lucide-react";
import type { TKey } from "../i18n/index.ts";
import { useAppStore } from "../stores/app.ts";
import { useFilesStore } from "../stores/files.ts";
import { useGitStore } from "../stores/git.ts";
import { useProjectStore } from "../stores/project.ts";
import { usePrDialog } from "../overlays/CreatePrDialog.tsx";
import { ACTIVE_STATUSES, useSessionsStore } from "../stores/sessions.ts";
import { canResume, deleteSession, openSessionTerminal, resumeSessionTerminal } from "./agent-terminal.ts";
import { terminalControls, type TerminalControls } from "../stores/terminals.ts";
import { isMac } from "./shortcuts.ts";
import {
  activePanel,
  closeActive,
  closeGroupPanels,
  cycleInGroup,
  cycleRecent,
  focusGroup,
  focusNextGroup,
  goToTab,
  moveToNeighborGroup,
  killActiveTerminal,
  openBottomView,
  openTerminal,
  openView,
  reopenClosed,
  resetLayoutToDefault,
  toggleBottomMaximize,
  setZenDock,
  splitPanel,
  toggleBottomPanel,
  toggleMaximize,
} from "../workbench/dock.ts";
import {
  emergencyStop,
  exportProject,
  importArchive,
  newUntitledFile,
  openFolderDialog,
  revealActiveFile,
  saveActiveEditor,
  saveAllEditors,
} from "./actions.ts";

export interface CommandDef {
  id: string;
  title: TKey;
  category: TKey;
  icon?: LucideIcon;
  /** Raccourci principal : « mod+shift+p », ou accord « mod+k mod+w ». */
  shortcut?: string;
  /** Raccourcis supplémentaires (ex. Ctrl+` en plus de Ctrl+J). */
  altShortcuts?: string[];
  /** Raccourci actif même quand le focus est dans un champ de saisie ou l'éditeur. */
  global?: boolean;
  /** Contexte : « terminal » = seulement quand un terminal a le focus ; « editor »/« explorer » = documentaire. */
  when?: "terminal" | "editor" | "explorer";
  /** Raccourci géré nativement (Monaco, explorateur) : listé dans l'aide, jamais intercepté globalement. */
  native?: boolean;
  /** Dans le terminal, l'événement est laissé à xterm (qui fait la même action) au lieu d'être intercepté. */
  terminalPassthrough?: boolean;
  /** Absente de la palette (ex. Alt+1…9) ; listée dans la page des raccourcis. */
  hidden?: boolean;
  needsProject?: boolean;
  run(): void | Promise<void>;
}

const app = () => useAppStore.getState();

/** Session de l'onglet actif (panneau d'agent ou terminal d'agent). */
function activeSession() {
  const params = activePanel()?.params as { taskId?: string } | undefined;
  return params?.taskId ? useSessionsStore.getState().list.data?.find((x) => x.taskId === params.taskId) : undefined;
}

/** Terminal du panneau actif (ou dernier terminal visible), pour les commandes lancées depuis la palette. */
function activeTerminal(): TerminalControls | undefined {
  const id = activePanel()?.id;
  if (id && terminalControls.has(`${id}#panel`)) return terminalControls.get(`${id}#panel`);
  return [...terminalControls.entries()].filter(([k]) => k.endsWith("#panel")).pop()?.[1];
}

/** Raccourcis natifs de l'éditeur Monaco, listés pour information (jamais interceptés par Nexus). */
const EDITOR_NATIVE: Array<[string, TKey, string]> = [
  ["find", "keys.monaco.find", "mod+f"],
  ["replace", "keys.monaco.replace", "mod+h"],
  ["gotoLine", "keys.monaco.gotoLine", "mod+g"],
  ["addNext", "keys.monaco.addNext", "mod+d"],
  ["moveUp", "keys.monaco.moveUp", "alt+up"],
  ["moveDown", "keys.monaco.moveDown", "alt+down"],
  ["copyDown", "keys.monaco.copyDown", "shift+alt+down"],
  ["comment", "keys.monaco.comment", "mod+slash"],
  ["deleteLine", "keys.monaco.deleteLine", "mod+shift+k"],
  ["selectAllOcc", "keys.monaco.selectAll", "mod+shift+l"],
  ["indent", "keys.monaco.indent", "mod+bracketright"],
  ["outdent", "keys.monaco.outdent", "mod+bracketleft"],
  ["format", "keys.monaco.format", "shift+alt+f"],
  ["commandPalette", "keys.monaco.commands", "f1"],
  ["undo", "keys.monaco.undo", "mod+z"],
  ["redo", "keys.monaco.redo", "mod+shift+z"],
];
const hasProject = () => Boolean(useProjectStore.getState().current);

export const COMMANDS: CommandDef[] = [
  {
    id: "palette",
    title: "cmd.palette",
    category: "cat.general",
    icon: CommandIcon,
    shortcut: "mod+shift+p",
    global: true,
    run: () => app().setPaletteOpen(true),
  },
  {
    id: "quickOpen",
    title: "cmd.quickOpen",
    category: "cat.general",
    icon: FileSearch,
    shortcut: "mod+p",
    global: true,
    needsProject: true,
    run: () => app().setQuickOpenOpen(true),
  },
  {
    id: "openFolder",
    title: "cmd.openFolder",
    category: "cat.project",
    icon: FolderOpen,
    shortcut: "mod+o",
    global: true,
    run: () => openFolderDialog(),
  },
  {
    id: "importArchive",
    title: "cmd.importArchive",
    category: "cat.project",
    icon: Archive,
    run: () => importArchive(),
  },
  {
    id: "exportProject",
    title: "cmd.exportProject",
    category: "cat.project",
    icon: Upload,
    needsProject: true,
    run: () => exportProject(),
  },
  {
    id: "closeProject",
    title: "cmd.closeProject",
    category: "cat.project",
    icon: LogOut,
    needsProject: true,
    run: () => void useProjectStore.getState().close(),
  },

  {
    id: "orchestra.new",
    title: "orch.launchCmd",
    category: "cat.agents",
    icon: Orbit,
    global: true,
    needsProject: true,
    run: () => app().setOrchestraDialogOpen(true),
  },
  {
    id: "view.orchestra",
    title: "orch.showView",
    category: "cat.view",
    icon: Orbit,
    needsProject: true,
    run: () => useAppStore.setState({ sidebarView: "orchestra", sidebarVisible: true }),
  },
  {
    id: "newSession",
    title: "cmd.newSession",
    category: "cat.agents",
    icon: Bot,
    shortcut: "mod+shift+n",
    global: true,
    needsProject: true,
    run: () => app().setNewSessionOpen(true),
  },
  {
    id: "refreshSessions",
    title: "cmd.refreshSessions",
    category: "cat.agents",
    icon: RefreshCw,
    needsProject: true,
    run: () => useSessionsStore.getState().refresh(),
  },
  {
    id: "session.stop",
    title: "cmd.stopSession",
    category: "cat.agents",
    icon: CircleStop,
    needsProject: true,
    run: async () => {
      const s = activeSession();
      if (s && ACTIVE_STATUSES.has(s.status)) await useSessionsStore.getState().cancel(s.taskId);
    },
  },
  {
    id: "session.openTerminal",
    title: "session.openAgentTerminal",
    category: "cat.agents",
    icon: SquareTerminal,
    needsProject: true,
    run: async () => {
      const s = activeSession();
      if (!s) return;
      if (!openSessionTerminal(s) && canResume(s)) await resumeSessionTerminal(s);
    },
  },
  {
    id: "session.delete",
    title: "cmd.deleteSession",
    category: "cat.agents",
    icon: Trash2,
    needsProject: true,
    run: async () => {
      const s = activeSession();
      if (s) await deleteSession(s);
    },
  },
  {
    id: "git.commit",
    title: "cmd.gitCommit",
    category: "cat.scm",
    icon: GitCommitHorizontal,
    needsProject: true,
    run: () => {
      useAppStore.setState({ sidebarView: "scm", sidebarVisible: true });
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-testid=commit-message]")?.focus());
    },
  },
  {
    id: "git.createPr",
    title: "pr.button",
    category: "cat.scm",
    icon: GitPullRequest,
    needsProject: true,
    run: () => {
      const s = activeSession();
      usePrDialog.getState().show(s ? { taskId: s.taskId, title: s.title } : {});
    },
  },
  {
    id: "emergencyStop",
    title: "cmd.emergencyStop",
    category: "cat.agents",
    icon: OctagonX,
    run: () => emergencyStop(),
  },

  {
    id: "view.explorer",
    title: "cmd.viewExplorer",
    category: "cat.view",
    icon: Files,
    shortcut: "mod+shift+e",
    global: true,
    needsProject: true,
    run: () => app().showView("explorer"),
  },
  {
    id: "view.search",
    title: "cmd.viewSearch",
    category: "cat.view",
    icon: Search,
    shortcut: "mod+shift+f",
    global: true,
    needsProject: true,
    run: () => app().showView("search"),
  },
  {
    id: "view.scm",
    title: "cmd.viewScm",
    category: "cat.view",
    icon: GitBranch,
    shortcut: "mod+shift+g",
    global: true,
    needsProject: true,
    run: () => app().showView("scm"),
  },
  {
    id: "view.agents",
    title: "cmd.viewAgents",
    category: "cat.view",
    icon: Bot,
    shortcut: "mod+shift+d",
    global: true,
    needsProject: true,
    run: () => app().showView("agents"),
  },
  {
    id: "toggleSidebar",
    title: "cmd.toggleSidebar",
    category: "cat.view",
    icon: PanelLeft,
    shortcut: "mod+b",
    global: true,
    needsProject: true,
    run: () => app().toggleSidebar(),
  },
  {
    id: "togglePanel",
    title: "cmd.togglePanel",
    category: "cat.view",
    icon: PanelBottom,
    shortcut: "mod+j",
    altShortcuts: ["mod+backquote"],
    global: true,
    needsProject: true,
    run: () => toggleBottomPanel(),
  },
  {
    id: "maximize",
    title: "cmd.maximize",
    category: "cat.view",
    icon: Maximize2,
    shortcut: "mod+shift+m",
    global: true,
    needsProject: true,
    run: () => toggleMaximize(),
  },
  {
    id: "focusNextGroup",
    title: "cmd.focusNextGroup",
    category: "cat.view",
    icon: LayoutPanelLeft,
    needsProject: true,
    run: () => focusNextGroup(),
  },

  {
    id: "terminal.new",
    title: "cmd.newTerminal",
    category: "cat.terminal",
    icon: SquareTerminal,
    shortcut: "mod+shift+backquote",
    global: true,
    needsProject: true,
    run: () => openTerminal(),
  },
  {
    id: "terminal.split",
    title: "cmd.splitTerminal",
    category: "cat.terminal",
    icon: Columns2,
    shortcut: "mod+shift+5",
    needsProject: true,
    run: () => openTerminal({ split: true }),
  },
  {
    id: "terminal.kill",
    title: "cmd.killTerminal",
    category: "cat.terminal",
    icon: Trash2,
    needsProject: true,
    run: () => killActiveTerminal(),
  },
  {
    id: "panel.agentOutput",
    title: "cmd.showAgentOutput",
    category: "cat.view",
    icon: Bot,
    needsProject: true,
    run: () => openBottomView("agentOutput"),
  },
  {
    id: "panel.log",
    title: "cmd.showLog",
    category: "cat.view",
    icon: ScrollText,
    needsProject: true,
    run: () => openBottomView("log"),
  },
  {
    id: "panel.maximize",
    title: "cmd.maximizePanel",
    category: "cat.view",
    icon: ChevronsUp,
    needsProject: true,
    run: () => toggleBottomMaximize(),
  },
  {
    id: "layout.reset",
    title: "cmd.resetLayout",
    category: "cat.view",
    icon: LayoutTemplate,
    needsProject: true,
    run: () => resetLayoutToDefault(),
  },
  {
    id: "terminal.copy",
    title: "cmd.terminalCopy",
    category: "cat.terminal",
    icon: Copy,
    shortcut: "mod+shift+c",
    when: "terminal",
    terminalPassthrough: true,
    needsProject: true,
    run: () => activeTerminal()?.copySelection(),
  },
  {
    id: "terminal.paste",
    title: "cmd.terminalPaste",
    category: "cat.terminal",
    icon: ClipboardPaste,
    shortcut: "mod+shift+v",
    when: "terminal",
    terminalPassthrough: true,
    needsProject: true,
    run: () => activeTerminal()?.paste(),
  },
  {
    id: "terminal.clear",
    title: "cmd.terminalClear",
    category: "cat.terminal",
    icon: Eraser,
    // Cmd+K sur macOS seulement : sous Linux/Windows, Ctrl+K appartient au shell (readline, TUI des agents).
    ...(isMac && { shortcut: "mod+k" }),
    when: "terminal",
    terminalPassthrough: true,
    needsProject: true,
    run: () => activeTerminal()?.clear(),
  },

  {
    id: "editor.save",
    title: "cmd.save",
    category: "cat.editor",
    icon: Save,
    shortcut: "mod+s",
    global: true,
    needsProject: true,
    run: () => saveActiveEditor(),
  },
  {
    id: "editor.saveAll",
    title: "cmd.saveAll",
    category: "cat.editor",
    icon: SaveAll,
    shortcut: "mod+alt+s",
    needsProject: true,
    run: () => saveAllEditors(),
  },
  {
    id: "files.newUntitled",
    title: "cmd.newUntitled",
    category: "cat.files",
    icon: FilePlus2,
    shortcut: "mod+n",
    needsProject: true,
    run: () => newUntitledFile(),
  },
  {
    id: "editor.close",
    title: "cmd.closeEditor",
    category: "cat.editor",
    icon: X,
    shortcut: "mod+w",
    global: true,
    needsProject: true,
    run: () => closeActive(),
  },
  {
    id: "tabs.closeGroup",
    title: "cmd.closeGroup",
    category: "cat.tabs",
    icon: X,
    shortcut: "mod+k mod+w",
    needsProject: true,
    run: () => closeGroupPanels(),
  },
  {
    id: "tabs.reopen",
    title: "cmd.reopenClosed",
    category: "cat.tabs",
    icon: Undo2,
    shortcut: "mod+shift+t",
    needsProject: true,
    run: () => void reopenClosed(),
  },
  {
    id: "tabs.recentNext",
    title: "cmd.recentNext",
    category: "cat.tabs",
    icon: ArrowRightLeft,
    shortcut: "ctrl+tab",
    needsProject: true,
    run: () => cycleRecent(1),
  },
  {
    id: "tabs.recentPrev",
    title: "cmd.recentPrev",
    category: "cat.tabs",
    icon: ArrowRightLeft,
    shortcut: "ctrl+shift+tab",
    needsProject: true,
    run: () => cycleRecent(-1),
  },
  {
    id: "tabs.next",
    title: "cmd.nextTab",
    category: "cat.tabs",
    icon: ChevronRight,
    shortcut: "mod+pagedown",
    needsProject: true,
    run: () => cycleInGroup(1),
  },
  {
    id: "tabs.prev",
    title: "cmd.prevTab",
    category: "cat.tabs",
    icon: ChevronLeft,
    shortcut: "mod+pageup",
    needsProject: true,
    run: () => cycleInGroup(-1),
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): CommandDef => ({
    id: `tabs.goto${n}`,
    title: n === 9 ? "cmd.gotoLastTab" : (`cmd.gotoTab${n}` as TKey),
    category: "cat.tabs",
    shortcut: `alt+${n}`,
    hidden: true,
    needsProject: true,
    run: () => goToTab(n),
  })),
  ...[1, 2, 3].map((n): CommandDef => ({
    id: `group.focus${n}`,
    title: `cmd.focusGroup${n}` as TKey,
    category: "cat.tabs",
    icon: LayoutPanelLeft,
    shortcut: `mod+${n}`,
    needsProject: true,
    run: () => focusGroup(n),
  })),
  {
    id: "tabs.moveLeft",
    title: "cmd.moveTabLeft",
    category: "cat.tabs",
    icon: ArrowLeftToLine,
    shortcut: "mod+k left",
    needsProject: true,
    run: () => moveToNeighborGroup("left"),
  },
  {
    id: "tabs.moveRight",
    title: "cmd.moveTabRight",
    category: "cat.tabs",
    icon: ArrowRightToLine,
    shortcut: "mod+k right",
    needsProject: true,
    run: () => moveToNeighborGroup("right"),
  },
  {
    id: "editor.split",
    title: "cmd.splitEditor",
    category: "cat.editor",
    icon: Columns2,
    shortcut: "mod+backslash",
    global: true,
    needsProject: true,
    run: () => splitPanel(undefined, "right"),
  },
  {
    id: "files.newFile",
    title: "cmd.newFile",
    category: "cat.files",
    icon: FilePlus,
    needsProject: true,
    run: () => {
      useAppStore.setState({ sidebarView: "explorer", sidebarVisible: true });
      useFilesStore.getState().startCreate("file");
    },
  },
  {
    id: "files.rename",
    title: "cmd.renameFile",
    category: "cat.files",
    shortcut: "f2",
    when: "explorer",
    native: true,
    needsProject: true,
    run: () => {},
  },
  {
    id: "files.delete",
    title: "cmd.deleteFile",
    category: "cat.files",
    shortcut: "delete",
    when: "explorer",
    native: true,
    needsProject: true,
    run: () => {},
  },
  {
    id: "files.newFolder",
    title: "cmd.newFolder",
    category: "cat.files",
    icon: FolderPlus,
    needsProject: true,
    run: () => {
      useAppStore.setState({ sidebarView: "explorer", sidebarVisible: true });
      useFilesStore.getState().startCreate("directory");
    },
  },
  {
    id: "explorer.reveal",
    title: "cmd.revealActive",
    category: "cat.files",
    icon: LocateFixed,
    needsProject: true,
    run: () => revealActiveFile(),
  },
  {
    id: "explorer.collapseAll",
    title: "explorer.collapseAll",
    category: "cat.files",
    icon: ChevronsDownUp,
    needsProject: true,
    run: () => useFilesStore.setState({ expanded: {} }),
  },
  {
    id: "files.refresh",
    title: "cmd.refreshFiles",
    category: "cat.files",
    icon: RefreshCw,
    needsProject: true,
    run: () => useFilesStore.getState().refreshAll(),
  },
  {
    id: "git.refresh",
    title: "cmd.refreshGit",
    category: "cat.scm",
    icon: RefreshCw,
    needsProject: true,
    run: () => useGitStore.getState().refresh(),
  },
  {
    id: "view.deployment",
    title: "cmd.deployment",
    category: "cat.advanced",
    icon: CloudUpload,
    needsProject: true,
    run: () => openView("deployment"),
  },
  {
    id: "view.usage",
    title: "cmd.usage",
    category: "cat.advanced",
    icon: Gauge,
    needsProject: true,
    run: () => openView("usage"),
  },

  {
    id: "view.zen",
    title: "cmd.zen",
    category: "cat.view",
    icon: Maximize,
    shortcut: "mod+k z",
    needsProject: true,
    run: () => {
      const on = !app().zen;
      app().setZen(on);
      setZenDock(on);
    },
  },
  {
    id: "keyboardShortcuts",
    title: "cmd.keyboardShortcuts",
    category: "cat.preferences",
    icon: Keyboard,
    shortcut: "mod+k mod+s",
    global: true,
    run: () => (hasProject() ? openView("shortcuts") : app().setShortcutsDialogOpen(true)),
  },
  ...EDITOR_NATIVE.map(([id, title, shortcut]): CommandDef => ({
    id: `monaco.${id}`,
    title,
    category: "cat.editor",
    shortcut,
    when: "editor",
    native: true,
    hidden: true,
    run: () => {},
  })),
  {
    id: "settings",
    title: "cmd.settings",
    category: "cat.preferences",
    icon: Settings,
    shortcut: "mod+comma",
    global: true,
    run: () => (hasProject() ? openView("settings") : app().setSettingsDialogOpen(true)),
  },
  {
    id: "theme.dark",
    title: "cmd.themeDark",
    category: "cat.preferences",
    icon: Moon,
    run: () => app().setTheme("dark"),
  },
  {
    id: "theme.light",
    title: "cmd.themeLight",
    category: "cat.preferences",
    icon: Sun,
    run: () => app().setTheme("light"),
  },
  {
    id: "theme.system",
    title: "cmd.themeSystem",
    category: "cat.preferences",
    icon: Monitor,
    run: () => app().setTheme("system"),
  },
  {
    id: "lang.toggle",
    title: "cmd.toggleLang",
    category: "cat.preferences",
    icon: Languages,
    run: () => app().setLang(app().lang === "fr" ? "en" : "fr"),
  },
];

export function availableCommands(): CommandDef[] {
  const project = hasProject();
  return COMMANDS.filter((c) => !c.hidden && !c.native && (!c.needsProject || project));
}

export function runCommand(id: string): void {
  const cmd = COMMANDS.find((c) => c.id === id);
  if (!cmd || (cmd.needsProject && !hasProject())) return;
  void Promise.resolve(cmd.run()).catch(() => {});
}
