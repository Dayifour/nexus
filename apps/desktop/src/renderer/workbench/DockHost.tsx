// Hôte du plan de travail : crée l'instance dockview du projet et rend chaque partie (contenu, onglet, actions
// d'en-tête, filigrane) dans l'élément fourni par dockview, via un portail React.
import * as CM from "@radix-ui/react-context-menu";
import type { DockviewGroupPanel, DockviewPanelApi } from "dockview";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Columns2,
  Trash2,
  FileSearch,
  Maximize2,
  Minimize2,
  Orbit,
  Plus,
  Settings,
  SquareTerminal,
  X,
  GitCompare,
  Command as CommandIcon,
  CloudUpload,
  Gauge,
  ScrollText,
  Keyboard,
} from "lucide-react";
import { lazy, memo, Suspense, useEffect, useRef, useState, type ComponentType, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/index.ts";
import { FileIcon } from "../lib/file-icons.tsx";
import { runCommand } from "../lib/commands.ts";
import { useEditorsStore } from "../stores/editors.ts";
import { ACTIVE_STATUSES, shownLive, useSessionsStore } from "../stores/sessions.ts";
import { useTerminalsStore } from "../stores/terminals.ts";
import { ErrorBoundary } from "../ui/ErrorBoundary.tsx";
import { Kbd, Skeleton, cx } from "../ui/primitives.tsx";
import {
  getDock,
  killActiveTerminal,
  mountDock,
  openTerminal,
  pinPanel,
  requestClose,
  splitPanel,
  tabMenuItems,
  toggleBottomMaximize,
  toggleBottomPanel,
  toggleMaximize,
  useDockState,
  usePortals,
  type MenuEntry,
  type PanelComponent,
  type PanelParams,
  type PortalEntry,
} from "./dock.ts";
import { EditorPanel } from "../panels/EditorPanel.tsx";
import { TerminalPanel } from "../panels/TerminalPanel.tsx";
import { SessionPanel } from "../panels/SessionPanel.tsx";
import { DiffPanel } from "../panels/DiffPanel.tsx";

export interface PanelProps {
  params: PanelParams;
  api: DockviewPanelApi;
  panelId: string;
}

// Vues secondaires chargées à la demande (graphe, réglages, déploiement) : démarrage plus léger.
const SettingsPanel = lazy(() => import("../panels/SettingsPanel.tsx").then((m) => ({ default: m.SettingsPanel })));
const ShortcutsPanel = lazy(() => import("../panels/ShortcutsPanel.tsx").then((m) => ({ default: m.ShortcutsPanel })));
const AgentOutputPanel = lazy(() => import("../panels/BottomViews.tsx").then((m) => ({ default: m.AgentOutputPanel })));
const LogPanel = lazy(() => import("../panels/BottomViews.tsx").then((m) => ({ default: m.LogPanel })));
const OrchestraPanel = lazy(() => import("../panels/OrchestraPanel.tsx").then((m) => ({ default: m.OrchestraPanel })));
const UsagePanel = lazy(() => import("../panels/UsagePanel.tsx").then((m) => ({ default: m.UsagePanel })));
const DeploymentPanel = lazy(() =>
  import("../panels/DeploymentPanel.tsx").then((m) => ({ default: m.DeploymentPanel })),
);

const PANELS: Record<PanelComponent, ComponentType<PanelProps>> = {
  editor: EditorPanel,
  diff: DiffPanel,
  terminal: TerminalPanel,
  session: SessionPanel,
  settings: SettingsPanel,
  usage: UsagePanel,
  orchestra: OrchestraPanel,
  agentOutput: AgentOutputPanel,
  log: LogPanel,
  shortcuts: ShortcutsPanel,
  deployment: DeploymentPanel,
};

const VIEW_ICONS: Partial<Record<PanelComponent, typeof Bot>> = {
  terminal: SquareTerminal,
  session: Bot,
  settings: Settings,
  usage: Gauge,
  orchestra: Orbit,
  agentOutput: Bot,
  log: ScrollText,
  shortcuts: Keyboard,
  deployment: CloudUpload,
  diff: GitCompare,
};

function PanelContent({ entry }: { entry: PortalEntry }) {
  const Comp = entry.component ? PANELS[entry.component] : undefined;
  if (!Comp || !entry.panel || !entry.panelId) return null;
  // Une vue qui plante reste confinée à son panneau (message + « Recharger le panneau »).
  return (
    <ErrorBoundary scope="panel" label={entry.component}>
      <Suspense
        fallback={
          <div className="p-6">
            <Skeleton lines={6} />
          </div>
        }
      >
        <Comp params={entry.params} api={entry.panel.api} panelId={entry.panelId} />
      </Suspense>
    </ErrorBoundary>
  );
}

function useTitle(api: DockviewPanelApi | undefined): string {
  const [title, setTitle] = useState(api?.title ?? "");
  useEffect(() => {
    if (!api) return;
    setTitle(api.title ?? "");
    const d = api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);
  return title;
}

function PanelTab({ entry }: { entry: PortalEntry }) {
  const t = useT();
  const api = entry.panel?.api;
  const title = useTitle(api);
  const path = entry.params.path;
  const dirty = useEditorsStore((s) => (entry.component === "editor" && path ? Boolean(s.docs[path]?.dirty) : false));
  // Session ou terminal d'agent : pastille d'activité (travaille, attend une réponse, en pause, erreur).
  const agentTaskId = entry.component === "session" || entry.component === "terminal" ? entry.params.taskId : undefined;
  const agentDot = useSessionsStore((s) => {
    if (!agentTaskId) return undefined;
    const status = s.list.data?.find((x) => x.taskId === agentTaskId)?.status ?? "";
    const live = shownLive(status, s.live[agentTaskId]);
    if (live === "needs_input") return "warning";
    if (live === "error") return "danger";
    if (live === "working" || live === "starting" || (!live && ACTIVE_STATUSES.has(status))) return "working";
    if (live === "idle") return "idle";
    return undefined;
  });
  const termExited = useTerminalsStore((s) =>
    entry.component === "terminal" && entry.panelId ? s.byPanel[entry.panelId]?.status === "exited" : false,
  );
  const Icon = entry.component ? VIEW_ICONS[entry.component] : undefined;

  const [menu, setMenu] = useState<MenuEntry[]>([]);

  const close = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const panel = entry.panelId ? getDock()?.getPanel(entry.panelId) : undefined;
    if (panel) void requestClose(panel);
  };

  return (
    <CM.Root onOpenChange={(open) => open && entry.panelId && setMenu(tabMenuItems(entry.panelId))}>
      <CM.Trigger asChild>
        <div
          className={cx("tab-inner", entry.params.preview && "is-preview", dirty && "is-dirty")}
          title={path ?? title}
          onMouseDown={(e) => {
            if (e.button === 1) close(e);
          }}
          onDoubleClick={() => entry.panelId && pinPanel(entry.panelId)}
        >
          {entry.component === "editor" && path ? (
            <FileIcon name={path.split("/").pop() ?? path} size={14} isProtected={entry.params.protected} />
          ) : Icon ? (
            <Icon size={14} className="shrink-0 text-fg-muted" aria-hidden />
          ) : null}
          <span className={cx("tab-title", termExited && "line-through opacity-60")}>{title}</span>
          {agentDot && (
            <span
              className={cx("agent-dot", `agent-dot-${agentDot}`)}
              role="img"
              aria-label={t(`tabDot.${agentDot}`)}
              data-testid="tab-agent-dot"
            />
          )}
          <button
            type="button"
            className="tab-close"
            aria-label={t("dock.closeTab", { name: title })}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={close}
            tabIndex={-1}
          >
            <span className="tab-dirty-dot" aria-hidden />
            <X size={13} className="tab-x" aria-hidden />
          </button>
        </div>
      </CM.Trigger>
      <CM.Portal>
        <CM.Content className="menu" collisionPadding={8}>
          {menu.map((item, i) =>
            item === "separator" ? (
              <CM.Separator key={`s${i}`} className="menu-sep" />
            ) : (
              <CM.Item key={item.label} className="menu-item" disabled={item.disabled} onSelect={item.action}>
                {item.label}
              </CM.Item>
            ),
          )}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

function GroupActions({ group }: { group: DockviewGroupPanel }) {
  const t = useT();
  const maximized = useDockState((s) => s.maximized);
  const bottomMax = useDockState((s) => s.bottomMaximized);
  const [isEdge, setEdge] = useState(group.api.location.type === "edge");
  useEffect(() => {
    const d = group.api.onDidLocationChange((e) => setEdge(e.location.type === "edge"));
    return () => d.dispose();
  }, [group]);

  if (isEdge) {
    return (
      <div className="group-actions">
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={t("cmd.newTerminal")}
          title={t("cmd.newTerminal")}
          onClick={() => openTerminal()}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={t("cmd.splitTerminal")}
          title={t("cmd.splitTerminal")}
          onClick={() => openTerminal({ split: true })}
        >
          <Columns2 size={14} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={t("term.killPane")}
          title={t("term.killPane")}
          onClick={() => killActiveTerminal()}
        >
          <Trash2 size={14} />
        </button>
        <span className="group-actions-sep" aria-hidden />
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={bottomMax ? t("bottom.restore") : t("bottom.maximize")}
          title={bottomMax ? t("bottom.restore") : t("bottom.maximize")}
          onClick={() => toggleBottomMaximize()}
        >
          {bottomMax ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={t("cmd.hidePanel")}
          title={t("cmd.hidePanel")}
          onClick={() => toggleBottomPanel()}
        >
          <X size={14} />
        </button>
      </div>
    );
  }
  return (
    <div className="group-actions">
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label={t("dock.splitRight")}
        title={t("dock.splitRight")}
        onClick={() => {
          group.api.setActive?.();
          splitPanel(group.activePanel, "right");
        }}
      >
        <Columns2 size={14} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label={maximized ? t("dock.restore") : t("dock.maximize")}
        title={maximized ? t("dock.restore") : t("dock.maximize")}
        onClick={() => toggleMaximize(group.activePanel)}
      >
        {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
    </div>
  );
}

function Watermark() {
  const t = useT();
  const items: Array<[string, string, string, typeof Bot]> = [
    ["newSession", t("cmd.newSession"), "mod+shift+n", Bot],
    ["quickOpen", t("cmd.quickOpen"), "mod+p", FileSearch],
    ["palette", t("cmd.palette"), "mod+shift+p", CommandIcon],
    ["togglePanel", t("cmd.togglePanel"), "mod+j", SquareTerminal],
    ["keyboardShortcuts", t("cmd.keyboardShortcuts"), "mod+k mod+s", Keyboard],
  ];
  return (
    <div className="watermark">
      <div className="watermark-logo" aria-hidden>
        <span>N</span>
      </div>
      <p className="watermark-title">{t("dock.emptyTitle")}</p>
      <ul className="watermark-list">
        {items.map(([id, label, spec, Icon]) => (
          <li key={id}>
            <button type="button" onClick={() => runCommand(id)}>
              <Icon size={15} aria-hidden />
              <span>{label}</span>
              <Kbd spec={spec} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Mémoïsé : l'ajout ou le retrait d'un panneau ne re-rend pas les autres (seule leur entrée modifiée compte). */
const PortalView = memo(function PortalView({ entry }: { entry: PortalEntry }) {
  switch (entry.kind) {
    case "content":
      return <PanelContent entry={entry} />;
    case "tab":
      return <PanelTab entry={entry} />;
    case "actions":
      return entry.group ? <GroupActions group={entry.group} /> : null;
    case "watermark":
      return <Watermark />;
  }
});

export function DockHost({ projectId }: { projectId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const entries = usePortals((s) => s.entries);

  useEffect(() => {
    if (!ref.current) return;
    return mountDock(ref.current, projectId);
  }, [projectId]);

  return (
    <div className="dock-root" data-testid="workbench-dock">
      <div ref={ref} className="dock-container" />
      {Object.values(entries).map((entry) => createPortal(<PortalView entry={entry} />, entry.element, entry.key))}
    </div>
  );
}
