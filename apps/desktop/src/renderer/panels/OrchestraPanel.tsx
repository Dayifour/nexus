// Vue Orchestre : une équipe d'agents IA pilotée par un chef d'orchestre.
// En-tête (objectif, phase, durée, actions), équipe en direct, liste des tâches, fil de l'orchestre
// façon conversation d'équipe (plan, attributions, transmissions, messages entre agents, revues, synthèse),
// message au chef, validation du plan et onglet Changements (fichiers modifiés, intégration au projet).
import type { OrchestraDetail, OrchestraFeedEntry, OrchestraPhase } from "@nexus/contracts";
import {
  ArrowRight,
  ListChecks,
  CircleAlert,
  CircleStop,
  ClipboardList,
  FileDiff,
  GitMerge,
  Info,
  MessageSquare,
  Orbit,
  Repeat2,
  RotateCcw,
  TriangleAlert,
  Send,
  Sparkles,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveStatus } from "../ui/LiveStatus.tsx";
import { useFrozenSelector, usePanelVisible } from "../workbench/usePanelVisible.ts";
import { toast } from "sonner";
import { useT, useTd, type TKey } from "../i18n/index.ts";
import { errorText } from "../lib/actions.ts";
import { toNexusError } from "../api.ts";
import { mergeFeed, useOrchestraStore } from "../stores/orchestra.ts";
import { AgentAvatar, agentName, familyOf, type AgentFamily } from "../ui/AgentAvatar.tsx";
import { Badge, Button, EmptyState, ErrorNotice, Kbd, Skeleton, cx } from "../ui/primitives.tsx";
import { openTerminal } from "../workbench/dock.ts";
import type { PanelProps } from "../workbench/DockHost.tsx";
import { openTaskActivity } from "../lib/task-context.ts";

type Task = OrchestraDetail["tasks"][number];

const ACTIVE_PHASES = new Set<OrchestraPhase>(["planning", "awaiting_approval", "running", "summarizing"]);
const RUNNING = new Set(["running", "queued", "waiting_input"]);
const EMPTY_FEED: OrchestraFeedEntry[] = [];
const PHASES = new Set<string>([
  "planning",
  "awaiting_approval",
  "running",
  "summarizing",
  "done",
  "failed",
  "stopped",
]);

function taskTone(status: string): "running" | "done" | "failed" | "review" | "pending" {
  if (RUNNING.has(status)) return "running";
  if (status === "completed" || status === "done") return "done";
  if (status === "failed" || status === "cancelled" || status === "interrupted") return "failed";
  if (status === "waiting_review") return "review";
  return "pending";
}

function duration(fromIso: string, to: number): string {
  const s = Math.max(0, Math.round((to - new Date(fromIso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
/** Durée de l'orchestre, mise à jour chaque seconde dans ce seul composant (pas tout le panneau). */
function OrchElapsed({ from, lastAt, running }: { from: string; lastAt?: number; running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return <span className="font-mono">{duration(from, running ? now : (lastAt ?? now))}</span>;
}
/** Verdict d'une revue : champ structuré `verdict` du main ; repli sur le texte pour les anciennes entrées. */
/** Une revue est « acceptée » ou demande des « corrections », d'après le texte du chef. */
const reviewAccepted = (text: string) =>
  !/correction|changes requested|à corriger|refus|reject|rework/i.test(text) &&
  /accept|approuv|approved|ok\b|valid/i.test(text);

/** Le rôle répète-t-il simplement le nom de l'agent (« Codex CLI » pour codex-cli) ? */
const sameName = (role: string, connectorId: string) => {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const r = norm(role);
  return (
    !r || r === norm(agentName(connectorId)) || r === norm(connectorId) || norm(agentName(connectorId)).startsWith(r)
  );
};

/** Réattribution d'une tâche après l'échec d'un agent (texte localisé par le main). */
export const isReassign = (e: OrchestraFeedEntry) =>
  e.kind === "assign" && (e.reassigned ?? /reassign|réattribu|réaffect/i.test(e.text));
const reasonOf = (text: string) => text.match(/\(([^)]+)\)/)?.[1];

// --- Tâches (liste simple) ------------------------------------------------------------------------------------------

function TaskList({ detail }: { detail: OrchestraDetail }) {
  const t = useT();
  const td = useTd();
  if (detail.tasks.length === 0)
    return (
      <EmptyState icon={<ListChecks size={24} />} title={t("orch.noTasks")}>
        {detail.phase === "planning" ? t("orch.planningHint") : null}
      </EmptyState>
    );
  const byRef = new Map<string, Task>();
  for (const task of detail.tasks) {
    byRef.set(task.taskId, task);
    byRef.set(task.key, task);
  }
  return (
    <section className="orch-tasks" aria-label={t("orch.tasks")}>
      <p className="orch-section-title">
        <ListChecks size={13} aria-hidden /> {t("orch.tasks")}
      </p>
      <ul data-testid="orch-tasks">
        {detail.tasks.map((task) => {
          const member = detail.members.find((m) => m.agentId === task.agentId);
          const tone = taskTone(task.status);
          const after = task.dependsOn.map((d) => byRef.get(d)?.title).filter((x): x is string => Boolean(x));
          return (
            <li key={task.taskId}>
              <button
                type="button"
                className={cx("orch-task", `is-${tone}`)}
                onClick={() => openTaskActivity(task.taskId, task.title)}
                title={t("orch.openTask")}
              >
                <span className={cx("orch-task-dot", `is-${tone}`)} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="orch-task-title">{task.title}</span>
                  <span className="orch-task-meta">
                    {member ? agentName(member.connectorId) : t("orch.unassigned")}
                    {after.length > 0 && ` · ${t("orch.after", { tasks: after.join(", ") })}`}
                  </span>
                </span>
                {task.reviewRounds > 0 && (
                  <span className="orch-rounds" title={t("orch.reviewRounds", { n: task.reviewRounds })}>
                    <Repeat2 size={10} aria-hidden /> {task.reviewRounds}
                  </span>
                )}
                <span className={cx("orch-node-status", `is-${tone}`)}>{td("status.", task.status)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// --- Équipe --------------------------------------------------------------------------------------------------------

function Team({ detail }: { detail: OrchestraDetail }) {
  const t = useT();
  const members = [...detail.members].sort((a, b) => Number(b.lead) - Number(a.lead));
  return (
    <div className="orch-team" aria-label={t("orch.team")} data-testid="orch-team">
      {members.map((m) => {
        const tasks = detail.tasks.filter((x) => x.agentId === m.agentId);
        const working = tasks.some((x) => RUNNING.has(x.status));
        const review = tasks.some((x) => x.status === "waiting_review");
        const done = tasks.length > 0 && tasks.every((x) => taskTone(x.status) === "done");
        const failedAny = tasks.some((x) => taskTone(x.status) === "failed");
        const leadBusy = m.lead && (detail.phase === "planning" || detail.phase === "summarizing");
        const state =
          working || leadBusy ? "working" : failedAny ? "error" : review ? "waiting" : done ? "done" : undefined;
        const label =
          working || leadBusy
            ? t("orch.member.working")
            : failedAny
              ? t("orch.member.failed")
              : review
                ? t("orch.member.review")
                : done
                  ? t("orch.member.done")
                  : t("orch.member.waiting");
        return (
          <div key={m.agentId} className={cx("orch-member-card", m.lead && "is-lead", state && `is-${state}`)}>
            <AgentAvatar
              label={agentName(m.connectorId)}
              family={familyOf(m.connectorId)}
              size={34}
              lead={m.lead}
              state={state}
            />
            <div className="min-w-0">
              <p className="orch-member-name">
                {agentName(m.connectorId)}
                {m.lead && <span className="orch-lead-badge">{t("orch.lead")}</span>}
              </p>
              {/* Rôle affiché seulement s'il apporte une information (pas le nom de l'agent répété). */}
              {!m.lead && !sameName(m.role, m.connectorId) && <p className="orch-member-role">{m.role}</p>}
              <p className={cx("orch-member-state", state && `is-${state}`)}>
                {label}
                {tasks.length > 0 && ` · ${t("orch.tasksCount", { n: tasks.length })}`}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Fil de l'orchestre ------------------------------------------------------------------------------------------------

const FeedItem = memo(function FeedItem({
  e,
  familyFor,
}: {
  e: OrchestraFeedEntry;
  familyFor(role?: string): AgentFamily;
}) {
  const t = useT();
  const td = useTd();
  const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const who = (role?: string) => (
    <span className="orch-who">
      <AgentAvatar label={role ?? "?"} family={familyFor(role)} size={18} />
      {role}
    </span>
  );
  switch (e.kind) {
    case "phase":
      return (
        <div className="orch-feed-phase" role="separator">
          <span>{PHASES.has(e.text) ? td("orch.phase.", e.text) : e.text}</span>
        </div>
      );
    case "plan":
      return (
        <article className="orch-card orch-card-plan">
          <header>
            <ClipboardList size={14} aria-hidden /> {t("orch.feed.plan")}
            {e.from && <span className="ml-auto">{who(e.from)}</span>}
          </header>
          <p className="whitespace-pre-wrap">{e.text}</p>
        </article>
      );
    case "summary":
      return (
        <article className="orch-card orch-card-summary" data-testid="orch-summary">
          <header>
            <Sparkles size={14} aria-hidden /> {t("orch.feed.summary")}
            {e.from && <span className="ml-auto">{who(e.from)}</span>}
          </header>
          <p className="whitespace-pre-wrap">{e.text}</p>
        </article>
      );
    case "assign":
      if (isReassign(e)) {
        const reason = reasonOf(e.text);
        return (
          <div className="orch-bubble is-reassign" data-testid="orch-reassign">
            <div className="orch-bubble-head">
              <RotateCcw size={13} className="text-warning" aria-hidden />
              {who(e.from)}
              {e.to && (
                <>
                  <ArrowRight size={12} className="text-fg-subtle" aria-hidden />
                  {who(e.to)}
                </>
              )}
              <Badge tone="warning">{t("orch.reassigned")}</Badge>
              <time className="orch-time">{time}</time>
            </div>
            <p className="whitespace-pre-wrap">{e.text}</p>
            {reason && <p className="orch-reason">{reason}</p>}
          </div>
        );
      }
    // fallthrough
    case "message":
    case "handoff": {
      const accent = e.kind === "message" ? "is-message" : e.kind === "handoff" ? "is-handoff" : "is-assign";
      return (
        <div className={cx("orch-bubble", accent)} data-testid={`orch-${e.kind}`}>
          <div className="orch-bubble-head">
            {who(e.from)}
            {e.to && (
              <>
                <ArrowRight size={12} className="text-fg-subtle" aria-hidden />
                {who(e.to)}
              </>
            )}
            <span className="orch-kind">{t(`orch.feed.${e.kind}` as TKey)}</span>
            <time className="orch-time">{time}</time>
          </div>
          <p className="whitespace-pre-wrap">{e.text}</p>
        </div>
      );
    }
    case "review": {
      const ok = e.verdict ? e.verdict === "approved" : reviewAccepted(e.text);
      return (
        <div className={cx("orch-bubble is-review", ok ? "is-accepted" : "is-changes")} data-testid="orch-review">
          <div className="orch-bubble-head">
            {who(e.from)}
            {e.to && (
              <>
                <ArrowRight size={12} className="text-fg-subtle" aria-hidden />
                {who(e.to)}
              </>
            )}
            <Badge tone={ok ? "success" : "warning"}>{ok ? t("orch.review.accepted") : t("orch.review.changes")}</Badge>
            <time className="orch-time">{time}</time>
          </div>
          <p className="whitespace-pre-wrap">{e.text}</p>
        </div>
      );
    }
    case "error":
      return (
        <div className="orch-line is-error">
          <CircleAlert size={13} aria-hidden /> <span className="whitespace-pre-wrap">{e.text}</span>
          <time className="orch-time">{time}</time>
        </div>
      );
    default:
      return (
        <div className="orch-line">
          {e.kind === "start" ? <Sparkles size={12} aria-hidden /> : <Info size={12} aria-hidden />}
          {e.from && <strong className="font-medium">{e.from}</strong>}
          <span className="whitespace-pre-wrap">{e.text}</span>
          <time className="orch-time">{time}</time>
        </div>
      );
  }
});

function Feed({ feed, familyFor }: { feed: OrchestraFeedEntry[]; familyFor(role?: string): AgentFamily }) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [feed.length]);
  return (
    <div
      ref={scroller}
      className="orch-feed scroll-area"
      role="log"
      aria-label={t("orch.feed")}
      // Le fil n'est pas lu en continu (illisible pendant le travail des agents) : les changements de phase sont
      // annoncés par la région d'état du panneau.
      aria-live="off"
      data-testid="orch-feed"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {feed.length === 0 ? (
        <p className="px-3 py-4 text-[12px] text-fg-subtle">{t("orch.feedEmpty")}</p>
      ) : (
        feed.map((e, i) => <FeedItem key={`${e.at}-${i}`} e={e} familyFor={familyFor} />)
      )}
    </div>
  );
}

// --- Changements ---------------------------------------------------------------------------------------------------

function Changes({ missionId, canMerge }: { missionId: string; canMerge: boolean }) {
  const t = useT();
  const changes = useOrchestraStore((s) => s.changes[missionId]);
  const loadChanges = useOrchestraStore((s) => s.loadChanges);
  const merge = useOrchestraStore((s) => s.merge);
  const [busy, setBusy] = useState(false);
  // Intégration refusée pour conflits : message persistant avec la liste des fichiers (pas un toast éphémère).
  const [conflict, setConflict] = useState<{ message: string; files: string[] }>();
  useEffect(() => {
    void loadChanges(missionId);
  }, [missionId, loadChanges]);
  const files = changes?.data ?? [];
  const totals = files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 });
  return (
    <div className="scroll-area p-4" data-testid="orch-changes">
      {changes?.loading && !changes.data && <Skeleton lines={5} />}
      <ErrorNotice error={changes?.error} />
      {changes?.data && files.length === 0 && <EmptyState icon={<FileDiff size={24} />} title={t("orch.noChanges")} />}
      {files.length > 0 && (
        <>
          <div className="flex items-center gap-3 mb-2 text-[12.5px]">
            <span>{t("orch.filesChanged", { n: files.length })}</span>
            <span className="text-success">+{totals.add}</span>
            <span className="text-danger">−{totals.del}</span>
            {canMerge && (
              <Button
                className="ml-auto"
                size="sm"
                variant="primary"
                icon={<GitMerge size={13} />}
                busy={busy}
                onClick={() => {
                  setBusy(true);
                  setConflict(undefined);
                  void merge(missionId)
                    .then((summary) => toast.success(summary || t("orch.merged")))
                    .catch((e: unknown) => {
                      const err = toNexusError(e, "orchestra.merge");
                      if (err.code !== "conflict") return toast.error(errorText(e));
                      // « … conflits dans a.ts, b.ts… » : la liste suit les deux-points.
                      const list = err.message
                        .split(/:\s*/)
                        .slice(1)
                        .join(": ")
                        .replace(/^(conflits dans|conflicts in)\s*/i, "");
                      const files = list
                        .split(/,\s*/)
                        .map((f) => f.replace(/…$/, "").trim())
                        .filter(Boolean);
                      setConflict({ message: err.message, files });
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {t("orch.merge")}
              </Button>
            )}
          </div>
          {conflict && (
            <div className="notice notice-error mb-3" role="alert" data-testid="orch-merge-conflict">
              <TriangleAlert size={15} aria-hidden />
              <div className="min-w-0">
                <p className="notice-title">{t("orch.mergeConflictTitle")}</p>
                <p className="notice-detail">{t("orch.mergeConflictBody")}</p>
                {conflict.files.length > 0 ? (
                  <ul className="notice-detail font-mono">
                    {conflict.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="notice-detail whitespace-pre-wrap">{conflict.message}</p>
                )}
              </div>
            </div>
          )}
          <ul className="orch-files">
            {files.map((f) => (
              <li key={f.path}>
                <span className={cx("orch-file-status", `is-${f.status.toLowerCase().slice(0, 1)}`)}>{f.status}</span>
                <span className="font-mono truncate flex-1">{f.path}</span>
                <span className="text-success font-mono">+{f.additions}</span>
                <span className="text-danger font-mono">−{f.deletions}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Phase « failed » : résumé des erreurs et réattributions du fil, en tête de vue (rien à deviner). */
function FailureBanner({ feed }: { feed: OrchestraFeedEntry[] }) {
  const t = useT();
  const items = feed.filter((e) => e.kind === "error" || isReassign(e)).slice(-6);
  return (
    <div className="orch-failed" role="alert" data-testid="orch-failed">
      <CircleAlert size={16} className="shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold text-[13px]">{t("orch.failedTitle")}</p>
        {items.length === 0 ? (
          <p className="text-[12.5px]">{t("orch.failedNoDetail")}</p>
        ) : (
          <>
            <p className="text-[12px] opacity-80">{t("orch.failedBody")}</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-[12.5px]">
              {items.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex gap-1.5">
                  {isReassign(e) ? (
                    <RotateCcw size={12} className="mt-1 shrink-0" aria-hidden />
                  ) : (
                    <CircleAlert size={12} className="mt-1 shrink-0" aria-hidden />
                  )}
                  <span className="whitespace-pre-wrap">
                    {e.from && !e.text.startsWith(e.from) && <strong className="font-medium">{e.from} : </strong>}
                    {e.text}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// --- Panneau -------------------------------------------------------------------------------------------------------

export function OrchestraPanel({ params, api }: PanelProps) {
  const t = useT();
  const td = useTd();
  const missionId = params.missionId ?? "";
  const res = useOrchestraStore((s) => s.details[missionId]);
  // Onglet caché : le fil en direct n'est pas suivi (aucun rendu) ; rattrapé dès que l'onglet réapparaît.
  const visible = usePanelVisible(api);
  const live = useOrchestraStore(
    useFrozenSelector(visible, (s: ReturnType<typeof useOrchestraStore.getState>) => s.live[missionId] ?? EMPTY_FEED),
  );
  const summary = useOrchestraStore((s) => s.list.data?.find((x) => x.missionId === missionId));
  const { load, approvePlan, stop, resume, message } = useOrchestraStore.getState();
  const [tab, setTab] = useState<"overview" | "changes">("overview");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string>();
  const detail = res?.data;

  useEffect(() => {
    if (missionId) void load(missionId);
  }, [missionId, load]);

  const phase: OrchestraPhase | undefined =
    detail?.phase ??
    summary?.phase ??
    ([...live].reverse().find((e) => e.kind === "phase" && PHASES.has(e.text))?.text as OrchestraPhase | undefined);
  const active = phase ? ACTIVE_PHASES.has(phase) : live.length > 0;

  const goal =
    detail?.goal ?? summary?.goal ?? live.find((e) => e.kind === "plan")?.text.split("\n")[0] ?? t("orch.untitled");
  useEffect(() => {
    const title = goal.split("\n")[0]?.slice(0, 60) ?? goal;
    if (title && api.title !== title) api.setTitle(title);
  }, [goal, api]);

  const feed = useMemo(() => mergeFeed(detail?.feed ?? [], live), [detail?.feed, live]);
  const lead = detail?.members.find((m) => m.lead);
  const members = detail?.members;
  // Stable tant que l'équipe ne change pas : les entrées mémoïsées du fil ne se re-rendent pas à chaque événement.
  const familyFor = useCallback(
    (role?: string): AgentFamily => {
      const f = familyOf(role);
      if (f === "lead" && lead) return familyOf(lead.connectorId);
      if (f !== "other") return f;
      const m = members?.find((x) => x.role === role || agentName(x.connectorId) === role);
      return m ? familyOf(m.connectorId) : "other";
    },
    [members, lead],
  );
  const createdAt = detail?.createdAt ?? summary?.createdAt ?? feed[0]?.at;
  const lastAt = feed.length > 0 ? new Date(feed[feed.length - 1]?.at ?? "").getTime() : undefined;

  const act = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    void act("message", async () => {
      await message(missionId, text);
      setDraft("");
      useOrchestraStore.getState().pushEntry(missionId, {
        at: new Date().toISOString(),
        kind: "message",
        text,
        from: t("orch.you"),
        to: t("orch.conductor"),
      });
    });
  };

  return (
    <div className="panel-fill orch-panel" data-testid="orchestra-panel">
      <LiveStatus message={phase ? t("a11y.orchPhase", { phase: td("orch.phase.", phase) }) : undefined} />
      <header className="orch-header">
        <div className="orch-header-icon" aria-hidden>
          <Orbit size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="orch-goal" title={goal}>
            {goal}
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-fg-muted">
            {phase && (
              <span className={cx("orch-phase", `is-${phase}`, active && "is-live")} data-testid="orch-phase">
                <span className="orch-phase-dot" aria-hidden />
                {td("orch.phase.", phase)}
              </span>
            )}
            {createdAt && <OrchElapsed from={createdAt} lastAt={lastAt} running={active} />}
            {detail && (
              <span>
                {t(`mode.${detail.mode}`)} · {t(`orch.autonomy.${detail.autonomy}`)}
              </span>
            )}
            {detail?.branch && <span className="font-mono truncate">{detail.branch}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {detail?.workspacePath && (
            <Button
              size="sm"
              variant="ghost"
              icon={<SquareTerminal size={14} />}
              onClick={() => openTerminal({ cwd: detail.workspacePath, label: t("orch.terminalLabel") })}
            >
              {t("orch.openTerminal")}
            </Button>
          )}
          {phase === "done" && tab !== "changes" && (
            <Button size="sm" variant="primary" icon={<GitMerge size={14} />} onClick={() => setTab("changes")}>
              {t("orch.merge")}
            </Button>
          )}
          {(phase === "stopped" || phase === "failed") && (
            <Button
              size="sm"
              variant="primary"
              icon={<RotateCcw size={14} />}
              busy={busy === "resume"}
              data-testid="orch-resume"
              onClick={() => void act("resume", () => resume(missionId), t("orch.resumed"))}
            >
              {t("orch.resume")}
            </Button>
          )}
          {active && phase && (
            <Button
              size="sm"
              variant="danger"
              icon={<CircleStop size={14} />}
              busy={busy === "stop"}
              onClick={() => void act("stop", () => stop(missionId), t("orch.stopped"))}
            >
              {t("orch.stop")}
            </Button>
          )}
        </div>
      </header>

      {phase === "awaiting_approval" && (
        <div className="orch-approve" role="region" aria-label={t("orch.approveTitle")} data-testid="orch-approve">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-[13px]">{t("orch.approveTitle")}</p>
            {detail?.planSummary && <p className="whitespace-pre-wrap text-[12.5px] mt-1">{detail.planSummary}</p>}
          </div>
          <Button
            variant="primary"
            icon={<Sparkles size={14} />}
            busy={busy === "approve"}
            onClick={() => void act("approve", () => approvePlan(missionId), t("orch.approved"))}
          >
            {t("orch.approve")}
          </Button>
        </div>
      )}

      {phase === "failed" && <FailureBanner feed={feed} />}

      <div className="segmented mx-4 mt-3 self-start" role="tablist" aria-label={t("orch.views")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "overview"}
          className={cx(tab === "overview" && "is-active")}
          onClick={() => setTab("overview")}
        >
          <Workflow size={13} aria-hidden /> {t("orch.overview")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "changes"}
          className={cx(tab === "changes" && "is-active")}
          onClick={() => setTab("changes")}
        >
          <FileDiff size={13} aria-hidden /> {t("orch.changes")}
        </button>
      </div>

      {tab === "changes" ? (
        <Changes missionId={missionId} canMerge={phase === "done"} />
      ) : (
        <div className="orch-body">
          <section className="orch-left">
            <div className="px-4 pt-3">
              {/* Détail introuvable mais fil en direct présent : l'état vide ci-dessous suffit (pas de double message). */}
              {!(res?.error?.code === "not_found" && feed.length > 0) && <ErrorNotice error={res?.error} compact />}
            </div>
            {res?.loading && !detail && (
              <div className="p-4">
                <Skeleton lines={4} />
              </div>
            )}
            {detail && <Team detail={detail} />}
            {detail && <TaskList detail={detail} />}
            {!detail && !res?.loading && (
              <EmptyState icon={<Workflow size={24} />} title={t("orch.noTasks")}>
                {t("orch.liveOnly")}
              </EmptyState>
            )}
          </section>
          <section className="orch-right" aria-label={t("orch.feed")}>
            <p className="orch-section-title">
              <MessageSquare size={13} aria-hidden /> {t("orch.feed")}
            </p>
            <Feed feed={feed} familyFor={familyFor} />
            {detail?.finalSummary && !feed.some((e) => e.kind === "summary") && (
              <article className="orch-card orch-card-summary mx-3 mb-2">
                <header>
                  <Sparkles size={14} aria-hidden /> {t("orch.feed.summary")}
                </header>
                <p className="whitespace-pre-wrap">{detail.finalSummary}</p>
              </article>
            )}
            <footer className="composer">
              <textarea
                className="composer-input"
                placeholder={t("orch.messagePlaceholder")}
                aria-label={t("orch.messageToLead")}
                value={draft}
                rows={2}
                maxLength={8000}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="composer-bar">
                <span className="text-[11px] text-fg-subtle">
                  <Kbd spec="mod+enter" /> {t("session.toSend")}
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Send size={13} />}
                  disabled={!draft.trim()}
                  busy={busy === "message"}
                  onClick={send}
                >
                  {t("orch.send")}
                </Button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
