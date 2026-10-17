// Agents : bouton « Nouvelle session », liste des sessions avec état en direct, agents détectés sur la machine.
import * as CM from "@radix-ui/react-context-menu";
import { Bot, Copy, Hand, Plus, RefreshCw, RotateCcw, Search, Shield, SquareTerminal, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { useT, useTd } from "../i18n/index.ts";
import {
  canResume,
  deleteSession,
  isInteractiveSession,
  openSessionTerminal,
  resumeSessionTerminal,
} from "../lib/agent-terminal.ts";
import { errorText } from "../lib/actions.ts";
import { useAppStore } from "../stores/app.ts";
import { ACTIVE_STATUSES, shownLive, useSessionsStore } from "../stores/sessions.ts";
import { NON_AGENT_TOOLS, type SessionSummary } from "../types.ts";
import { Button, EmptyState, ErrorNotice, IconButton, Kbd, SectionTitle, Skeleton, cx } from "../ui/primitives.tsx";
import { openSession, useDockState } from "../workbench/dock.ts";
import { AgentChip } from "../ui/AgentChip.tsx";
import { AgentSetup, RescanButton } from "../ui/AgentSetup.tsx";
import { agentName } from "../ui/AgentAvatar.tsx";

const MODE_ICONS = { autonomous: Zap, sandboxed: Shield, supervised: Hand, other: Bot } as const;

export function relativeTime(iso: string, lang: "fr" | "en"): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return rtf.format(-Math.round(diff), "second");
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), "minute");
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), "hour");
  return rtf.format(-Math.round(diff / 86400), "day");
}

function statusTone(status: string): string {
  if (ACTIVE_STATUSES.has(status)) return "dot-accent";
  if (status === "completed") return "dot-success";
  if (status === "failed") return "dot-danger";
  if (status === "waiting_review" || status === "interrupted") return "dot-warning";
  return "dot-muted";
}

/** Ouvre une session : panneau de l'agent dans la zone d'édition, et son terminal (panneau bas) s'il en a un. */
export function openSessionAnywhere(s: SessionSummary): void {
  openSession(s.taskId, s.title);
  if (s.terminalId || isInteractiveSession(s)) openSessionTerminal(s);
}

export function SessionRow({ s }: { s: SessionSummary }) {
  const t = useT();
  const td = useTd();
  const lang = useAppStore((st) => st.lang);
  const active = useDockState(
    (st) => st.activePanelId === `session:${s.taskId}` || st.activePanelId === `agent-term:${s.taskId}`,
  );
  const live = useSessionsStore((st) => shownLive(s.status, st.live[s.taskId]));
  const Icon = MODE_ICONS[s.mode];
  const working = ACTIVE_STATUSES.has(s.status) || live === "working" || live === "starting";
  const resume = () => void resumeSessionTerminal(s).catch((e: unknown) => toast.error(errorText(e)));
  return (
    <CM.Root>
      <CM.Trigger asChild>
        <div className="session-row-wrap group" data-testid="session-row" data-task={s.taskId}>
          <button
            type="button"
            className={cx("session-row", active && "is-active")}
            onClick={() => openSessionAnywhere(s)}
          >
            <span
              className={cx(
                "status-dot",
                live === "needs_input" ? "dot-warning" : live === "error" ? "dot-danger" : statusTone(s.status),
                working && "pulse",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="session-row-title">{s.title}</span>
              <span className="session-row-meta">
                <Icon size={11} aria-hidden /> <span title={s.connectorId}>{agentName(s.connectorId)}</span> ·{" "}
                {live ? (
                  <span className={cx(live === "needs_input" && "text-warning", live === "error" && "text-danger")}>
                    {td("live.", live)}
                  </span>
                ) : (
                  td("status.", s.status)
                )}
              </span>
            </span>
            <span className="session-row-time">{relativeTime(s.updatedAt, lang)}</span>
          </button>
          <div className="session-row-actions">
            {s.terminalId ? (
              <IconButton size="sm" label={t("session.openAgentTerminal")} onClick={() => openSessionTerminal(s)}>
                <SquareTerminal size={13} />
              </IconButton>
            ) : canResume(s) ? (
              <IconButton size="sm" label={t("session.resumeTerminal")} onClick={resume}>
                <RotateCcw size={13} />
              </IconButton>
            ) : null}
            {!working && (
              <IconButton size="sm" label={t("session.delete")} onClick={() => void deleteSession(s)}>
                <Trash2 size={13} />
              </IconButton>
            )}
          </div>
        </div>
      </CM.Trigger>
      <CM.Portal>
        <CM.Content className="menu" collisionPadding={8}>
          <CM.Item className="menu-item" onSelect={() => openSession(s.taskId, s.title)}>
            <Bot size={14} /> {t("session.open")}
          </CM.Item>
          {s.terminalId && (
            <CM.Item className="menu-item" onSelect={() => openSessionTerminal(s)}>
              <SquareTerminal size={14} /> {t("session.openAgentTerminal")}
            </CM.Item>
          )}
          {!s.terminalId && canResume(s) && (
            <CM.Item className="menu-item" onSelect={resume}>
              <RotateCcw size={14} /> {t("session.resumeTerminal")}
            </CM.Item>
          )}
          <CM.Item className="menu-item" onSelect={() => void navigator.clipboard?.writeText(s.title).catch(() => {})}>
            <Copy size={14} /> {t("session.copyTitle")}
          </CM.Item>
          <CM.Separator className="menu-sep" />
          <CM.Item className="menu-item menu-danger" onSelect={() => void deleteSession(s)}>
            <Trash2 size={14} /> {t("session.delete")}
          </CM.Item>
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

type Bucket = "today" | "yesterday" | "week" | "older";
function bucketOf(iso: string): Bucket {
  const d = new Date(iso);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (d.getTime() >= start.getTime()) return "today";
  if (d.getTime() >= start.getTime() - day) return "yesterday";
  if (d.getTime() >= start.getTime() - 6 * day) return "week";
  return "older";
}

export function AgentsView() {
  const t = useT();
  const list = useSessionsStore((s) => s.list);
  const refresh = useSessionsStore((s) => s.refresh);
  const inventory = useAppStore((s) => s.inventory);
  const setNewSessionOpen = useAppStore((s) => s.setNewSessionOpen);
  const [filter, setFilter] = useState<"all" | "active">("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    void useAppStore.getState().loadDiagnostics();
  }, []);

  const q = query.trim().toLowerCase();
  const sessions = (list.data ?? []).filter(
    (s) =>
      (filter === "all" || ACTIVE_STATUSES.has(s.status) || s.status === "waiting_review") &&
      (!q || `${s.title} ${s.connectorId} ${agentName(s.connectorId)}`.toLowerCase().includes(q)),
  );
  // Historique groupé (Aujourd'hui / Hier / 7 derniers jours / Plus ancien), le plus récent d'abord.
  const groups: Array<[Bucket, SessionSummary[]]> = [];
  for (const s of sessions) {
    const b = bucketOf(s.updatedAt);
    const g = groups.find(([k]) => k === b);
    if (g) g[1].push(s);
    else groups.push([b, [s]]);
  }
  const installed = (inventory.data ?? []).filter((p) => p.installed && !NON_AGENT_TOOLS.has(p.connectorId));

  return (
    <div className="sidebar-view" aria-label={t("view.agents")}>
      <SectionTitle
        actions={
          <IconButton size="sm" label={t("common.refresh")} onClick={() => void refresh()}>
            <RefreshCw size={13} className={cx(list.loading && "spin")} />
          </IconButton>
        }
      >
        {t("view.agents")}
      </SectionTitle>
      <div className="px-3 pb-3">
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          icon={<Plus size={16} />}
          onClick={() => setNewSessionOpen(true)}
        >
          {t("cmd.newSession")}
          <span className="ml-auto opacity-80">
            <Kbd spec="mod+shift+n" />
          </span>
        </Button>
      </div>
      <div className="px-3 pb-2 flex flex-col gap-2">
        <label className="relative block">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input
            className="input input-sm"
            style={{ paddingLeft: 26 }}
            placeholder={t("agents.search")}
            aria-label={t("agents.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
        </label>
        <div className="segmented w-full" role="tablist" aria-label={t("agents.filter")}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            className={cx("flex-1", filter === "all" && "is-active")}
            onClick={() => setFilter("all")}
          >
            {t("agents.all")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "active"}
            className={cx("flex-1", filter === "active" && "is-active")}
            onClick={() => setFilter("active")}
          >
            {t("agents.activeFilter")}
          </button>
        </div>
      </div>
      <div className="scroll-area flex-1" data-testid="sessions-list">
        <div className="px-2">
          <ErrorNotice error={list.error} compact />
        </div>
        {list.loading && !list.data && (
          <div className="px-3">
            <Skeleton lines={4} />
          </div>
        )}
        {list.data &&
          sessions.length === 0 &&
          (q ? (
            <p className="px-4 py-3 text-[12px] text-fg-subtle">{t("agents.noMatch")}</p>
          ) : (
            <>
              <EmptyState icon={<Bot size={24} />} title={t("agents.emptyTitle")}>
                {t("agents.emptyBody")}
              </EmptyState>
              {/* Aucun agent installé : pas de cul-de-sac, on montre comment en installer un. */}
              {inventory.data && installed.length === 0 && <AgentSetup className="px-3 pb-3" />}
            </>
          ))}
        {groups.map(([bucket, items]) => (
          <section key={bucket} aria-label={t(`agents.bucket.${bucket}`)}>
            <p className="session-bucket">{t(`agents.bucket.${bucket}`)}</p>
            {items.map((s) => (
              <SessionRow key={s.taskId} s={s} />
            ))}
          </section>
        ))}
      </div>
      <div className="sidebar-footer">
        <p className="section-subtitle !px-0 !pt-0">{t("agents.detected")}</p>
        {inventory.loading && !inventory.data && <Skeleton lines={1} />}
        {inventory.data && installed.length === 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[12px] text-fg-subtle">{t("agents.noneDetected")}</p>
            <RescanButton />
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {installed.map((p) => (
            <AgentChip
              key={p.connectorId}
              connectorId={p.connectorId}
              version={p.version}
              authenticated={p.authenticated}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
