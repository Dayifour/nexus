// « Nouvel orchestre » : un objectif, un chef d'orchestre, une équipe d'agents (avec leur spécialité), un mode,
// le niveau d'autonomie et le parallélisme. Le chef planifie, répartit, fait circuler le travail et relit tout.
import * as RDialog from "@radix-ui/react-dialog";
import { Check, Crown, Hand, Orbit, Shield, Sparkles, Users, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toNexusError, type NexusError } from "../api.ts";
import { useT } from "../i18n/index.ts";
import { useAppStore } from "../stores/app.ts";
import { useGitStore } from "../stores/git.ts";
import { useOrchestraStore } from "../stores/orchestra.ts";
import { NON_AGENT_TOOLS } from "../types.ts";
import { AgentAvatar, SPECIALTY, agentName, familyOf } from "../ui/AgentAvatar.tsx";
import { authHelp } from "../ui/AgentChip.tsx";
import { Button, ErrorNotice, Kbd, Skeleton, cx } from "../ui/primitives.tsx";
import { openOrchestra } from "../workbench/dock.ts";
import { VoiceDictation } from "./VoiceDictation.tsx";

type Mode = "autonomous" | "sandboxed" | "supervised";
const MODES: Array<{ id: Mode; icon: typeof Zap }> = [
  { id: "autonomous", icon: Zap },
  { id: "sandboxed", icon: Shield },
  { id: "supervised", icon: Hand },
];

export function NewOrchestraDialog() {
  const t = useT();
  const open = useAppStore((s) => s.orchestraDialogOpen);
  const setOpen = useAppStore((s) => s.setOrchestraDialogOpen);
  const inventory = useAppStore((s) => s.inventory);
  const capabilities = useAppStore((s) => s.capabilities.data);
  const git = useGitStore((s) => s.status.data);
  const start = useOrchestraStore((s) => s.start);
  const [goal, setGoal] = useState("");
  const [lead, setLead] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>("supervised");
  const [autonomy, setAutonomy] = useState<"full" | "approve-plan">("approve-plan");
  const [maxParallel, setMaxParallel] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NexusError>();
  const [touched, setTouched] = useState(false);
  const goalRef = useRef<HTMLTextAreaElement>(null);

  const agents = useMemo(
    () =>
      (inventory.data ?? [])
        .filter((p) => p.installed && !NON_AGENT_TOOLS.has(p.connectorId))
        .map((p) => ({ id: p.connectorId, version: p.version, unauth: p.authenticated === false })),
    [inventory.data],
  );

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setTouched(false);
    void useAppStore.getState().loadDiagnostics();
    void useGitStore.getState().refresh();
    requestAnimationFrame(() => goalRef.current?.focus());
  }, [open]);

  // Chef par défaut : claude-cli s'il est détecté ; équipe par défaut : les autres agents détectés (jusqu'à 3).
  useEffect(() => {
    if (!open || agents.length === 0) return;
    // Seuls les agents connectés peuvent diriger ou rejoindre l'orchestre (le main refuse les autres).
    const usable = agents.filter((a) => !a.unauth);
    setLead((l) =>
      l && usable.some((a) => a.id === l) ? l : ((usable.find((a) => a.id === "claude-cli") ?? usable[0])?.id ?? ""),
    );
  }, [open, agents]);
  useEffect(() => {
    if (!open || !lead) return;
    setMembers((m) => {
      const kept = m.filter((x) => agents.some((a) => a.id === x && !a.unauth));
      if (kept.length > 0) return kept;
      const others = agents.filter((a) => a.id !== lead && !a.unauth).map((a) => a.id);
      return (others.length > 0 ? others : [lead]).slice(0, 3);
    });
  }, [open, lead, agents]);

  const sandboxUnusable = capabilities?.sandbox.usable === false;
  const gitMissing = mode !== "autonomous" && git !== undefined && !git.available;
  const problems = [
    !goal.trim() && t("orch.err.goal"),
    !lead && t("orch.err.lead"),
    members.length === 0 && t("orch.err.members"),
    members.length > 6 && t("orch.err.tooMany"),
    gitMissing && t("orch.err.git"),
  ].filter((x): x is string => Boolean(x));
  const canStart = problems.length === 0 && !busy;

  const toggleMember = (id: string) =>
    setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : m.length < 6 ? [...m, id] : m));

  const submit = async () => {
    setTouched(true);
    if (!canStart) return;
    setBusy(true);
    setError(undefined);
    try {
      const text = goal.trim();
      const missionId = await start({
        goal: text,
        leadConnectorId: lead,
        memberConnectorIds: members,
        mode,
        autonomy,
        maxParallel,
      });
      setOpen(false);
      setGoal("");
      openOrchestra(missionId, text.split("\n")[0] ?? text);
    } catch (e) {
      setError(toNexusError(e, "orchestra.start"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RDialog.Root open={open} onOpenChange={setOpen}>
      <RDialog.Portal>
        <RDialog.Overlay className="overlay" />
        <RDialog.Content className="modal modal-lg new-session new-orchestra" aria-describedby={undefined}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            aria-label={t("orch.new")}
          >
            <div className="modal-header">
              <div className="flex items-center gap-3">
                <div className="new-session-icon orch-icon" aria-hidden>
                  <Orbit size={18} />
                </div>
                <div>
                  <RDialog.Title className="modal-title">{t("orch.new")}</RDialog.Title>
                  <p className="modal-desc">{t("orch.newSubtitle")}</p>
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
                  <span className="step">1</span> {t("orch.goal")}
                </legend>
                <div className="prompt-box">
                  <textarea
                    ref={goalRef}
                    className="prompt-input"
                    placeholder={t("orch.goalPlaceholder")}
                    aria-label={t("orch.goal")}
                    aria-invalid={touched && !goal.trim()}
                    value={goal}
                    rows={4}
                    maxLength={20_000}
                    onChange={(e) => setGoal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <div className="prompt-bar justify-end">
                    <VoiceDictation onInsert={(text) => setGoal((g) => (g ? `${g}\n${text}` : text))} />
                  </div>
                </div>
              </fieldset>

              <fieldset>
                <legend className="field-legend">
                  <span className="step">2</span> {t("orch.team")}
                </legend>
                {inventory.loading && !inventory.data && <Skeleton lines={2} />}
                {inventory.data && agents.length === 0 && (
                  <p className="text-[12.5px] text-fg-muted">{t("orch.noAgents")}</p>
                )}
                {agents.length > 0 && (
                  <>
                    <p className="orch-sub">
                      <Crown size={12} aria-hidden /> {t("orch.lead")}
                    </p>
                    <div className="orch-lead-row" role="radiogroup" aria-label={t("orch.lead")}>
                      {agents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          role="radio"
                          aria-checked={lead === a.id}
                          disabled={a.unauth}
                          title={a.unauth ? `${t("agents.notConnected")} — ${authHelp(t, a.id)}` : undefined}
                          className={cx("orch-chip", lead === a.id && "is-selected", a.unauth && "is-unavailable")}
                          onClick={() => setLead(a.id)}
                        >
                          <AgentAvatar label={agentName(a.id)} family={familyOf(a.id)} size={20} lead={lead === a.id} />
                          {agentName(a.id)}
                        </button>
                      ))}
                    </div>
                    <p className="orch-sub mt-3">
                      <Users size={12} aria-hidden /> {t("orch.members")}
                    </p>
                    <div className="agent-grid" role="group" aria-label={t("orch.members")}>
                      {agents.map((a) => {
                        const on = members.includes(a.id);
                        return (
                          <button
                            key={a.id}
                            type="button"
                            role="checkbox"
                            aria-checked={on}
                            className={cx("agent-card orch-member", on && "is-selected", a.unauth && "is-unavailable")}
                            disabled={a.unauth}
                            aria-describedby={a.unauth ? `orch-help-${a.id}` : undefined}
                            onClick={() => toggleMember(a.id)}
                            data-testid={`orch-member-${a.id}`}
                          >
                            <AgentAvatar label={agentName(a.id)} family={familyOf(a.id)} size={26} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{agentName(a.id)}</span>
                              {a.unauth ? (
                                <span id={`orch-help-${a.id}`} className="block text-[11px] text-warning leading-snug">
                                  {t("agents.notConnected")} — {authHelp(t, a.id)}
                                </span>
                              ) : (
                                <span className="block truncate text-[11px] text-fg-subtle">
                                  {SPECIALTY[a.id] ? t(SPECIALTY[a.id]) : t("orch.spec.other")}
                                </span>
                              )}
                            </span>
                            {on && <Check size={14} className="text-accent shrink-0" aria-hidden />}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
                <ErrorNotice error={inventory.error} compact />
              </fieldset>

              <fieldset>
                <legend className="field-legend">
                  <span className="step">3</span> {t("newSession.mode")}
                </legend>
                <div className="mode-grid" role="radiogroup" aria-label={t("newSession.mode")}>
                  {MODES.map(({ id, icon: Icon }) => {
                    const disabled = id === "sandboxed" && sandboxUnusable;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={mode === id}
                        disabled={disabled}
                        className={cx("mode-card", `mode-${id}`, mode === id && "is-selected")}
                        onClick={() => setMode(id)}
                        data-testid={`orch-mode-${id}`}
                      >
                        <span className="mode-check" aria-hidden>
                          <Check size={12} />
                        </span>
                        <span className="mode-icon" aria-hidden>
                          <Icon size={20} />
                        </span>
                        <span className="mode-title">{t(`mode.${id}`)}</span>
                        <span className="mode-desc">{t(`mode.${id}.desc`)}</span>
                        {id === "autonomous" && <span className="mode-warn">{t("mode.autonomous.warn")}</span>}
                        {id === "sandboxed" && <span className="mode-warn">{t("orch.sandboxNoBus")}</span>}
                        {disabled && <span className="mode-warn">{t("newSession.sandboxUnusable")}</span>}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="flex flex-wrap items-end gap-6">
                <div>
                  <p className="field-legend !mb-2">
                    <span className="step">4</span> {t("orch.autonomy")}
                  </p>
                  <div className="segmented" role="radiogroup" aria-label={t("orch.autonomy")}>
                    {(["full", "approve-plan"] as const).map((a) => (
                      <button
                        key={a}
                        type="button"
                        role="radio"
                        aria-checked={autonomy === a}
                        className={cx(autonomy === a && "is-active")}
                        onClick={() => setAutonomy(a)}
                      >
                        {t(`orch.autonomy.${a}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="field w-[220px]">
                  <span>{t("orch.parallel", { n: maxParallel })}</span>
                  <input
                    type="range"
                    min={1}
                    max={6}
                    value={maxParallel}
                    aria-valuetext={t("orch.parallel", { n: maxParallel })}
                    onChange={(e) => setMaxParallel(Number(e.target.value))}
                  />
                </label>
              </fieldset>

              {touched && problems.length > 0 && (
                <div className="notice notice-error" role="alert" data-testid="orch-problems">
                  <ul className="list-disc pl-4">
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!touched && gitMissing && (
                <p className="notice notice-muted" role="note">
                  {t("orch.err.git")}
                </p>
              )}
              <ErrorNotice error={error} />
            </div>

            <div className="modal-footer">
              <span className="mr-auto text-[11.5px] text-fg-subtle">
                <Kbd spec="mod+enter" /> {t("newSession.toStart")}
              </span>
              <RDialog.Close asChild>
                <Button variant="ghost">{t("common.cancel")}</Button>
              </RDialog.Close>
              <Button type="submit" variant="primary" busy={busy} icon={<Sparkles size={14} />}>
                {t("orch.launch")}
              </Button>
            </div>
          </form>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
