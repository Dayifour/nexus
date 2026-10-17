// Composeur d'une session : Entrée envoie, Maj+Entrée va à la ligne (Ctrl/Cmd+Entrée envoie aussi). Pendant un tour
// de l'agent, on peut continuer à écrire : le message est mis en file d'attente (pastille annulable) et part tout
// seul à la fin du tour. La file survit à la fermeture et à la réouverture du panneau (par session).
import { Clock, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { useT } from "../../i18n/index.ts";
import { errorText } from "../../lib/actions.ts";
import { Button, IconButton, Kbd } from "../../ui/primitives.tsx";

interface Queued {
  id: number;
  text: string;
}

const useQueue = create<{ byTask: Record<string, Queued[]> }>()(() => ({ byTask: {} }));
const EMPTY: Queued[] = [];
let queueSeq = 0;

const setQueue = (taskId: string, fn: (q: Queued[]) => Queued[]) =>
  useQueue.setState((s) => ({ byTask: { ...s.byTask, [taskId]: fn(s.byTask[taskId] ?? EMPTY) } }));

export function Composer({
  taskId,
  locked,
  placeholder,
  onSend,
}: {
  taskId: string;
  /** Un tour de l'agent est en cours : les messages sont mis en file d'attente. */
  locked: boolean;
  placeholder: string;
  onSend(text: string): Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const queue = useQueue((s) => s.byTask[taskId] ?? EMPTY);
  // Après un envoi, l'état « en cours » de la session arrive un peu plus tard : on attend de le voir (ou 8 s) avant
  // d'envoyer la suite de la file, pour ne jamais relancer deux tours à la fois.
  const awaitingTurn = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [cooldown, setCooldown] = useState(false);

  useEffect(() => {
    if (locked && awaitingTurn.current) {
      clearTimeout(awaitingTurn.current);
      awaitingTurn.current = undefined;
      setCooldown(false);
    }
  }, [locked]);
  useEffect(() => () => clearTimeout(awaitingTurn.current), []);

  const deliver = async (text: string): Promise<boolean> => {
    setSending(true);
    try {
      await onSend(text);
      setCooldown(true);
      awaitingTurn.current = setTimeout(() => {
        awaitingTurn.current = undefined;
        setCooldown(false);
      }, 8000);
      return true;
    } catch (e) {
      toast.error(errorText(e));
      return false;
    } finally {
      setSending(false);
    }
  };

  // Fin du tour : la file part en un seul message (dans l'ordre de saisie).
  useEffect(() => {
    if (locked || sending || cooldown || queue.length === 0) return;
    const batch = queue;
    const text = batch.map((q) => q.text).join("\n\n");
    setQueue(taskId, (q) => q.filter((x) => !batch.some((b) => b.id === x.id)));
    void deliver(text).then((ok) => {
      // Échec : les messages reviennent en tête de file (rien n'est perdu).
      if (!ok) setQueue(taskId, (q) => [...batch, ...q]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, sending, cooldown, queue, taskId]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (locked || sending || cooldown) {
      setQueue(taskId, (q) => [...q, { id: ++queueSeq, text }]);
      setDraft("");
      return;
    }
    void deliver(text).then((ok) => ok && setDraft(""));
  };

  const queuing = locked || cooldown;

  return (
    <footer className="composer" data-testid="session-composer">
      {queue.length > 0 && (
        <div className="composer-queue" aria-label={t("session.queueLabel")}>
          {queue.map((q) => (
            <span key={q.id} className="composer-queued" data-testid="composer-queued">
              <Clock size={11} aria-hidden />
              <span className="composer-queued-label">{t("session.queued")}</span>
              <span className="composer-queued-text" title={q.text}>
                {q.text}
              </span>
              <IconButton
                size="sm"
                label={t("session.unqueue")}
                onClick={() => setQueue(taskId, (list) => list.filter((x) => x.id !== q.id))}
              >
                <X size={11} />
              </IconButton>
            </span>
          ))}
        </div>
      )}
      <textarea
        className="composer-input"
        placeholder={queuing ? t("session.queuePlaceholder") : placeholder}
        aria-label={t("session.followUp")}
        value={draft}
        rows={2}
        maxLength={50_000}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Saisie en cours d'une méthode d'entrée (accents, CJK) : Entrée valide la composition, n'envoie pas.
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          if (e.shiftKey && !e.ctrlKey && !e.metaKey) return; // nouvelle ligne
          e.preventDefault();
          submit();
        }}
      />
      <div className="composer-bar">
        <span className="text-[11px] text-fg-subtle">
          <Kbd spec="enter" /> {queuing ? t("session.toQueue") : t("session.toSend")} · <Kbd spec="shift+enter" />{" "}
          {t("session.newLine")}
        </span>
        <Button
          size="sm"
          variant={queuing ? "secondary" : "primary"}
          icon={queuing ? <Clock size={13} /> : <Send size={13} />}
          disabled={!draft.trim()}
          busy={sending}
          onClick={submit}
        >
          {queuing ? t("session.queueSend") : t("session.relaunch")}
        </Button>
      </div>
    </footer>
  );
}
