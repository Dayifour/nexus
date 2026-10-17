// Vue d'une session d'agent, façon conversation : consigne, flux de l'agent en temps réel (événements `run` +
// historique `tasks.events`), blocs d'outils repliables, arrêt, relance avec une nouvelle consigne, changements
// proposés (diff) avec Accepter / Demander des changements, et terminal ouvert dans le dossier de la session.
import * as RTabs from "@radix-ui/react-tabs";
import {
  Bot,
  Check,
  CircleAlert,
  CircleStop,
  GitCompare,
  MessageSquare,
  RefreshCw,
  ArrowDown,
  CircleDashed,
  GitPullRequest,
  RotateCcw,
  ShieldX,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT, useTd } from "../i18n/index.ts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { call, toNexusError, type NexusError } from "../api.ts";
import { errorText } from "../lib/actions.ts";
import { useTaskContext } from "../lib/task-context.ts";
import { TERMINAL_FONT, followTheme, terminalTheme } from "./TerminalPanel.tsx";
import { canResume, isInteractiveSession, openSessionTerminal, resumeSessionTerminal } from "../lib/agent-terminal.ts";
import { allowSandboxDomain } from "../lib/sandbox-denials.ts";
import { formatQuota, quotaTone } from "../lib/quota.ts";
import { usePrDialog } from "../overlays/CreatePrDialog.tsx";
import { useRunsStore } from "../stores/runs.ts";

type RunsSnapshot = ReturnType<typeof useRunsStore.getState>;
import { ACTIVE_STATUSES, shownLive, useSessionsStore } from "../stores/sessions.ts";
import { Badge, Button, EmptyState, ErrorNotice, IconButton, Skeleton, cx } from "../ui/primitives.tsx";
import { Elapsed } from "../ui/Elapsed.tsx";
import { LiveStatus } from "../ui/LiveStatus.tsx";
import { useFrozenSelector, usePanelVisible } from "../workbench/usePanelVisible.ts";
import { useStreamView } from "./session/blocks.ts";
import { Composer } from "./session/Composer.tsx";
import { MessageList, UserMessage } from "./session/MessageList.tsx";
import { UnifiedDiff } from "../ui/UnifiedDiff.tsx";
import { openDiff, openTerminal } from "../workbench/dock.ts";
import type { PanelProps } from "../workbench/DockHost.tsx";
import { agentName } from "../ui/AgentAvatar.tsx";

const NOT_STARTED = new Set(["draft", "ready", "queued", "blocked", "pending"]);

/** Sortie enregistrée du terminal d'une session interactive terminée, relue dans un xterm en lecture seule. */
function TranscriptView({ taskId }: { taskId: string }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ loading: boolean; truncated?: boolean; empty?: boolean; error?: NexusError }>({
    loading: true,
  });
  useEffect(() => {
    let disposed = false;
    let term: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let unfollow: (() => void) | undefined;
    void call("sessions.transcript", { taskId }).then(
      (r) => {
        if (disposed) return;
        setState({ loading: false, truncated: r.truncated, empty: r.data.length === 0 });
        if (!host.current || r.data.length === 0) return;
        term = new Terminal({
          disableStdin: true,
          cursorBlink: false,
          cursorInactiveStyle: "none",
          fontFamily: TERMINAL_FONT,
          fontSize: 12.5,
          lineHeight: 1.2,
          scrollback: 50_000,
          convertEol: false,
          theme: terminalTheme(),
          minimumContrastRatio: 4.5,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host.current);
        unfollow = followTheme(term);
        const doFit = () => {
          try {
            fit.fit();
          } catch {
            // pas encore dimensionné
          }
        };
        doFit();
        observer = new ResizeObserver(() => requestAnimationFrame(doFit));
        observer.observe(host.current);
        term.write(r.data);
      },
      (e: unknown) => !disposed && setState({ loading: false, error: toNexusError(e, "sessions.transcript") }),
    );
    return () => {
      disposed = true;
      observer?.disconnect();
      unfollow?.();
      term?.dispose();
    };
  }, [taskId]);

  return (
    <section className="transcript" aria-label={t("session.transcript")} data-testid="session-transcript">
      <p className="transcript-title">
        <SquareTerminal size={13} aria-hidden /> {t("session.transcript")}
      </p>
      {state.loading && <Skeleton lines={4} />}
      <ErrorNotice error={state.error} compact />
      {state.empty && <p className="text-[12px] text-fg-subtle">{t("session.transcriptEmpty")}</p>}
      {state.truncated && <p className="text-[11.5px] text-fg-subtle mb-1">{t("session.transcriptTruncated")}</p>}
      <div ref={host} className={cx("transcript-host", (state.loading || state.empty || state.error) && "hidden")} />
    </section>
  );
}

export function SessionPanel({ params, api }: PanelProps) {
  const t = useT();
  const td = useTd();
  const taskId = params.taskId ?? "";
  const session = useSessionsStore((s) => s.list.data?.find((x) => x.taskId === taskId));
  const [resuming, setResuming] = useState(false);
  const localPrompt = useSessionsStore((s) => s.prompts[taskId]);
  const diff = useSessionsStore((s) => s.diffs[taskId]);
  const rawLive = useSessionsStore((s) => s.live[taskId]);
  const { cancel, followUp, review, loadDiff, refresh } = useSessionsStore.getState();
  // Onglet caché : le flux n'est pas suivi (aucun rendu) ; il est rattrapé d'un coup quand l'onglet réapparaît.
  const visible = usePanelVisible(api);
  const stream = useRunsStore(useFrozenSelector(visible, (s: RunsSnapshot) => s.runs[taskId]));
  const loadRun = useRunsStore((s) => s.loadRun);
  const [tab, setTab] = useState<"chat" | "changes">("chat");
  const [busy, setBusy] = useState<string | undefined>();
  const scroller = useRef<HTMLDivElement>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const stick = useRef(true);

  const entryCount = stream?.entries.length ?? 0;
  const denials = useSessionsStore((s) => s.denials[taskId]);
  const followUps = useSessionsStore((s) => s.followUps[taskId]);
  // Fil construit au fil de l'eau (seules les nouvelles entrées sont traitées à chaque événement).
  const { blocks, quota, lastFailure, runStart, runLastAt } = useStreamView(stream, followUps);
  const ctx = useTaskContext(taskId);
  const isRunning = ACTIVE_STATUSES.has(session?.status ?? ctx.status ?? "");
  const status = session?.status ?? ctx.status ?? "unknown";
  const active = ACTIVE_STATUSES.has(status);
  const live = shownLive(status, rawLive);
  const markedInteractive = useSessionsStore((s) => Boolean(s.interactive[taskId]));
  // Session en mode Terminal : PTY/indicateur local, ou aucun événement de conversation alors qu'elle ne tourne plus.
  const interactive = Boolean(
    session &&
    (markedInteractive ||
      isInteractiveSession(session) ||
      (!active && stream !== undefined && !stream.loading && !stream.error && entryCount === 0)),
  );
  const prompt = localPrompt ?? session?.prompt;

  useEffect(() => {
    if (taskId) void loadRun(taskId);
  }, [taskId, loadRun]);

  useEffect(() => {
    if (session?.title && api.title !== session.title) api.setTitle(session.title);
  }, [session?.title, api]);

  useEffect(() => {
    if (tab === "changes" && !diff) void loadDiff(taskId);
  }, [tab, diff, loadDiff, taskId]);

  // Défilement automatique tant que l'utilisateur est en bas du flux.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const act = async (name: string, fn: () => Promise<void>, success?: string) => {
    setBusy(name);
    try {
      await fn();
      if (success) toast.success(success);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };

  // Pendant un tour de conversation, les messages sont mis en file d'attente et partent à la fin du tour ; une session
  // en terminal reçoit le message dans son terminal, une session terminée ou annulée repart avec ce message.
  const composerLocked = active && !interactive;

  // Annonce des changements d'état pour les lecteurs d'écran (le flux lui-même n'est pas lu à voix haute).
  const name = agentName(session?.connectorId ?? ctx.connectorId ?? "");
  const announcement =
    live === "needs_input"
      ? t("a11y.agentNeedsInput", { name })
      : status === "failed" || live === "error"
        ? t("a11y.agentFailed", { name })
        : status === "waiting_review"
          ? t("a11y.agentReview", { name })
          : !active && (status === "completed" || live === "idle" || live === "done")
            ? t("a11y.agentDone", { name })
            : active
              ? t("a11y.agentWorking", { name })
              : undefined;

  // Pas de « Accepter / Demander des changements » sans changement à relire.
  const hasChanges = Boolean(diff?.data && diff.data.files.length > 0);

  const tone =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "waiting_review" || status === "interrupted"
          ? "warning"
          : active
            ? "accent"
            : "neutral";

  return (
    <div className="panel-fill session-panel" data-testid="session-panel">
      <header className="session-header">
        <div className="session-avatar" aria-hidden>
          <Bot size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="session-title truncate">{session?.title ?? ctx.title ?? api.title}</h2>
          <div className="flex items-center gap-2 text-[11.5px] text-fg-muted">
            <Badge tone={tone}>
              {active && <span className="live-dot" aria-hidden />}
              {td("status.", status)}
            </Badge>
            {live && (
              <Badge tone={live === "needs_input" ? "warning" : live === "error" ? "danger" : "info"}>
                {td("live.", live)}
              </Badge>
            )}
            {(session?.connectorId ?? ctx.connectorId) && (
              <span title={session?.connectorId ?? ctx.connectorId}>
                {agentName(session?.connectorId ?? ctx.connectorId ?? "")}
              </span>
            )}
            {runStart !== undefined && (
              <Elapsed className="font-mono" start={runStart} end={runLastAt} running={isRunning} />
            )}
            {session && <span>· {td("mode.", session.mode)}</span>}
            {quota && (
              <span
                className={cx("quota-chip", `quota-${quotaTone(quota)}`)}
                data-testid="session-quota"
                title={quota.status}
              >
                {formatQuota(quota)}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {session?.terminalId ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<SquareTerminal size={14} />}
              onClick={() => openSessionTerminal(session)}
            >
              {t("session.openAgentTerminal")}
            </Button>
          ) : (
            session &&
            canResume(session) && (
              <Button
                size="sm"
                variant="secondary"
                icon={<RotateCcw size={14} />}
                busy={resuming}
                onClick={() => {
                  setResuming(true);
                  void resumeSessionTerminal(session)
                    .catch((e: unknown) => toast.error(errorText(e)))
                    .finally(() => setResuming(false));
                }}
              >
                {t("session.resumeTerminal")}
              </Button>
            )
          )}
          {session?.workspacePath && (
            <Button
              size="sm"
              variant="ghost"
              icon={<SquareTerminal size={14} />}
              onClick={() => openTerminal({ cwd: session.workspacePath, label: session.title.slice(0, 40) })}
            >
              {t("session.openTerminal")}
            </Button>
          )}
          {active && (
            <Button
              size="sm"
              variant="danger"
              icon={<CircleStop size={14} />}
              busy={busy === "cancel"}
              onClick={() => void act("cancel", () => cancel(taskId), t("session.stopped"))}
            >
              {t("session.stop")}
            </Button>
          )}
          <IconButton
            size="sm"
            label={t("common.refresh")}
            onClick={() => {
              void refresh();
              void loadRun(taskId);
              if (tab === "changes") void loadDiff(taskId);
            }}
          >
            <RefreshCw size={14} />
          </IconButton>
        </div>
      </header>

      <LiveStatus message={announcement} />
      <RTabs.Root
        value={tab}
        onValueChange={(v) => setTab(v === "changes" ? "changes" : "chat")}
        className="session-tabs"
        activationMode="automatic"
      >
        <RTabs.List className="segmented mx-4 mt-3 self-start" aria-label={t("session.views")}>
          <RTabs.Trigger value="chat" className={cx(tab === "chat" && "is-active")}>
            <MessageSquare size={13} aria-hidden /> {t("session.conversation")}
          </RTabs.Trigger>
          <RTabs.Trigger value="changes" className={cx(tab === "changes" && "is-active")}>
            <GitCompare size={13} aria-hidden /> {t("session.changes")}
            {diff?.data && diff.data.files.length > 0 && <span className="count-pill">{diff.data.files.length}</span>}
          </RTabs.Trigger>
        </RTabs.List>

        {status === "waiting_review" && (
          <div className="review-banner">
            <TriangleAlert size={15} aria-hidden />
            <span className="flex-1">{t("session.reviewNeeded")}</span>
            <Button size="sm" variant="ghost" onClick={() => setTab("changes")}>
              {t("session.seeChanges")}
            </Button>
          </div>
        )}

        {denials && denials.length > 0 && (
          <details className="denials" data-testid="sandbox-denials">
            <summary>
              <ShieldX size={13} aria-hidden /> {t("sandbox.recentDenials", { n: denials.length })}
            </summary>
            <ul>
              {denials.map((d) => (
                <li key={d.target}>
                  <span className="font-mono truncate">{d.target}</span>
                  {d.count > 1 && <span className="count-pill">×{d.count}</span>}
                  <span className="truncate text-fg-subtle flex-1">{d.reason}</span>
                  <Button size="sm" variant="ghost" onClick={() => void allowSandboxDomain(d.target)}>
                    {t("sandbox.allowDomain")}
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}

        <RTabs.Content value="chat" asChild>
          <div
            ref={scroller}
            className="scroll-area session-stream"
            data-testid="session-stream"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              if (stick.current === awayFromBottom) setAwayFromBottom(!stick.current);
            }}
          >
            {status === "failed" && (
              <div className="notice notice-error mb-3" role="alert" data-testid="activity-failure">
                <CircleAlert size={15} aria-hidden />
                <div className="min-w-0">
                  <p className="notice-title">{t("activity.failedTitle")}</p>
                  {lastFailure && <p className="notice-detail whitespace-pre-wrap">{lastFailure}</p>}
                  {!lastFailure && ctx.lastFailureCode && <p className="notice-detail">{ctx.lastFailureCode}</p>}
                  {ctx.reassignments.map((r) => (
                    <p key={r} className="notice-detail flex items-center gap-1.5">
                      <RotateCcw size={12} aria-hidden /> {r}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {prompt && <UserMessage text={prompt} />}
            {stream?.loading && entryCount === 0 && <Skeleton lines={5} />}
            <ErrorNotice error={stream?.error} />
            {!stream?.loading && entryCount === 0 && !stream?.error && session && interactive && (
              // Les boutons « Ouvrir le terminal de l'agent » / « Reprendre » sont déjà dans l'en-tête : pas de doublon ici.
              <EmptyState icon={<SquareTerminal size={26} />} title={t("session.inTerminal")}>
                {session.terminalId ? t("session.inTerminalBody") : t("session.inTerminalEnded")}
              </EmptyState>
            )}
            {!stream?.loading && entryCount === 0 && !stream?.error && !active && !interactive && (
              <EmptyState icon={<Bot size={26} />} title={t("session.noEvents")} />
            )}
            {interactive && session && !session.terminalId && !active && <TranscriptView taskId={taskId} />}
            {!stream?.loading && entryCount === 0 && NOT_STARTED.has(status) && (
              <div className="activity-wait" data-testid="activity-waiting">
                <CircleDashed size={15} aria-hidden />
                {ctx.waitingFor.length > 0
                  ? t("activity.waitingFor", { tasks: ctx.waitingFor.join(", ") })
                  : t("activity.ready")}
              </div>
            )}
            <MessageList blocks={blocks} scroller={scroller} />
            {(active || live === "working") && (
              <div className="typing-row" data-testid="activity-working">
                <div className="typing" aria-hidden>
                  <span />
                  <span />
                  <span />
                </div>
                <span>{entryCount === 0 ? t("session.waitingFirst") : t("session.working")}</span>
              </div>
            )}
            {awayFromBottom && (
              <button
                type="button"
                className="go-bottom"
                onClick={() => {
                  const el = scroller.current;
                  if (!el) return;
                  el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                  stick.current = true;
                  setAwayFromBottom(false);
                }}
              >
                <ArrowDown size={13} aria-hidden /> {t("activity.goBottom")}
              </button>
            )}
          </div>
        </RTabs.Content>
        <RTabs.Content value="changes" asChild>
          <div className="scroll-area p-4">
            {diff?.loading && <Skeleton lines={8} />}
            <ErrorNotice error={diff?.error} />
            {diff?.data && (
              <>
                {diff.data.secretFindings.length > 0 && (
                  <div className="notice notice-error mb-3" role="alert">
                    <TriangleAlert size={15} aria-hidden />
                    <div>
                      <p className="notice-title">
                        {t("session.secretsFound", { n: diff.data.secretFindings.length })}
                      </p>
                      <ul className="notice-detail">
                        {diff.data.secretFindings.slice(0, 10).map((f, i) => (
                          <li key={i} className="font-mono">
                            {f.file}
                            {f.line ? `:${f.line}` : ""} — {f.kind} ({f.masked})
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
                {diff.data.files.length === 0 ? (
                  <EmptyState icon={<GitCompare size={26} />} title={t("session.noChanges")} />
                ) : (
                  <UnifiedDiff unified={diff.data.unified} onOpen={(path) => openDiff(path, taskId)} />
                )}
                {diff.data.truncated && <p className="text-[12px] text-fg-subtle mt-2">{t("session.diffTruncated")}</p>}
              </>
            )}
            <div className="review-actions">
              <p className="text-[12px] text-fg-muted flex-1">
                {hasChanges ? t("session.reviewHint") : t("session.reviewNothing")}
              </p>
              <Button
                variant="ghost"
                icon={<GitPullRequest size={14} />}
                onClick={() => usePrDialog.getState().show({ taskId, title: session?.title ?? "" })}
              >
                {t("pr.button")}
              </Button>
              {hasChanges && (
                <>
                  <Button
                    variant="secondary"
                    busy={busy === "changes"}
                    onClick={() =>
                      void act("changes", () => review(taskId, "request_changes"), t("session.changesRequested"))
                    }
                  >
                    {t("session.requestChanges")}
                  </Button>
                  <Button
                    variant="primary"
                    icon={<Check size={14} />}
                    busy={busy === "approve"}
                    onClick={() => void act("approve", () => review(taskId, "approve"), t("session.approved"))}
                  >
                    {t("session.accept")}
                  </Button>
                </>
              )}
            </div>
          </div>
        </RTabs.Content>
      </RTabs.Root>

      <Composer
        taskId={taskId}
        locked={composerLocked}
        placeholder={
          interactive && session?.terminalId
            ? t("session.followUpTerminalPlaceholder")
            : t("session.followUpPlaceholder")
        }
        onSend={(text) => followUp(taskId, text)}
      />
    </div>
  );
}
