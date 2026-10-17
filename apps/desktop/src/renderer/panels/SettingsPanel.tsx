// Réglages : apparence, langue, mode par défaut des sessions, CLI détectées, connecteurs API, secrets (valeur
// jamais réaffichée), dictée et domaines supplémentaires de la sandbox. Enregistrés par `settings.set`.
import {
  Bot,
  Info,
  KeyRound,
  Mic,
  Monitor,
  Moon,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Shield,
  Sun,
  Trash,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useT, useTd } from "../i18n/index.ts";
import { call } from "../api.ts";
import { errorText } from "../lib/actions.ts";
import { useAppStore, type ThemePref } from "../stores/app.ts";
import { useProjectStore } from "../stores/project.ts";
import { useSecretsStore } from "../stores/secrets.ts";
import type { AppSettings, SessionMode } from "../types.ts";
import { confirmAction } from "../ui/dialog.tsx";
import { Badge, Button, ErrorNotice, IconButton, Skeleton, cx } from "../ui/primitives.tsx";
import type { PanelProps } from "../workbench/DockHost.tsx";
import { agentName } from "../ui/AgentAvatar.tsx";

// Tableau vide stable : un `?? []` dans un sélecteur Zustand renverrait un nouveau tableau à chaque rendu (boucle infinie).
const NO_SECRETS: never[] = [];

type Section = "general" | "agents" | "connectors" | "secrets" | "voice" | "sandbox" | "about";

const SECTIONS: Array<[Section, typeof Palette]> = [
  ["general", Palette],
  ["agents", Bot],
  ["connectors", Plug],
  ["secrets", KeyRound],
  ["voice", Mic],
  ["sandbox", Shield],
  ["about", Info],
];

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="min-w-0">
        <p className="setting-title">{title}</p>
        {hint && <p className="setting-hint">{hint}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function General() {
  const t = useT();
  const theme = useAppStore((s) => s.theme);
  const lang = useAppStore((s) => s.lang);
  const settings = useAppStore((s) => s.settings.data);
  const { setTheme, setLang, saveSettings } = useAppStore.getState();
  const themes: Array<[ThemePref, typeof Sun]> = [
    ["dark", Moon],
    ["light", Sun],
    ["system", Monitor],
  ];
  return (
    <>
      <Row title={t("settings.theme")} hint={t("settings.themeHint")}>
        <div className="segmented" role="radiogroup" aria-label={t("settings.theme")}>
          {themes.map(([id, Icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={theme === id}
              className={cx(theme === id && "is-active")}
              onClick={() => setTheme(id)}
            >
              <Icon size={13} aria-hidden /> {t(`theme.${id}`)}
            </button>
          ))}
        </div>
      </Row>
      <Row title={t("settings.language")}>
        <div className="segmented" role="radiogroup" aria-label={t("settings.language")}>
          {(["fr", "en"] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={lang === l}
              className={cx(lang === l && "is-active")}
              onClick={() => setLang(l)}
            >
              {l === "fr" ? "Français" : "English"}
            </button>
          ))}
        </div>
      </Row>
      <Row title={t("settings.defaultMode")} hint={t("settings.defaultModeHint")}>
        <select
          className="input w-56"
          value={settings?.defaultMode ?? "supervised"}
          onChange={(e) => void saveSettings({ defaultMode: e.target.value as SessionMode })}
        >
          {(["autonomous", "sandboxed", "supervised"] as const).map((m) => (
            <option key={m} value={m}>
              {t(`mode.${m}`)}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}

function Agents() {
  const t = useT();
  const inventory = useAppStore((s) => s.inventory);
  const loadDiagnostics = useAppStore((s) => s.loadDiagnostics);
  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);
  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[12.5px] text-fg-muted">{t("settings.inventoryHint")}</p>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={13} />}
          busy={inventory.loading}
          onClick={() => void loadDiagnostics(true)}
        >
          {t("settings.rescan")}
        </Button>
      </div>
      {inventory.loading && !inventory.data && <Skeleton lines={4} />}
      <ErrorNotice error={inventory.error} />
      {inventory.data && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("settings.cli")}</th>
              <th>{t("settings.installed")}</th>
              <th>{t("settings.version")}</th>
              <th>{t("settings.auth")}</th>
            </tr>
          </thead>
          <tbody>
            {inventory.data.map((p) => (
              <tr key={p.connectorId}>
                <td title={p.connectorId}>
                  {agentName(p.connectorId)}{" "}
                  <span className="font-mono text-fg-subtle text-[11px]">{p.connectorId}</span>
                </td>
                <td>
                  {p.installed ? (
                    <Badge tone="success">{t("common.yes")}</Badge>
                  ) : (
                    <Badge tone="neutral">{t("common.no")}</Badge>
                  )}
                </td>
                <td className="font-mono text-fg-muted">{p.version ?? "—"}</td>
                <td>
                  {!p.installed
                    ? "—"
                    : p.authenticated === true
                      ? t("settings.authOk")
                      : p.authenticated === false
                        ? t("settings.authNo")
                        : t("settings.authUnknown")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

type ApiConnector = AppSettings["apiConnectors"][number];

function Connectors({ settings, served }: { settings: AppSettings; served: boolean }) {
  const t = useT();
  const save = useAppStore((s) => s.saveSettings);
  const secrets = useSecretsStore((s) => s.list.data) ?? NO_SECRETS;
  const [draft, setDraft] = useState<ApiConnector>({ provider: "anthropic", model: "", secretRef: "" });
  useEffect(() => {
    void useSecretsStore.getState().refresh();
  }, []);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const clean: ApiConnector = {
      provider: draft.provider,
      model: draft.model.trim(),
      secretRef: draft.secretRef.trim(),
      ...(draft.accountLabel?.trim() && { accountLabel: draft.accountLabel.trim() }),
    };
    void save({ apiConnectors: [...settings.apiConnectors, clean] }).then(
      (ok) => ok && setDraft({ provider: draft.provider, model: "", secretRef: "" }),
    );
  };
  return (
    <>
      <p className="text-[12.5px] text-fg-muted mb-3">{t("settings.connectorsHint")}</p>
      {settings.apiConnectors.length > 0 && (
        <table className="data-table mb-4">
          <thead>
            <tr>
              <th>{t("settings.provider")}</th>
              <th>{t("settings.model")}</th>
              <th>{t("settings.secretRef")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {settings.apiConnectors.map((c, i) => (
              <tr key={`${c.provider}-${c.model}-${i}`}>
                <td>
                  {c.provider}
                  {c.accountLabel ? <span className="text-fg-subtle"> · {c.accountLabel}</span> : null}
                </td>
                <td className="font-mono">{c.model}</td>
                <td className="font-mono text-fg-muted">{c.secretRef}</td>
                <td className="text-right">
                  <IconButton
                    size="sm"
                    label={t("common.delete")}
                    onClick={() => void save({ apiConnectors: settings.apiConnectors.filter((_, k) => k !== i) })}
                  >
                    <Trash size={13} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="grid grid-cols-2 lg:grid-cols-5 gap-2 items-end"
        onSubmit={add}
        aria-label={t("settings.addConnector")}
      >
        <label className="field">
          <span>{t("settings.provider")}</span>
          <select
            className="input"
            value={draft.provider}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value as ApiConnector["provider"] })}
          >
            {(["anthropic", "openai", "google", "openrouter"] as const).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("settings.model")}</span>
          <input
            className="input font-mono"
            required
            maxLength={120}
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{t("settings.secretRef")}</span>
          <input
            className="input font-mono"
            required
            maxLength={101}
            list="secret-refs"
            value={draft.secretRef}
            onChange={(e) => setDraft({ ...draft, secretRef: e.target.value })}
          />
          <datalist id="secret-refs">
            {secrets.map((s) => (
              <option key={s.ref} value={s.ref}>
                {s.label}
              </option>
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>{t("settings.accountLabel")}</span>
          <input
            className="input"
            maxLength={60}
            value={draft.accountLabel ?? ""}
            onChange={(e) => setDraft({ ...draft, accountLabel: e.target.value })}
          />
        </label>
        <Button type="submit" icon={<Plus size={14} />} disabled={!served}>
          {t("common.add")}
        </Button>
      </form>
    </>
  );
}

function Secrets() {
  const t = useT();
  const list = useSecretsStore((s) => s.list);
  const { refresh, set, remove } = useSecretsStore.getState();
  const [ref, setRef] = useState("");
  const [label, setLabel] = useState("");
  const [purposes, setPurposes] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void useSecretsStore.getState().refresh();
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const secretValue = value;
    // La valeur quitte le champ immédiatement (succès ou échec) : elle n'est jamais conservée ni réaffichée.
    setValue("");
    try {
      const meta = await set({
        ref: ref.trim(),
        label: label.trim(),
        purposes: purposes
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
        value: secretValue,
      });
      toast.success(t("secrets.saved", { label: meta.label }));
      setRef("");
      setLabel("");
      setPurposes("");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="text-[12.5px] text-fg-muted mb-3">{t("secrets.hint")}</p>
      {list.loading && !list.data && <Skeleton lines={3} />}
      <ErrorNotice error={list.error} />
      {list.data && list.data.length > 0 && (
        <table className="data-table mb-4">
          <thead>
            <tr>
              <th>{t("secrets.ref")}</th>
              <th>{t("secrets.label")}</th>
              <th>{t("secrets.purposes")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={s.ref}>
                <td className="font-mono">{s.ref}</td>
                <td>{s.label}</td>
                <td className="text-fg-muted">{s.purposes.join(", ")}</td>
                <td className="text-right">
                  <IconButton
                    size="sm"
                    label={t("common.delete")}
                    onClick={async () => {
                      const ok = await confirmAction({
                        title: t("secrets.deleteTitle", { label: s.label }),
                        confirmLabel: t("common.delete"),
                        cancelLabel: t("common.cancel"),
                        danger: true,
                      });
                      if (ok) await remove(s.ref).catch((err: unknown) => toast.error(errorText(err)));
                    }}
                  >
                    <Trash size={13} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="grid grid-cols-2 gap-2 items-end max-w-2xl"
        onSubmit={(e) => void submit(e)}
        aria-label={t("secrets.add")}
      >
        <label className="field">
          <span>{t("secrets.ref")}</span>
          <input
            className="input font-mono"
            required
            pattern="[a-z0-9][a-z0-9:._-]{1,100}"
            placeholder="anthropic:main"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("secrets.label")}</span>
          <input className="input" required maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("secrets.purposes")}</span>
          <input
            className="input font-mono"
            required
            placeholder="connector:anthropic"
            value={purposes}
            onChange={(e) => setPurposes(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("secrets.value")}</span>
          <input
            className="input font-mono"
            type="password"
            required
            autoComplete="off"
            maxLength={16_384}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="col-span-2 flex justify-end gap-2">
          <Button variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void refresh()}>
            {t("common.refresh")}
          </Button>
          <Button type="submit" variant="primary" busy={busy} icon={<Plus size={14} />}>
            {t("common.add")}
          </Button>
        </div>
      </form>
    </>
  );
}

function Voice({ settings, served }: { settings: AppSettings; served: boolean }) {
  const t = useT();
  const save = useAppStore((s) => s.saveSettings);
  const [v, setV] = useState(settings.voice);
  useEffect(() => setV(settings.voice), [settings.voice]);
  return (
    <form
      className="flex flex-col gap-3 max-w-2xl"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = Object.fromEntries(
          Object.entries(v).filter(([, val]) => val !== "" && val !== undefined),
        ) as AppSettings["voice"];
        void save({ voice: { ...clean, cloudOptIn: v.cloudOptIn } }).then(
          (ok) => ok && toast.success(t("settings.saved")),
        );
      }}
    >
      <p className="text-[12.5px] text-fg-muted">{t("settings.voiceHint")}</p>
      <label className="field">
        <span>{t("settings.whisperPath")}</span>
        <input
          className="input font-mono"
          maxLength={1000}
          value={v.localWhisperPath ?? ""}
          onChange={(e) => setV({ ...v, localWhisperPath: e.target.value })}
        />
      </label>
      <label className="field">
        <span>{t("settings.modelPath")}</span>
        <input
          className="input font-mono"
          maxLength={1000}
          value={v.localModelPath ?? ""}
          onChange={(e) => setV({ ...v, localModelPath: e.target.value })}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={v.cloudOptIn} onChange={(e) => setV({ ...v, cloudOptIn: e.target.checked })} />
        <span>{t("settings.cloudOptIn")}</span>
      </label>
      {v.cloudOptIn && (
        <div className="grid grid-cols-2 gap-2">
          <label className="field">
            <span>{t("settings.cloudModel")}</span>
            <input
              className="input font-mono"
              maxLength={120}
              value={v.cloudModel ?? ""}
              onChange={(e) => setV({ ...v, cloudModel: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t("settings.secretRef")}</span>
            <input
              className="input font-mono"
              maxLength={101}
              value={v.cloudSecretRef ?? ""}
              onChange={(e) => setV({ ...v, cloudSecretRef: e.target.value })}
            />
          </label>
        </div>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={!served}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

/** Protection des `.env*` du projet ouvert (décision D-4 : visibles par défaut, protection activable par projet). */
function EnvProtection() {
  const t = useT();
  const project = useProjectStore((s) => s.current);
  const [on, setOn] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const projectId = project?.projectId;
  useEffect(() => {
    setOn(undefined);
    if (!projectId) return;
    let live = true;
    call("projects.get", { projectId })
      .then((p) => live && setOn(p.protectEnvFiles))
      .catch(() => live && setOn(false));
    return () => {
      live = false;
    };
  }, [projectId]);
  if (!projectId) return <p className="setting-hint mb-4">{t("settings.envProtect.noProject")}</p>;
  return (
    <Row title={t("settings.envProtect.title")} hint={t("settings.envProtect.hint")}>
      <input
        type="checkbox"
        aria-label={t("settings.envProtect.title")}
        checked={on ?? false}
        disabled={on === undefined || busy}
        onChange={(e) => {
          const protect = e.target.checked;
          setBusy(true);
          call("projects.setEnvProtection", { projectId, protect })
            .then(() => {
              setOn(protect);
              toast.success(t(protect ? "settings.envProtect.enabled" : "settings.envProtect.disabled"));
            })
            .catch((err: unknown) => toast.error(errorText(err)))
            .finally(() => setBusy(false));
        }}
      />
    </Row>
  );
}

function Sandbox({ settings, served }: { settings: AppSettings; served: boolean }) {
  const t = useT();
  const save = useAppStore((s) => s.saveSettings);
  const caps = useAppStore((s) => s.capabilities);
  const [host, setHost] = useState("");
  const valid = /^[a-z0-9.-]{1,253}:\d{1,5}$/.test(host);
  return (
    <>
      <EnvProtection />
      <section className="mb-4">
        {caps.data ? (
          <div className="flex flex-wrap gap-2 items-center">
            <Badge tone={caps.data.sandbox.usable ? "success" : "warning"}>
              {caps.data.sandbox.usable ? t("sandbox.usable") : t("sandbox.unusable")}
            </Badge>
            {(["bwrap", "pidNamespace", "seccomp", "cgroups"] as const).map((k) => (
              <Badge key={k} tone={caps.data?.sandbox[k] ? "neutral" : "warning"}>
                {k} {caps.data?.sandbox[k] ? "✓" : "✗"}
              </Badge>
            ))}
          </div>
        ) : (
          <ErrorNotice error={caps.error} compact />
        )}
        {caps.data?.sandbox.reasons.length ? (
          <ul className="text-[12px] text-fg-muted mt-2 list-disc pl-5">
            {caps.data.sandbox.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
      </section>
      <p className="text-[12.5px] text-fg-muted mb-2">{t("settings.sandboxHint")}</p>
      <ul className="flex flex-col gap-1 mb-3 max-w-xl">
        {settings.sandboxExtraAllow.map((h) => (
          <li key={h} className="member-row">
            <span className="font-mono">{h}</span>
            <IconButton
              size="sm"
              className="ml-auto"
              label={t("common.delete")}
              onClick={() => void save({ sandboxExtraAllow: settings.sandboxExtraAllow.filter((x) => x !== h) })}
            >
              <Trash size={13} />
            </IconButton>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2 max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || settings.sandboxExtraAllow.includes(host)) return;
          void save({ sandboxExtraAllow: [...settings.sandboxExtraAllow, host] }).then((ok) => ok && setHost(""));
        }}
      >
        <input
          className="input font-mono flex-1"
          placeholder="registry.npmjs.org:443"
          aria-label={t("settings.addDomain")}
          value={host}
          onChange={(e) => setHost(e.target.value.toLowerCase())}
        />
        <Button type="submit" icon={<Plus size={14} />} disabled={!valid || !served}>
          {t("common.add")}
        </Button>
      </form>
    </>
  );
}

function About() {
  const t = useT();
  const info = useAppStore((s) => s.info.data);
  return (
    <dl className="kv">
      <dt>{t("about.version")}</dt>
      <dd>{info?.appVersion ?? "—"}</dd>
      <dt>{t("about.contracts")}</dt>
      <dd className="font-mono">{info?.contractsVersion ?? "—"}</dd>
      <dt>Electron</dt>
      <dd className="font-mono">{info?.electron ?? "—"}</dd>
      <dt>Node</dt>
      <dd className="font-mono">{info?.node ?? "—"}</dd>
      <dt>{t("about.platform")}</dt>
      <dd>{info?.platform ?? "—"}</dd>
    </dl>
  );
}

export function SettingsContent() {
  const t = useT();
  const td = useTd();
  const [section, setSection] = useState<Section>("general");
  const settings = useAppStore((s) => s.settings);
  const served = useAppStore((s) => s.settingsServed);

  useEffect(() => {
    const s = useAppStore.getState();
    if (!s.settings.data && !s.settings.loading) void s.loadSettings();
    void s.loadDiagnostics();
  }, []);

  const data = settings.data;
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label={t("view.settings")}>
        {SECTIONS.map(([id, Icon]) => (
          <button
            key={id}
            type="button"
            className={cx("settings-nav-item", section === id && "is-active")}
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
          >
            <Icon size={15} aria-hidden />
            {td("settings.section.", id)}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        <h2 className="settings-heading">{td("settings.section.", section)}</h2>
        {!served && !settings.loading && (
          <p className="notice notice-muted mb-4 text-[12.5px]">{t("settings.notServed")}</p>
        )}
        <ErrorNotice error={settings.error} />
        {section === "general" && <General />}
        {section === "agents" && <Agents />}
        {section === "connectors" && data && <Connectors settings={data} served={served} />}
        {section === "secrets" && <Secrets />}
        {section === "voice" && data && <Voice settings={data} served={served} />}
        {section === "sandbox" && data && <Sandbox settings={data} served={served} />}
        {section === "about" && <About />}
      </div>
    </div>
  );
}

export function SettingsPanel(_props: PanelProps) {
  return (
    <div className="panel-fill">
      <div className="scroll-area flex-1">
        <SettingsContent />
      </div>
    </div>
  );
}
