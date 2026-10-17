// Nouvelle session d'agent, en trois choix simples : l'agent, la consigne, le mode (trois grandes cartes).
import * as RDialog from "@radix-ui/react-dialog";
import { Bot, Check, Hand, MessageSquare, Mic, Shield, Sparkles, SquareTerminal, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toNexusError, type NexusError } from "../api.ts";
import { useT } from "../i18n/index.ts";
import { useAppStore } from "../stores/app.ts";
import { useSessionsStore } from "../stores/sessions.ts";
import { readPref, writePref } from "../stores/util.ts";
import { NON_AGENT_TOOLS, type SessionMode } from "../types.ts";
import { Button, ErrorNotice, Kbd, Skeleton, cx } from "../ui/primitives.tsx";
import { openAgentTerminal, openSession, openSideBySide } from "../workbench/dock.ts";
import { VoiceDictation } from "./VoiceDictation.tsx";
import { agentName } from "../ui/AgentAvatar.tsx";
import { authHelp } from "../ui/AgentChip.tsx";
import { AgentSetup } from "../ui/AgentSetup.tsx";

const MODES: Array<{ id: SessionMode; icon: typeof Zap }> = [
  { id: "autonomous", icon: Zap },
  { id: "sandboxed", icon: Shield },
  { id: "supervised", icon: Hand },
];

/** Agents dont la TUI interactive est proposée par défaut (mode « Terminal »). */
const TUI_AGENTS = new Set(["claude-cli", "codex-cli", "gemini-cli"]);

const isMode = (v: string | undefined): v is SessionMode =>
  v === "autonomous" || v === "sandboxed" || v === "supervised";

interface AgentChoice {
  id: string;
  label: string;
  detail?: string;
  kind: "cli" | "api";
  warn?: string;
}

export function NewSessionDialog() {
  const t = useT();
  const open = useAppStore((s) => s.newSessionOpen);
  const setOpen = useAppStore((s) => s.setNewSessionOpen);
  const inventory = useAppStore((s) => s.inventory);
  const settings = useAppStore((s) => s.settings.data);
  const capabilities = useAppStore((s) => s.capabilities.data);
  const start = useSessionsStore((s) => s.start);
  const [agent, setAgent] = useState("");
  const [customAgent, setCustomAgent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SessionMode>("supervised");
  const [dictation, setDictation] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [compare, setCompare] = useState(false);
  const [picks, setPicks] = useState<string[]>([]);
  const startMany = useSessionsStore((s) => s.startMany);
  const startInteractive = useSessionsStore((s) => s.startInteractive);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NexusError>();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const agents = useMemo<AgentChoice[]>(() => {
    const list: AgentChoice[] = (inventory.data ?? [])
      .filter((p) => p.installed && !NON_AGENT_TOOLS.has(p.connectorId))
      .map((p) => ({
        id: p.connectorId,
        label: agentName(p.connectorId),
        detail: p.version,
        kind: "cli",
        ...(p.authenticated === false && { warn: authHelp(t, p.connectorId) }),
      }));
    for (const c of settings?.apiConnectors ?? []) {
      if (c.id && !list.some((a) => a.id === c.id))
        list.push({ id: c.id, label: c.accountLabel ?? c.id, detail: `${c.provider} · ${c.model}`, kind: "api" });
    }
    return list;
  }, [inventory.data, settings?.apiConnectors, t]);

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    void useAppStore.getState().loadDiagnostics();
    const stored = readPref("nexus.sessionMode");
    setMode(isMode(stored) ? stored : (settings?.defaultMode ?? "supervised"));
    requestAnimationFrame(() => promptRef.current?.focus());
  }, [open, settings?.defaultMode]);

  useEffect(() => {
    // Premier agent connecté par défaut ; un agent non connecté n'est jamais présélectionné.
    const usable = agents.filter((a) => !a.warn);
    if ((!agent || agents.find((a) => a.id === agent)?.warn) && usable[0]) setAgent(usable[0].id);
  }, [agents, agent]);

  // TUI interactive par défaut pour les agents qui en ont une ; Conversation reste au choix.
  const connectorForView = agents.length > 0 ? agent : customAgent.trim();
  useEffect(() => {
    setInteractive(TUI_AGENTS.has(connectorForView));
  }, [connectorForView]);

  const connectorId = agents.length > 0 ? agent : customAgent.trim();
  const validConnector = /^[a-z0-9][a-z0-9-]{1,62}$/.test(connectorId);
  const sandboxUnusable = capabilities?.sandbox.usable === false;
  // En session interactive (terminal), la consigne est facultative : on dialogue ensuite avec l'agent.
  const canStart = compare
    ? picks.length >= 2 && prompt.trim().length > 0 && !busy
    : validConnector && (interactive || prompt.trim().length > 0) && !busy;

  const toggleCompare = (on: boolean) => {
    setCompare(on);
    setPicks(on && agent ? [agent] : []);
    // Plusieurs agents en mode autonome écriraient dans le même dossier : interdit.
    if (on && mode === "autonomous") setMode(sandboxUnusable ? "supervised" : "sandboxed");
  };

  const submitMany = async () => {
    const finalTitle = (title.trim() || prompt.trim().split("\n")[0] || t("newSession.compare")).slice(0, 120);
    const results = await startMany({
      connectorIds: picks,
      mode: mode === "autonomous" ? "supervised" : mode,
      prompt: prompt.trim(),
      title: finalTitle,
      interactive,
      cols: 100,
      rows: 30,
    });
    for (const r of results)
      if (r.error || !r.taskId) toast.error(`${agentName(r.connectorId)} : ${r.error ?? t("err.internal_error")}`);
    const ok = results.filter((r): r is typeof r & { taskId: string } => Boolean(r.taskId));
    if (ok.length === 0) return;
    setOpen(false);
    setPrompt("");
    setTitle("");
    openSideBySide(
      ok.map((r) => ({
        taskId: r.taskId,
        title: `${agentName(r.connectorId)} · ${finalTitle}`.slice(0, 120),
        ...(interactive && r.terminalId && { terminalId: r.terminalId }),
        ...(r.workspacePath && { cwd: r.workspacePath }),
      })),
    );
  };

  const submit = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(undefined);
    try {
      writePref("nexus.sessionMode", mode);
      if (compare) {
        await submitMany();
        return;
      }
      const finalTitle = (title.trim() || prompt.trim().split("\n")[0] || connectorId).slice(0, 120);
      if (interactive) {
        const r = await startInteractive({
          connectorId,
          mode,
          title: finalTitle,
          cols: 120,
          rows: 32,
          ...(prompt.trim() && { prompt: prompt.trim() }),
        });
        setOpen(false);
        setPrompt("");
        setTitle("");
        // Panneau de l'agent dans la zone d'édition, son terminal (TUI) dans le panneau bas, focalisé.
        openSession(r.taskId, finalTitle);
        openAgentTerminal({
          terminalId: r.terminalId,
          title: finalTitle,
          cwd: r.workspacePath,
          taskId: r.taskId,
          agent: agentName(connectorId),
        });
        return;
      }
      const taskId = await start({ connectorId, prompt: prompt.trim(), mode, title: finalTitle });
      setOpen(false);
      setPrompt("");
      setTitle("");
      openSession(taskId, finalTitle);
    } catch (e) {
      setError(toNexusError(e, "sessions.start"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RDialog.Root open={open} onOpenChange={setOpen}>
      <RDialog.Portal>
        <RDialog.Overlay className="overlay" />
        <RDialog.Content className="modal modal-lg new-session" aria-describedby={undefined}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            aria-label={t("cmd.newSession")}
          >
            <div className="modal-header">
              <div className="flex items-center gap-3">
                <div className="new-session-icon" aria-hidden>
                  <Sparkles size={18} />
                </div>
                <div>
                  <RDialog.Title className="modal-title">{t("cmd.newSession")}</RDialog.Title>
                  <p className="modal-desc">{t("newSession.subtitle")}</p>
                </div>
              </div>
              <RDialog.Close asChild>
                <button type="button" className="icon-btn" aria-label={t("common.close")}>
                  <X size={16} />
                </button>
              </RDialog.Close>
            </div>

            <div className="modal-body flex flex-col gap-5">
              <fieldset>
                <legend className="field-legend">
                  <span className="step">1</span> {compare ? t("newSession.agents") : t("newSession.agent")}
                  {agents.length >= 2 && (
                    <label className="check ml-auto font-normal text-[12px]" title={t("newSession.compareHint")}>
                      <input type="checkbox" checked={compare} onChange={(e) => toggleCompare(e.target.checked)} />
                      {t("newSession.compare")}
                    </label>
                  )}
                </legend>
                {compare && <p className="text-[11.5px] text-fg-subtle mb-2">{t("newSession.compareHint")}</p>}
                {inventory.loading && !inventory.data && <Skeleton lines={1} />}
                {agents.length > 0 ? (
                  <div className="agent-grid" role="radiogroup" aria-label={t("newSession.agent")}>
                    {agents.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        role={compare ? "checkbox" : "radio"}
                        aria-checked={compare ? picks.includes(a.id) : agent === a.id}
                        className={cx(
                          "agent-card",
                          (compare ? picks.includes(a.id) : agent === a.id) && "is-selected",
                          a.warn && "is-unavailable",
                        )}
                        disabled={Boolean(a.warn)}
                        aria-describedby={a.warn ? `agent-help-${a.id}` : undefined}
                        onClick={() => {
                          setAgent(a.id);
                          if (compare)
                            setPicks((p) =>
                              p.includes(a.id) ? p.filter((x) => x !== a.id) : p.length < 6 ? [...p, a.id] : p,
                            );
                        }}
                      >
                        <Bot size={15} aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{a.label}</span>
                          {a.warn ? (
                            <span id={`agent-help-${a.id}`} className="block text-[11px] text-warning leading-snug">
                              {t("agents.notConnected")} — {a.warn}
                            </span>
                          ) : (
                            <span className="block truncate text-[11px] text-fg-subtle">
                              {a.kind === "api" ? "API · " : "CLI · "}
                              {a.detail ?? ""}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  inventory.data && (
                    <div className="flex flex-col gap-2">
                      <p className="text-[12.5px] text-fg-muted">{t("newSession.noAgents")}</p>
                      <AgentSetup />
                      {/* Connecteur personnalisé : réservé aux cas avancés, jamais la voie par défaut. */}
                      <details className="text-[12px]">
                        <summary className="cursor-pointer text-fg-muted">{t("newSession.other")}</summary>
                        <p className="text-[11.5px] text-fg-subtle my-1">{t("newSession.otherHint")}</p>
                        <input
                          className="input font-mono"
                          placeholder="my-connector"
                          aria-label={t("newSession.connectorId")}
                          value={customAgent}
                          onChange={(e) => setCustomAgent(e.target.value.toLowerCase())}
                        />
                      </details>
                    </div>
                  )
                )}
                <ErrorNotice error={inventory.error} compact />
              </fieldset>

              <fieldset>
                <legend className="field-legend">
                  <span className="step">2</span> {t("newSession.prompt")}
                </legend>
                <div className="prompt-box">
                  <textarea
                    ref={promptRef}
                    className="prompt-input"
                    placeholder={t("newSession.promptPlaceholder")}
                    aria-label={t("newSession.prompt")}
                    value={prompt}
                    rows={5}
                    maxLength={50_000}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <div className="prompt-bar">
                    <input
                      className="prompt-title"
                      placeholder={t("newSession.titlePlaceholder")}
                      aria-label={t("newSession.title")}
                      value={title}
                      maxLength={120}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                    <button
                      type="button"
                      className={cx("icon-btn icon-btn-sm", dictation && "is-active")}
                      aria-label={t("newSession.dictate")}
                      title={t("newSession.dictate")}
                      aria-pressed={dictation}
                      onClick={() => setDictation(!dictation)}
                    >
                      <Mic size={14} />
                    </button>
                  </div>
                </div>
                {dictation && (
                  <div className="mt-2">
                    <VoiceDictation onInsert={(text) => setPrompt((p) => (p ? `${p}\n${text}` : text))} />
                  </div>
                )}
              </fieldset>

              <fieldset>
                <legend className="field-legend">
                  <span className="step">3</span> {t("newSession.mode")}
                  <span className="ml-auto segmented" role="radiogroup" aria-label={t("newSession.view")}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!interactive}
                      className={cx(!interactive && "is-active")}
                      onClick={() => setInteractive(false)}
                      title={t("newSession.viewChatHint")}
                    >
                      <MessageSquare size={12} aria-hidden /> {t("newSession.viewChat")}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={interactive}
                      className={cx(interactive && "is-active")}
                      onClick={() => setInteractive(true)}
                      title={t("newSession.viewTerminalHint")}
                    >
                      <SquareTerminal size={12} aria-hidden /> {t("newSession.viewTerminal")}
                    </button>
                  </span>
                </legend>
                <div className="mode-grid" role="radiogroup" aria-label={t("newSession.mode")}>
                  {MODES.map(({ id, icon: Icon }) => {
                    const compareBlocked = compare && id === "autonomous";
                    const disabled = (id === "sandboxed" && sandboxUnusable) || compareBlocked;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={mode === id}
                        disabled={disabled}
                        className={cx("mode-card", `mode-${id}`, mode === id && "is-selected")}
                        onClick={() => setMode(id)}
                        data-testid={`mode-${id}`}
                      >
                        <span className="mode-check" aria-hidden>
                          <Check size={12} />
                        </span>
                        <span className="mode-icon" aria-hidden>
                          <Icon size={20} />
                        </span>
                        <span className="mode-title">{t(`mode.${id}`)}</span>
                        <span className="mode-desc">{t(`mode.${id}.desc`)}</span>
                        {compareBlocked ? (
                          <span className="mode-warn">{t("newSession.compareNoAutonomous")}</span>
                        ) : (
                          disabled && <span className="mode-warn">{t("newSession.sandboxUnusable")}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <ErrorNotice error={error} />
            </div>

            <div className="modal-footer">
              <span className="mr-auto text-[11.5px] text-fg-subtle">
                <Kbd spec="mod+enter" /> {t("newSession.toStart")}
              </span>
              <RDialog.Close asChild>
                <Button variant="ghost">{t("common.cancel")}</Button>
              </RDialog.Close>
              <Button type="submit" variant="primary" busy={busy} disabled={!canStart} icon={<Sparkles size={14} />}>
                {t("newSession.start")}
              </Button>
            </div>
          </form>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
