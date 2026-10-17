// Durée écoulée « m:ss » mise à jour chaque seconde : seul ce petit composant se re-rend, jamais le panneau entier.
import { useEffect, useState } from "react";

export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** `start` (ms) → maintenant tant que `running`, sinon → `end` (ou `start`). */
export function Elapsed({
  start,
  end,
  running,
  className,
}: {
  start: number;
  end?: number;
  running: boolean;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return <span className={className}>{formatElapsed((running ? now : (end ?? start)) - start)}</span>;
}
