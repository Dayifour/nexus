// Liste des blocs d'une session. Chaque bloc est un composant mémoïsé (un nouvel événement ne re-rend que le bloc
// qui change, en pratique le dernier) et la liste est fenêtrée : seuls les derniers blocs sont dans le DOM, les plus
// anciens se chargent à la demande sans faire sauter la position de lecture.
import { Bot, ChevronDown, ChevronRight, CircleAlert, CircleCheckBig, Play, User, Wrench } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useT, useTd } from "../../i18n/index.ts";
import { Button, InfoTip, cx } from "../../ui/primitives.tsx";
import type { Block } from "./blocks.ts";

// oxlint-disable-next-line no-control-regex -- retrait volontaire des séquences ANSI du texte affiché
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
export const cleanAnsi = (s: string) => s.replace(ANSI, "");

/** Texte de l'agent : blocs de code ``` rendus en <pre>, le reste en paragraphes (jamais d'HTML interprété). */
export const RichText = memo(function RichText({ text }: { text: string }) {
  const parts = cleanAnsi(text).split(/```/);
  return (
    <div className="rich-text">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="code-block">
            <code>{part.replace(/^[a-zA-Z0-9_-]*\n/, "")}</code>
          </pre>
        ) : part.trim() ? (
          <p key={i}>{part.trim()}</p>
        ) : null,
      )}
    </div>
  );
});

function Collapsible({
  icon,
  title,
  children,
  tone,
}: {
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
  tone?: "muted";
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx("tool-block", tone === "muted" && "tool-block-muted")}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {icon}
        <span className="truncate">{title}</span>
      </button>
      {open && <div className="tool-body">{children}</div>}
    </div>
  );
}

export function UserMessage({ text }: { text: string }) {
  return (
    <div className="msg msg-user">
      <div className="msg-avatar" aria-hidden>
        <User size={14} />
      </div>
      <div className="msg-bubble">
        <RichText text={text} />
      </div>
    </div>
  );
}

const BlockView = memo(function BlockView({ block: b }: { block: Block }) {
  const t = useT();
  const td = useTd();
  switch (b.kind) {
    case "run":
      return (
        <div className="orch-feed-phase" role="separator">
          <span>{t("activity.rerun", { n: b.n })}</span>
        </div>
      );
    case "user":
      return <UserMessage text={b.text} />;
    case "text":
      return (
        <div className="msg msg-agent">
          <div className="msg-avatar msg-avatar-agent" aria-hidden>
            <Bot size={14} />
          </div>
          <div className="msg-bubble">
            <RichText text={b.text} />
          </div>
        </div>
      );
    case "stderr":
      return (
        <Collapsible tone="muted" icon={<CircleAlert size={13} aria-hidden />} title={t("session.stderr")}>
          <pre className="code-block">{cleanAnsi(b.text)}</pre>
        </Collapsible>
      );
    case "tool":
      return (
        <Collapsible
          icon={<Wrench size={13} aria-hidden />}
          title={
            <>
              {t("session.tool")} <span className="font-mono">{b.tool}</span>
            </>
          }
        >
          <p className="text-[12px] text-fg-muted">{t("session.toolRef")}</p>
          <code className="font-mono text-[12px] break-all">{b.ref}</code>
        </Collapsible>
      );
    case "usage":
      return (
        <div className="usage-chip">
          {t("session.usage", {
            input: b.event.inputTokens ?? "—",
            output: b.event.outputTokens ?? "—",
            source: td("usage.source.", b.event.source),
          })}
          {b.event.usd !== undefined && ` · ~$${b.event.usd.toFixed(4)}`}
          {b.event.caveat && <InfoTip text={b.event.caveat} />}
        </div>
      );
    case "system": {
      const text =
        b.msg === "started"
          ? t("session.started")
          : b.msg === "completed"
            ? t("session.completed")
            : `${t("session.failed")} ${b.detail ?? ""}`;
      return (
        <div className={cx("system-line", `system-${b.tone}`)}>
          {b.tone === "success" ? (
            <CircleCheckBig size={13} aria-hidden />
          ) : b.tone === "danger" ? (
            <CircleAlert size={13} aria-hidden />
          ) : (
            <Play size={12} aria-hidden />
          )}
          <span>{text}</span>
        </div>
      );
    }
  }
});

/** Blocs rendus d'un coup ; « Afficher les précédents » en ajoute autant. */
const WINDOW = 200;

export function MessageList({ blocks, scroller }: { blocks: Block[]; scroller: RefObject<HTMLDivElement | null> }) {
  const t = useT();
  const [limit, setLimit] = useState(WINDOW);
  const anchor = useRef<number | undefined>(undefined);
  const hidden = Math.max(0, blocks.length - limit);
  const visible = hidden > 0 ? blocks.slice(hidden) : blocks;

  // Après l'ajout de blocs plus anciens en haut : la position de lecture est conservée.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (anchor.current === undefined || !el) return;
    el.scrollTop += el.scrollHeight - anchor.current;
    anchor.current = undefined;
  }, [limit, scroller]);

  return (
    <>
      {hidden > 0 && (
        <Button
          size="sm"
          variant="ghost"
          className="self-center mb-2"
          onClick={() => {
            anchor.current = scroller.current?.scrollHeight;
            setLimit((l) => l + WINDOW);
          }}
        >
          {t("session.showEarlier", { n: hidden })}
        </Button>
      )}
      {visible.map((b) => (
        <BlockView key={b.key} block={b} />
      ))}
    </>
  );
}
