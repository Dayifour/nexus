// Contrôle de source : fichiers modifiés (`git.status`), diff au clic, message + Commit (`git.commit`), et Push en un
// clic avec une simple confirmation (`git.pushNow`) ; les raisons de blocage éventuelles sont affichées clairement.
import { Check, CloudUpload, GitBranch, GitPullRequest, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "../i18n/index.ts";
import { errorText } from "../lib/actions.ts";
import { FileIcon } from "../lib/file-icons.tsx";
import { usePrDialog } from "../overlays/CreatePrDialog.tsx";
import { useGitStore } from "../stores/git.ts";
import type { PushNowResult } from "../types.ts";
import { confirmAction } from "../ui/dialog.tsx";
import { Button, EmptyState, ErrorNotice, IconButton, Kbd, SectionTitle, Skeleton, cx } from "../ui/primitives.tsx";
import { openDiff, openFile } from "../workbench/dock.ts";

function statusInfo(code: string): {
  letter: string;
  tone: string;
  key: "git.modified" | "git.added" | "git.deleted" | "git.renamed" | "git.untracked" | "git.conflict";
} {
  const c = code.trim();
  if (c === "??") return { letter: "U", tone: "text-success", key: "git.untracked" };
  if (c.includes("U")) return { letter: "!", tone: "text-danger", key: "git.conflict" };
  if (c.includes("D")) return { letter: "D", tone: "text-danger", key: "git.deleted" };
  if (c.includes("A")) return { letter: "A", tone: "text-success", key: "git.added" };
  if (c.includes("R")) return { letter: "R", tone: "text-info", key: "git.renamed" };
  return { letter: "M", tone: "text-warning", key: "git.modified" };
}

export function SourceControl() {
  const t = useT();
  const status = useGitStore((s) => s.status);
  const { refresh, commit, pushNow } = useGitStore.getState();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "push">();
  const [pushResult, setPushResult] = useState<PushNowResult>();

  const data = status.data;
  const files = data?.files ?? [];

  const doCommit = async () => {
    const msg = message.trim();
    if (!msg) return;
    setBusy("commit");
    try {
      const r = await commit(msg);
      setMessage("");
      toast.success(t("git.committed", { sha: r.commit.slice(0, 8), branch: r.branch }));
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };

  const doPush = async () => {
    const branch = data?.branch;
    if (!branch) return;
    const ok = await confirmAction({
      title: t("git.pushTitle"),
      body: t("git.pushBody", { branch, remote: "origin" }),
      confirmLabel: t("git.push"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setBusy("push");
    setPushResult(undefined);
    try {
      const r = await pushNow(branch, "origin");
      setPushResult(r);
      if (r.ok) toast.success(t("git.pushed", { branch: r.remoteBranch ?? `origin/${branch}` }));
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="sidebar-view" aria-label={t("view.scm")}>
      <SectionTitle
        actions={
          <IconButton size="sm" label={t("common.refresh")} onClick={() => void refresh()}>
            <RefreshCw size={13} className={cx(status.loading && "spin")} />
          </IconButton>
        }
      >
        {t("view.scm")}
      </SectionTitle>
      {status.loading && !data && (
        <div className="px-3">
          <Skeleton lines={4} />
        </div>
      )}
      <div className="px-3">
        <ErrorNotice error={status.error} compact />
      </div>
      {data && !data.available && (
        <EmptyState icon={<GitBranch size={24} />} title={t("git.unavailable")}>
          {data.reason}
        </EmptyState>
      )}
      {data?.available && (
        <>
          <div className="px-3 flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-[12px] text-fg-muted">
              <GitBranch size={13} aria-hidden />
              <span className="font-mono truncate">{data.branch ?? t("git.detached")}</span>
            </div>
            <textarea
              className="input commit-input"
              data-testid="commit-message"
              placeholder={t("git.messagePlaceholder")}
              aria-label={t("git.message")}
              value={message}
              rows={3}
              maxLength={5000}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void doCommit();
                }
              }}
            />
            <div className="flex gap-1.5">
              <Button
                variant="primary"
                className="flex-1"
                icon={<Check size={14} />}
                busy={busy === "commit"}
                disabled={!message.trim() || files.length === 0}
                onClick={() => void doCommit()}
                title={t("git.commitHint")}
              >
                {t("git.commit")}
              </Button>
              <Button
                icon={<CloudUpload size={14} />}
                busy={busy === "push"}
                disabled={!data.branch}
                onClick={() => void doPush()}
              >
                {t("git.push")}
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={<GitPullRequest size={14} />}
              disabled={!data.branch}
              onClick={() => usePrDialog.getState().show({ title: data.branch ?? "" })}
            >
              {t("pr.button")}
            </Button>
            <p className="text-[11px] text-fg-subtle">
              <Kbd spec="mod+enter" /> {t("git.toCommit")}
            </p>
            {pushResult && !pushResult.ok && (
              <div className="notice notice-error" role="alert">
                <TriangleAlert size={15} aria-hidden />
                <div>
                  <p className="notice-title">{t("git.pushBlocked")}</p>
                  <ul className="notice-detail list-disc pl-4">
                    {pushResult.blockedReasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
          <div className="section-subtitle">
            {t("git.changes")} <span className="count-pill">{files.length}</span>
          </div>
          <div className="scroll-area flex-1" role="list">
            {files.length === 0 && <p className="px-4 text-[12.5px] text-fg-subtle">{t("git.clean")}</p>}
            {files.map((f) => {
              const info = statusInfo(f.status);
              const name = f.path.split("/").pop() ?? f.path;
              const dir = f.path.slice(0, Math.max(0, f.path.length - name.length - 1));
              return (
                <div key={f.path} role="listitem" className="result-row group">
                  <button
                    type="button"
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                    onClick={() =>
                      info.letter === "D" || info.letter === "U"
                        ? openFile(f.path, { preview: true })
                        : openDiff(f.path)
                    }
                    title={`${f.path} — ${t(info.key)}`}
                  >
                    <FileIcon name={name} size={14} />
                    <span className={cx("truncate", info.letter === "D" && "line-through opacity-70")}>{name}</span>
                    <span className="result-dir truncate">{dir}</span>
                  </button>
                  <span className={cx("git-letter", info.tone)} aria-label={t(info.key)}>
                    {info.letter}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
