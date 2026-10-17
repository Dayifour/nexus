// Accueil quand aucun agent CLI n'est détecté (ou pour en ajouter un) : agents pris en charge, commande
// d'installation officielle à copier, commande de connexion, documentation, et « Rescanner » une fois installé.
import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AGENT_CATALOG } from "../../shared/agent-catalog.ts";
import { useT } from "../i18n/index.ts";
import { useAppStore } from "../stores/app.ts";
import { Button, IconButton, cx } from "./primitives.tsx";

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function CopyCommand({ command, label }: { command: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="agent-setup-cmd">
      <code title={command}>{command}</code>
      <IconButton
        size="sm"
        label={copied ? t("agentSetup.copied") : label}
        onClick={() =>
          void copy(command).then((ok) => {
            if (!ok) return;
            setCopied(true);
            toast.success(t("agentSetup.copiedToast"));
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </IconButton>
    </div>
  );
}

export function RescanButton({ size = "sm" }: { size?: "sm" | "md" }) {
  const t = useT();
  const loading = useAppStore((s) => s.inventory.loading);
  return (
    <Button
      size={size}
      variant="secondary"
      icon={<RefreshCw size={13} />}
      busy={loading}
      onClick={() => void useAppStore.getState().loadDiagnostics(true)}
      data-testid="agents-rescan"
    >
      {t("agentSetup.rescan")}
    </Button>
  );
}

export function AgentSetup({ className }: { className?: string }) {
  const t = useT();
  const inventory = useAppStore((s) => s.inventory.data);
  const detected = new Map((inventory ?? []).filter((p) => p.installed).map((p) => [p.connectorId, p]));
  return (
    <section className={cx("agent-setup", className)} aria-label={t("agentSetup.title")} data-testid="agent-setup">
      <p className="agent-setup-intro">{t("agentSetup.intro")}</p>
      <ul className="agent-setup-list">
        {AGENT_CATALOG.map((a) => {
          const probe = detected.get(a.connectorId);
          return (
            <li key={a.connectorId} className={cx("agent-setup-item", probe && "is-detected")}>
              <div className="agent-setup-head">
                <span>{a.name}</span>
                <span className="agent-setup-state">
                  {probe ? t("agentSetup.detected", { version: probe.version ?? "" }).trim() : t("agentSetup.missing")}
                </span>
              </div>
              {!probe && <CopyCommand command={a.install} label={t("agentSetup.copyInstall", { name: a.name })} />}
              <span className="agent-setup-hint">
                {t("agentSetup.loginHint", { cmd: a.login })}
                {" · "}
                <a href={a.docsUrl} target="_blank" rel="noreferrer noopener" className="agent-setup-link">
                  {t("agentSetup.docs")} <ExternalLink size={10} aria-hidden className="inline" />
                </a>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="agent-setup-actions">
        <RescanButton />
        <span className="agent-setup-hint">{t("agentSetup.rescanHint")}</span>
      </div>
    </section>
  );
}
