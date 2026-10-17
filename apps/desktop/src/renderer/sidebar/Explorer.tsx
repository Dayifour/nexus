// Explorateur de fichiers : arbre à chargement paresseux, navigation clavier (flèches, Entrée, F2, Suppr),
// menu contextuel, création et renommage en ligne, mise à jour en direct (événements `fs`), fichiers protégés verrouillés.
import * as CM from "@radix-ui/react-context-menu";
import {
  ChevronRight,
  ChevronsDownUp,
  Copy,
  FilePlus,
  FolderPlus,
  Lock,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash,
  Columns2,
  LocateFixed,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useT } from "../i18n/index.ts";
import { errorText, moveEntry, revealActiveFile } from "../lib/actions.ts";
import { FileIcon, FolderIcon } from "../lib/file-icons.tsx";
import { joinPath, parentOf, useFilesStore } from "../stores/files.ts";
import { useProjectStore } from "../stores/project.ts";
import type { FileEntry } from "../types.ts";
import { confirmAction } from "../ui/dialog.tsx";
import { ErrorNotice, IconButton, Kbd, SectionTitle, Skeleton, cx } from "../ui/primitives.tsx";
import { openFile, openTerminal, splitPanel, getDock } from "../workbench/dock.ts";

type Row =
  | { type: "entry"; entry: FileEntry; depth: number }
  | { type: "create"; dir: string; kind: "file" | "directory"; depth: number }
  | { type: "loading"; dir: string; depth: number }
  | { type: "error"; dir: string; depth: number };

const NAME_RE = /^[^/\\\0]{1,255}$/;
const DND_TYPE = "application/x-nexus-path";

function InlineInput({
  initial,
  onSubmit,
  onCancel,
  depth,
  icon,
}: {
  initial: string;
  onSubmit(v: string): void;
  onCancel(): void;
  depth: number;
  icon: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (value: string | undefined) => {
    if (done.current) return;
    done.current = true;
    if (value === undefined || !value.trim() || value.trim() === initial) onCancel();
    else onSubmit(value.trim());
  };
  return (
    <div className="tree-row is-editing" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tree-chevron" />
      {icon}
      <input
        ref={ref}
        className="tree-input"
        defaultValue={initial}
        aria-label={t("explorer.name")}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(e.currentTarget.value);
          if (e.key === "Escape") finish(undefined);
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  );
}

export function Explorer() {
  const t = useT();
  const project = useProjectStore((s) => s.current);
  const children = useFilesStore((s) => s.children);
  const expanded = useFilesStore((s) => s.expanded);
  const selected = useFilesStore((s) => s.selected);
  const inline = useFilesStore((s) => s.inline);
  const watching = useFilesStore((s) => s.watching);
  const store = useFilesStore.getState();
  const treeRef = useRef<HTMLDivElement>(null);
  /** Dossier survolé pendant un glisser-déposer interne ("" = racine). */
  const [dropTarget, setDropTarget] = useState<string | undefined>();

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      if (inline?.mode === "create" && inline.dir === dir) out.push({ type: "create", dir, kind: inline.kind, depth });
      const res = children[dir];
      if (!res || (res.loading && !res.data)) {
        out.push({ type: "loading", dir, depth });
        return;
      }
      if (res.error && !res.data) {
        out.push({ type: "error", dir, depth });
        return;
      }
      for (const entry of res.data ?? []) {
        out.push({ type: "entry", entry, depth });
        if (entry.kind === "directory" && expanded[entry.path]) walk(entry.path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [children, expanded, inline]);

  const entries = rows.filter((r): r is Extract<Row, { type: "entry" }> => r.type === "entry");
  // Identifiant DOM stable d'une ligne (aria-activedescendant) : chemin encodé, sans caractère invalide.
  const rowId = (path: string) => `explorer-row-${encodeURIComponent(path).replace(/%/g, "_")}`;

  useEffect(() => {
    if (!selected) return;
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const absolute = (rel: string) => (project ? (rel ? `${project.rootPath}/${rel}` : project.rootPath) : rel);

  const activate = (entry: FileEntry, pinned: boolean) => {
    store.select(entry.path);
    if (entry.kind === "directory") store.toggle(entry.path);
    else openFile(entry.path, { preview: !pinned, protected: entry.protected });
  };

  const remove = async (entry: FileEntry) => {
    const ok = await confirmAction({
      title: t("explorer.deleteTitle", { name: entry.name }),
      body: t("explorer.deleteBody"),
      confirmLabel: t("explorer.moveToTrash"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    try {
      await store.remove(entry.path);
      for (const p of getDock()?.panels ?? []) {
        const path = (p.params as { path?: string } | undefined)?.path;
        if (p.api.component === "editor" && path && (path === entry.path || path.startsWith(`${entry.path}/`))) {
          p.api.close();
        }
      }
      toast.success(t("explorer.deleted", { name: entry.name }));
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const createIn = (dir: string, kind: "file" | "directory") => store.setInline({ mode: "create", dir, kind });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (inline) return;
    const idx = entries.findIndex((r) => r.entry.path === selected);
    const cur = entries[idx]?.entry;
    const move = (i: number) => {
      const next = entries[Math.max(0, Math.min(entries.length - 1, i))];
      if (next) store.select(next.entry.path);
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(idx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(idx < 0 ? 0 : idx - 1);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(entries.length - 1);
        break;
      case "ArrowRight":
        if (cur?.kind === "directory") {
          e.preventDefault();
          if (!expanded[cur.path]) store.toggle(cur.path, true);
          else move(idx + 1);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (cur?.kind === "directory" && expanded[cur.path]) store.toggle(cur.path, false);
        else if (cur) {
          const parent = parentOf(cur.path);
          if (parent) store.select(parent);
        }
        break;
      case "Enter":
        if (cur) {
          e.preventDefault();
          activate(cur, true);
        }
        break;
      case " ":
        if (cur) {
          e.preventDefault();
          activate(cur, false);
        }
        break;
      case "F2":
        if (cur) {
          e.preventDefault();
          store.setInline({ mode: "rename", path: cur.path });
        }
        break;
      case "Delete":
        if (cur) {
          e.preventDefault();
          void remove(cur);
        }
        break;
    }
  };

  const menuFor = (entry: FileEntry | undefined) => {
    const dir = entry ? (entry.kind === "directory" ? entry.path : parentOf(entry.path)) : "";
    return (
      <CM.Portal>
        <CM.Content className="menu" collisionPadding={8}>
          <CM.Item className="menu-item" onSelect={() => createIn(dir, "file")}>
            <FilePlus size={14} /> {t("cmd.newFile")}
          </CM.Item>
          <CM.Item className="menu-item" onSelect={() => createIn(dir, "directory")}>
            <FolderPlus size={14} /> {t("cmd.newFolder")}
          </CM.Item>
          {entry && entry.kind !== "directory" && (
            <CM.Item
              className="menu-item"
              onSelect={() => {
                openFile(entry.path, { preview: false, protected: entry.protected });
                requestAnimationFrame(() => splitPanel(undefined, "right"));
              }}
            >
              <Columns2 size={14} /> {t("explorer.openToSide")}
            </CM.Item>
          )}
          {entry && (
            <>
              <CM.Separator className="menu-sep" />
              <CM.Item className="menu-item" onSelect={() => store.setInline({ mode: "rename", path: entry.path })}>
                <Pencil size={14} /> {t("explorer.rename")}
                <span className="menu-kbd">
                  <Kbd spec="F2" />
                </span>
              </CM.Item>
              <CM.Item className="menu-item menu-danger" onSelect={() => void remove(entry)}>
                <Trash size={14} /> {t("explorer.delete")}
                <span className="menu-kbd">
                  <Kbd spec="Delete" />
                </span>
              </CM.Item>
            </>
          )}
          <CM.Separator className="menu-sep" />
          <CM.Item
            className="menu-item"
            onSelect={() => void navigator.clipboard?.writeText(absolute(entry?.path ?? "")).catch(() => {})}
          >
            <Copy size={14} /> {t("explorer.copyPath")}
          </CM.Item>
          {entry && (
            <CM.Item
              className="menu-item"
              onSelect={() => void navigator.clipboard?.writeText(entry.path).catch(() => {})}
            >
              <Copy size={14} /> {t("explorer.copyRelativePath")}
            </CM.Item>
          )}
          <CM.Item className="menu-item" onSelect={() => openTerminal({ cwd: absolute(dir) })}>
            <SquareTerminal size={14} /> {t("explorer.openTerminalHere")}
          </CM.Item>
        </CM.Content>
      </CM.Portal>
    );
  };

  const renderRow = (row: Row, i: number) => {
    if (row.type === "loading") {
      return (
        <div key={`l-${row.dir}-${i}`} style={{ paddingLeft: 22 + row.depth * 14 }} className="py-1 pr-3">
          <Skeleton lines={row.dir ? 1 : 6} />
        </div>
      );
    }
    if (row.type === "error") {
      return (
        <div key={`e-${row.dir}`} style={{ paddingLeft: 8 + row.depth * 14 }} className="pr-2 py-1">
          <ErrorNotice error={children[row.dir]?.error} compact />
        </div>
      );
    }
    if (row.type === "create") {
      return (
        <InlineInput
          key={`c-${row.dir}`}
          initial=""
          depth={row.depth}
          icon={row.kind === "directory" ? <FolderIcon open={false} /> : <FileIcon name="" />}
          onCancel={() => store.setInline(undefined)}
          onSubmit={(name) => {
            store.setInline(undefined);
            if (!NAME_RE.test(name) || name === "." || name === "..") {
              toast.error(t("explorer.invalidName"));
              return;
            }
            void store.create(row.dir, name, row.kind).then(
              (path) => {
                if (row.kind === "file") openFile(path, { preview: false });
              },
              (e: unknown) => toast.error(errorText(e)),
            );
          }}
        />
      );
    }
    const { entry, depth } = row;
    if (inline?.mode === "rename" && inline.path === entry.path) {
      return (
        <InlineInput
          key={`r-${entry.path}`}
          initial={entry.name}
          depth={depth}
          icon={entry.kind === "directory" ? <FolderIcon open={false} /> : <FileIcon name={entry.name} />}
          onCancel={() => store.setInline(undefined)}
          onSubmit={(name) => {
            store.setInline(undefined);
            if (!NAME_RE.test(name)) {
              toast.error(t("explorer.invalidName"));
              return;
            }
            const to = joinPath(parentOf(entry.path), name);
            void store.rename(entry.path, to).then(
              () => {
                const panel = getDock()?.getPanel(`editor:${entry.path}`);
                if (panel) {
                  panel.api.close();
                  openFile(to, { preview: false });
                }
              },
              (e: unknown) => toast.error(errorText(e)),
            );
          }}
        />
      );
    }
    const isDir = entry.kind === "directory";
    const open = isDir && Boolean(expanded[entry.path]);
    return (
      <CM.Root key={entry.path}>
        <CM.Trigger asChild>
          <div
            role="treeitem"
            id={rowId(entry.path)}
            aria-level={depth + 1}
            aria-selected={selected === entry.path}
            aria-expanded={isDir ? open : undefined}
            data-path={entry.path}
            className={cx(
              "tree-row",
              selected === entry.path && "is-selected",
              entry.protected && "is-protected",
              dropTarget !== undefined &&
                (dropTarget === entry.path || (dropTarget !== "" && entry.path.startsWith(`${dropTarget}/`))) &&
                "is-drop-target",
            )}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => activate(entry, false)}
            onDoubleClick={() => !isDir && activate(entry, true)}
            onContextMenu={() => store.select(entry.path)}
            draggable={!entry.protected}
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_TYPE, entry.path);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DND_TYPE)) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(isDir ? entry.path : parentOf(entry.path));
            }}
            onDragLeave={() => setDropTarget(undefined)}
            onDrop={(e) => {
              const from = e.dataTransfer.getData(DND_TYPE);
              setDropTarget(undefined);
              if (!from) return;
              e.preventDefault();
              e.stopPropagation();
              void moveEntry(from, isDir ? entry.path : parentOf(entry.path));
            }}
            title={entry.protected ? t("explorer.protectedHint") : entry.path}
          >
            <span className={cx("tree-chevron", open && "is-open")}>
              {isDir && <ChevronRight size={13} aria-hidden />}
            </span>
            {isDir ? <FolderIcon open={open} /> : <FileIcon name={entry.name} isProtected={entry.protected} />}
            <span className="tree-label">{entry.name}</span>
            {entry.protected && (
              <Lock size={11} className="ml-auto text-warning shrink-0" aria-label={t("explorer.protected")} />
            )}
          </div>
        </CM.Trigger>
        {menuFor(entry)}
      </CM.Root>
    );
  };

  return (
    <div className="sidebar-view" aria-label={t("view.explorer")}>
      <SectionTitle
        actions={
          <>
            <IconButton size="sm" label={t("cmd.newFile")} onClick={() => store.startCreate("file")}>
              <FilePlus size={14} />
            </IconButton>
            <IconButton size="sm" label={t("cmd.newFolder")} onClick={() => store.startCreate("directory")}>
              <FolderPlus size={14} />
            </IconButton>
            <IconButton size="sm" label={t("cmd.revealActive")} onClick={() => revealActiveFile()}>
              <LocateFixed size={13} />
            </IconButton>
            <IconButton
              size="sm"
              label={watching ? t("explorer.refreshLive") : t("cmd.refreshFiles")}
              onClick={() => void store.refreshAll()}
            >
              <RefreshCw size={13} />
            </IconButton>
            <IconButton
              size="sm"
              label={t("explorer.collapseAll")}
              onClick={() => useFilesStore.setState({ expanded: {} })}
            >
              <ChevronsDownUp size={14} />
            </IconButton>
          </>
        }
      >
        {project?.name ?? t("view.explorer")}
      </SectionTitle>
      <CM.Root>
        <CM.Trigger asChild>
          <div
            ref={treeRef}
            className={cx("tree scroll-area", dropTarget === "" && "is-drop-root")}
            role="tree"
            tabIndex={0}
            // Le focus reste sur l'arbre ; la ligne courante est annoncée par les lecteurs d'écran.
            aria-activedescendant={
              selected && entries.some((r) => r.entry.path === selected) ? rowId(selected) : undefined
            }
            aria-label={t("explorer.tree")}
            data-testid="explorer-tree"
            onKeyDown={onKeyDown}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DND_TYPE)) return;
              e.preventDefault();
              setDropTarget("");
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDropTarget(undefined);
            }}
            onDrop={(e) => {
              const from = e.dataTransfer.getData(DND_TYPE);
              setDropTarget(undefined);
              if (!from) return;
              e.preventDefault();
              void moveEntry(from, "");
            }}
            onFocus={() => {
              if (!selected && entries[0]) store.select(entries[0].entry.path);
            }}
          >
            {rows.map(renderRow)}
            {children[""]?.data?.length === 0 && !inline && (
              <p className="px-4 py-3 text-[12.5px] text-fg-subtle">{t("explorer.empty")}</p>
            )}
            {/* Clic dans le vide : plus de sélection (les créations vont alors à la racine, comme dans VS Code). */}
            <div className="min-h-10 flex-1" onClick={() => store.select(undefined)} aria-hidden />
          </div>
        </CM.Trigger>
        {menuFor(undefined)}
      </CM.Root>
    </div>
  );
}
