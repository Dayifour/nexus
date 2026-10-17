// Terminal interactif réel (PTY du main) dans un onglet du panneau bas, comme dans VS Code :
// - un onglet peut contenir plusieurs volets scindés côte à côte (Ctrl+Maj+5), chacun avec son propre PTY ;
// - saisie transmise (`terminal.write`), taille exacte (`terminal.resize` après ajustement, sans scintillement) ;
// - recherche (Ctrl+F), copier/coller (Ctrl+Maj+C / Ctrl+Maj+V), effacer (Ctrl+K), liens copiés (jamais ouverts) ;
// - quand le shell se termine, le volet se ferme (l'onglet aussi s'il était seul) ; un terminal d'agent reste
//   affiché avec son code de sortie pour relire la fin de la session.
// Les couleurs viennent des jetons CSS (--term-*), donc des thèmes clair et sombre.
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowDown, ArrowUp, Columns2, Eraser, Pencil, PlugZap, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { call, isUnavailable } from "../api.ts";
import { tNow, useT } from "../i18n/index.ts";
import { errorText } from "../lib/actions.ts";
import { isMac } from "../lib/shortcuts.ts";
import { useAppStore } from "../stores/app.ts";
import { useProjectStore } from "../stores/project.ts";
import {
  backgroundTerminals,
  terminalBus,
  terminalControls,
  terminalPanels,
  useTerminalsStore,
} from "../stores/terminals.ts";
import { Button, EmptyState, IconButton, cx } from "../ui/primitives.tsx";
import type { PanelProps } from "../workbench/DockHost.tsx";
import { getDock, type PanelParams } from "../workbench/dock.ts";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Thème xterm lu dans les jetons CSS du thème courant. */
export function terminalTheme(): ITheme {
  const v = (n: string) => cssVar(`--term-${n}`) || undefined;
  return {
    background: v("bg"),
    foreground: v("fg"),
    cursor: cssVar("--accent") || undefined,
    cursorAccent: v("bg"),
    selectionBackground: v("selection"),
    black: v("black"),
    red: v("red"),
    green: v("green"),
    yellow: v("yellow"),
    blue: v("blue"),
    magenta: v("magenta"),
    cyan: v("cyan"),
    white: v("white"),
    brightBlack: v("bright-black"),
    brightRed: v("bright-red"),
    brightGreen: v("bright-green"),
    brightYellow: v("bright-yellow"),
    brightBlue: v("bright-blue"),
    brightMagenta: v("bright-magenta"),
    brightCyan: v("bright-cyan"),
    brightWhite: v("bright-white"),
  };
}

/** Suit le thème de l'application (clair, sombre, système) pour un terminal créé hors de ce panneau. */
export function followTheme(term: Terminal): () => void {
  return useAppStore.subscribe((s, prev) => {
    if (s.resolvedTheme !== prev.resolvedTheme) term.options.theme = terminalTheme();
  });
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

export const TERMINAL_FONT = "'JetBrains Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace";

interface PaneProps {
  paneKey: string;
  panelId: string;
  params: PanelParams;
  panelApi: PanelProps["api"];
  /** Seul le premier volet se rattache au PTY d'un agent ; les volets ajoutés ouvrent un shell. */
  attach: boolean;
  focused: boolean;
  closable: boolean;
  onFocus(): void;
  /** Le shell (non rattaché) s'est terminé : le parent ferme le volet. */
  onShellExit(): void;
  onClose(): void;
}

function TerminalPane({
  paneKey,
  panelId,
  params,
  panelApi,
  attach,
  focused,
  closable,
  onFocus,
  onShellExit,
  onClose,
}: PaneProps) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [generation, setGeneration] = useState(0);
  const restarting = useRef(false);
  const restart = () => {
    restarting.current = true;
    setGeneration((g) => g + 1);
  };
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const info = useTerminalsStore((s) => s.byPanel[paneKey]);
  const upsert = useTerminalsStore((s) => s.upsert);
  const remove = useTerminalsStore((s) => s.remove);
  const projectId = useProjectStore((s) => s.current?.projectId);
  const theme = useAppStore((s) => s.resolvedTheme);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const exitRef = useRef(onShellExit);
  exitRef.current = onShellExit;

  useEffect(() => () => remove(paneKey), [paneKey, remove]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme();
  }, [theme]);

  useEffect(() => {
    if (focused) requestAnimationFrame(() => termRef.current?.focus());
  }, [focused]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInput.current?.select());
  }, []);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let terminalId: string | undefined;
    const term = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10_000,
      allowProposedApi: true,
      theme: terminalTheme(),
      // Comme VS Code : les couleurs ANSI trop proches du fond sont ajustées (lisibles en clair comme en sombre).
      minimumContrastRatio: 4.5,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Pas d'ouverture de fenêtre externe : le lien est copié, l'utilisateur décide.
        event.preventDefault();
        void copyText(uri).then(() => toast.info(tNow("term.linkCopied", { url: uri.slice(0, 120) })));
      }),
    );
    term.open(host.current);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL indisponible : rendu DOM par défaut.
    }
    termRef.current = term;
    searchRef.current = search;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.code === "KeyF") {
        openSearch();
        return false;
      }
      if (mod && e.shiftKey && e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) void copyText(sel);
        return false;
      }
      // Ctrl+Maj+V : collage natif du navigateur (événement paste reçu par le terminal).
      if (mod && e.shiftKey && e.code === "KeyV") return false;
      // Cmd+K sur macOS : effacer le terminal, comme dans VS Code. Ailleurs, Ctrl+K reste au shell (effacer jusqu'à
      // la fin de la ligne dans readline/zsh, raccourcis des TUI d'agents) : « Effacer » reste dans la barre d'outils.
      if (isMac && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyK") {
        term.clear();
        return false;
      }
      return true;
    });
    const controls = {
      copySelection: () => {
        const sel = term.getSelection();
        if (sel) void copyText(sel);
      },
      paste: () => {
        term.focus();
        // Lecture du presse-papiers refusée par la politique de permissions : collage natif sur la zone du terminal.
        document.execCommand("paste");
      },
      clear: () => term.clear(),
      focus: () => term.focus(),
      search: openSearch,
      restart,
    };
    terminalControls.set(paneKey, controls);

    // Ajustement à la taille du volet : regroupé par image, ignoré tant que le volet est masqué (pas de saut).
    let lastSize = "";
    const doFit = () => {
      const el = host.current;
      if (disposed || !el || el.clientWidth < 10 || el.clientHeight < 10) return;
      const size = `${el.clientWidth}x${el.clientHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      try {
        fit.fit();
      } catch {
        // dimensions non encore disponibles
      }
    };
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(doFit);
    });
    observer.observe(host.current);
    doFit();

    upsert(paneKey, { status: "starting", title: panelApi.title ?? t("term.title") });
    const dataSub = term.onData((data) => {
      if (terminalId) void call("terminal.write", { terminalId, data }).catch(() => {});
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (terminalId) void call("terminal.resize", { terminalId, cols, rows }).catch(() => {});
    });
    let detach: (() => void) | undefined;

    const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : undefined;
    // Terminal d'une session interactive (agent lancé par le main dans un PTY) : on s'y rattache au lieu d'en créer un.
    const attachTo =
      attach && generation === 0 && typeof params.attachTerminalId === "string" ? params.attachTerminalId : undefined;
    const attached = attachTo !== undefined;
    const ready = attachTo
      ? Promise.resolve({ terminalId: attachTo, shell: String(params.label ?? ""), cwd: cwd ?? "" })
      : !projectId
        ? Promise.reject(new Error(tNow("term.noProject")))
        : call("terminal.create", {
            projectId,
            ...(cwd && { cwd }),
            cols: Math.max(2, term.cols),
            rows: Math.max(1, term.rows),
          });
    void ready.then(
      (r) => {
        if (disposed) {
          // Panneau démonté avant d'être prêt (ex. double montage de React en développement) : un terminal créé ici
          // est libéré ; celui d'un agent (rattaché) ne doit JAMAIS être tué ainsi, sinon l'agent meurt aussitôt.
          if (!attached) void call("terminal.kill", { terminalId: r.terminalId }).catch(() => {});
          return;
        }
        terminalId = r.terminalId;
        upsert(paneKey, { terminalId: r.terminalId, status: "running", shell: r.shell, cwd: r.cwd });
        detach = terminalBus.attach(
          r.terminalId,
          (data) => term.write(data),
          (code) => {
            upsert(paneKey, { status: "exited", exitCode: code });
            term.write(`\r\n\x1b[2m${tNow("term.exited", { code: code ?? "?" })}\x1b[0m\r\n`);
            // Shell quitté (exit, Ctrl+D) : le volet se ferme, comme dans VS Code. Un agent reste lisible.
            if (!attached && !restarting.current) exitRef.current();
          },
        );
        lastSize = "";
        doFit();
        void call("terminal.resize", { terminalId: r.terminalId, cols: term.cols, rows: term.rows }).catch(() => {});
        if (panelApi.isActive && focusedRef.current) term.focus();
      },
      (e: unknown) => {
        if (disposed) return;
        upsert(paneKey, { status: isUnavailable(e) ? "unavailable" : "error" });
        if (!isUnavailable(e)) term.write(`\x1b[31m${errorText(e)}\x1b[0m\r\n`);
      },
    );

    const activeSub = panelApi.onDidActiveChange((e) => {
      if (e.isActive)
        requestAnimationFrame(() => {
          doFit();
          if (focusedRef.current) term.focus();
        });
    });
    const visSub = panelApi.onDidVisibilityChange((e) => {
      if (e.isVisible) {
        lastSize = "";
        requestAnimationFrame(doFit);
      }
    });

    return () => {
      disposed = true;
      if (terminalControls.get(paneKey) === controls) terminalControls.delete(paneKey);
      cancelAnimationFrame(raf);
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      activeSub.dispose();
      visSub.dispose();
      detach?.();
      // Un terminal rattaché (agent) n'est tué que si le panneau est réellement fermé ou relancé.
      // « Laisser tourner en arrière-plan » : l'onglet se ferme, l'agent continue (rouvrable depuis les sessions).
      const panelClosed = !getDock()?.getPanel(panelId);
      const keepAlive = attached && terminalId !== undefined && backgroundTerminals.delete(terminalId);
      if (terminalId && !keepAlive && (!attached || panelClosed || restarting.current)) {
        void call("terminal.kill", { terminalId }).catch(() => {});
      }
      restarting.current = false;
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
    // Recréé uniquement au redémarrage explicite (generation) ; les paramètres initiaux suffisent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, paneKey]);

  const find = useCallback(
    (dir: "next" | "prev") => {
      if (!query) return;
      const accent = cssVar("--accent");
      const warn = cssVar("--warning");
      const opts = {
        incremental: dir === "next",
        decorations: {
          matchOverviewRuler: warn,
          activeMatchColorOverviewRuler: accent,
          matchBackground: cssVar("--term-match"),
          activeMatchBackground: cssVar("--term-match-active"),
        },
      };
      if (dir === "next") searchRef.current?.findNext(query, opts);
      else searchRef.current?.findPrevious(query, opts);
    },
    [query],
  );

  const closeSearch = () => {
    setSearchOpen(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  return (
    <div
      className={cx("terminal-pane", focused && "is-focused")}
      data-testid="terminal-pane"
      data-status={info?.status}
      onMouseDown={onFocus}
      onFocusCapture={onFocus}
    >
      {closable && (
        <div className="terminal-pane-head">
          <span className="truncate">
            {info?.shell ? info.shell.split("/").pop() : t("term.title")}
            {info?.status === "exited" ? ` · ${t("term.exitedShort")}` : ""}
          </span>
          <IconButton size="sm" label={t("term.killPane")} onClick={onClose}>
            <X size={12} />
          </IconButton>
        </div>
      )}
      {searchOpen && (
        <div className="terminal-search" role="search">
          <input
            ref={searchInput}
            className="input input-sm"
            placeholder={t("term.searchPlaceholder")}
            aria-label={t("term.search")}
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value) searchRef.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") find(e.shiftKey ? "prev" : "next");
              if (e.key === "Escape") closeSearch();
            }}
          />
          <IconButton size="sm" label={t("term.prev")} onClick={() => find("prev")}>
            <ArrowUp size={13} />
          </IconButton>
          <IconButton size="sm" label={t("term.next")} onClick={() => find("next")}>
            <ArrowDown size={13} />
          </IconButton>
          <IconButton size="sm" label={t("common.close")} onClick={closeSearch}>
            <X size={13} />
          </IconButton>
        </div>
      )}
      <div className="terminal-host" ref={host} />
      {info?.status === "unavailable" && (
        <div className="terminal-overlay" data-testid="terminal-unavailable">
          <EmptyState
            icon={<PlugZap size={26} />}
            title={t("term.unavailableTitle")}
            action={
              <Button icon={<RotateCcw size={14} />} onClick={restart}>
                {t("common.retry")}
              </Button>
            }
          >
            {t("term.unavailableBody")}
          </EmptyState>
        </div>
      )}
      {info?.status === "exited" && (
        <div className="terminal-exitbar">
          <span>{t("term.exited", { code: info.exitCode ?? "?" })}</span>
          <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={restart}>
            {t("term.restart")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function TerminalPanel({ params, api, panelId }: PanelProps) {
  const t = useT();
  const seq = useRef(1);
  const [panes, setPanes] = useState<string[]>([panelId]);
  const [focusedPane, setFocusedPane] = useState(panelId);
  const [renaming, setRenaming] = useState(false);
  const focusedInfo = useTerminalsStore((s) => s.byPanel[focusedPane]);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const focusedRef = useRef(focusedPane);
  focusedRef.current = focusedPane;

  const closePanel = useCallback(() => getDock()?.getPanel(panelId)?.api.close(), [panelId]);

  const split = useCallback(() => {
    if (panesRef.current.length >= 4) return;
    const key = `${panelId}~${++seq.current}`;
    setPanes((p) => [...p, key]);
    setFocusedPane(key);
  }, [panelId]);

  const closePane = useCallback(
    (key: string) => {
      const rest = panesRef.current.filter((k) => k !== key);
      if (rest.length === 0) {
        closePanel();
        return;
      }
      setPanes(rest);
      if (focusedRef.current === key) setFocusedPane(rest[rest.length - 1] ?? panelId);
    },
    [closePanel, panelId],
  );

  // Commandes globales (palette, raccourcis) : agissent sur le volet focalisé de cet onglet.
  useEffect(() => {
    const focused = () => terminalControls.get(focusedRef.current);
    terminalControls.set(`${panelId}#panel`, {
      copySelection: () => focused()?.copySelection(),
      paste: () => focused()?.paste(),
      clear: () => focused()?.clear(),
      focus: () => focused()?.focus(),
      search: () => focused()?.search(),
      restart: () => focused()?.restart(),
    });
    terminalPanels.set(panelId, { split, killFocused: () => closePane(focusedRef.current) });
    return () => {
      terminalControls.delete(`${panelId}#panel`);
      terminalPanels.delete(panelId);
    };
  }, [panelId, split, closePane]);

  const rename = (name: string) => {
    const clean = name.trim().slice(0, 60);
    if (clean) {
      api.setTitle(clean);
      api.updateParameters({ label: clean });
      useTerminalsStore.getState().upsert(panelId, { title: clean });
    }
    setRenaming(false);
  };

  const focusedControls = () => terminalControls.get(focusedPane);

  return (
    <div className="panel-fill terminal-panel" data-testid="terminal-panel">
      <div className="terminal-toolbar">
        {renaming ? (
          <input
            className="input input-sm w-40"
            defaultValue={api.title}
            autoFocus
            aria-label={t("term.rename")}
            onBlur={(e) => rename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename(e.currentTarget.value);
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="text-[11px] text-fg-subtle truncate" title={focusedInfo?.cwd}>
            {focusedInfo?.shell ? `${focusedInfo.shell.split("/").pop()} · ` : ""}
            {focusedInfo?.cwd ?? ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton size="sm" label={t("term.search")} shortcut="mod+f" onClick={() => focusedControls()?.search()}>
            <Search size={13} />
          </IconButton>
          <IconButton size="sm" label={t("term.rename")} onClick={() => setRenaming(true)}>
            <Pencil size={13} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("term.clear")}
            {...(isMac && { shortcut: "mod+k" })}
            onClick={() => focusedControls()?.clear()}
          >
            <Eraser size={13} />
          </IconButton>
          <IconButton size="sm" label={t("term.restart")} onClick={() => focusedControls()?.restart()}>
            <RotateCcw size={13} />
          </IconButton>
          <IconButton size="sm" label={t("cmd.splitTerminal")} shortcut="mod+shift+5" onClick={split}>
            <Columns2 size={13} />
          </IconButton>
          <IconButton size="sm" label={t("term.killPane")} onClick={() => closePane(focusedPane)}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>
      <div className={cx("terminal-panes", panes.length > 1 && "is-split")}>
        {panes.map((key, i) => (
          <TerminalPane
            key={key}
            paneKey={key}
            panelId={panelId}
            params={params}
            panelApi={api}
            attach={i === 0 && key === panelId}
            focused={focusedPane === key}
            closable={panes.length > 1}
            onFocus={() => setFocusedPane(key)}
            onShellExit={() => closePane(key)}
            onClose={() => closePane(key)}
          />
        ))}
      </div>
    </div>
  );
}
