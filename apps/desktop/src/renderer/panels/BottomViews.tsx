// Onglets du panneau bas autres que les terminaux :
// - « Sortie de l'agent » : flux brut de la session choisie (texte, erreurs, outils), comme le panneau Sortie de VS Code ;
// - « Journal » : événements de l'application et erreurs affichées, filtrables.
import { Bot, Eraser, ScrollText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT, useTd } from "../i18n/index.ts";
import { useLogStore } from "../stores/log.ts";
import { useRunsStore, type RunEntry } from "../stores/runs.ts";
import { ACTIVE_STATUSES, useSessionsStore } from "../stores/sessions.ts";
import { EmptyState, IconButton, cx } from "../ui/primitives.tsx";
import type { PanelProps } from "../workbench/DockHost.tsx";
import { agentName } from "../ui/AgentAvatar.tsx";

// oxlint-disable-next-line no-control-regex -- retrait volontaire des séquences ANSI du texte affiché
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const EMPTY: RunEntry[] = [];

function lineOf(
  e: RunEntry["event"],
  t: ReturnType<typeof useT>,
): { text: string; tone?: "error" | "muted" } | undefined {
  switch (e.kind) {
    case "output":
      return { text: e.text.replace(ANSI, ""), ...(e.channel === "stderr" && { tone: "error" as const }) };
    case "tool-request":
      return { text: `▸ ${e.tool}`, tone: "muted" };
    case "started":
      return { text: `— ${t("session.started")} —`, tone: "muted" };
    case "completed":
      return { text: `— ${t("session.completed")} —`, tone: "muted" };
    case "failed":
      return { text: `— ${t("session.failed")} [${e.code}] ${e.message}`, tone: "error" };
    default:
      return undefined;
  }
}

export function AgentOutputPanel(_props: PanelProps) {
  const t = useT();
  const td = useTd();
  const sessions = useSessionsStore((s) => s.list.data);
  const [chosen, setChosen] = useState<string>("");
  // Par défaut : la session en cours la plus récente, sinon la plus récente.
  const fallback = useMemo(
    () => sessions?.find((s) => ACTIVE_STATUSES.has(s.status))?.taskId ?? sessions?.[0]?.taskId ?? "",
    [sessions],
  );
  const taskId = chosen && sessions?.some((s) => s.taskId === chosen) ? chosen : fallback;
  const entries = useRunsStore((s) => (taskId ? (s.runs[taskId]?.entries ?? EMPTY) : EMPTY));
  const loadRun = useRunsStore((s) => s.loadRun);
  const scroller = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (taskId && !useRunsStore.getState().runs[taskId]) void loadRun(taskId);
  }, [taskId, loadRun]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const lines = useMemo(() => entries.map((e) => ({ key: e.key, line: lineOf(e.event, t) })), [entries, t]);

  return (
    <div className="panel-fill bottom-view" data-testid="agent-output">
      <div className="terminal-toolbar">
        <select
          className="input input-sm max-w-[360px]"
          aria-label={t("bottom.chooseSession")}
          value={taskId}
          onChange={(e) => setChosen(e.target.value)}
        >
          {(sessions ?? []).map((s) => (
            <option key={s.taskId} value={s.taskId}>
              {agentName(s.connectorId)} · {s.title.slice(0, 60)} — {td("status.", s.status)}
            </option>
          ))}
        </select>
      </div>
      {!taskId ? (
        <EmptyState icon={<Bot size={24} />} title={t("bottom.noSession")} />
      ) : lines.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-fg-subtle">{t("bottom.noOutput")}</p>
      ) : (
        <pre ref={scroller} className="output-text scroll-area">
          {lines.map(({ key, line }) =>
            line ? (
              <span
                key={key}
                className={cx(line.tone === "error" && "text-danger", line.tone === "muted" && "text-fg-subtle")}
              >
                {line.text}
                {line.text.endsWith("\n") ? "" : "\n"}
              </span>
            ) : null,
          )}
        </pre>
      )}
    </div>
  );
}

export function LogPanel(_props: PanelProps) {
  const t = useT();
  const entries = useLogStore((s) => s.entries);
  const clear = useLogStore((s) => s.clear);
  const [level, setLevel] = useState<"all" | "warn" | "error">("all");
  const [filter, setFilter] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (level === "all" || (level === "warn" ? e.level !== "info" : e.level === "error")) &&
        (!q || `${e.source} ${e.text}`.toLowerCase().includes(q)),
    );
  }, [entries, level, filter]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div className="panel-fill bottom-view" data-testid="log-panel">
      <div className="terminal-toolbar">
        <div className="segmented" role="tablist" aria-label={t("bottom.level")}>
          {(["all", "warn", "error"] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={level === l}
              className={cx(level === l && "is-active")}
              onClick={() => setLevel(l)}
            >
              {t(`bottom.level.${l}`)}
            </button>
          ))}
        </div>
        <input
          className="input input-sm w-52"
          placeholder={t("bottom.filter")}
          aria-label={t("bottom.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="ml-auto">
          <IconButton size="sm" label={t("bottom.clearLog")} onClick={clear}>
            <Eraser size={13} />
          </IconButton>
        </div>
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={<ScrollText size={24} />} title={t("bottom.emptyLog")} />
      ) : (
        <div ref={scroller} className="scroll-area log-lines" role="log">
          {shown.map((e) => (
            <div key={e.id} className={cx("log-line", `log-${e.level}`)}>
              <span className="log-time">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="log-source">{e.source}</span>
              <span className="log-text">{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
