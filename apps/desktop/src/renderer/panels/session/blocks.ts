// Fil d'une session découpé en blocs affichables (texte de l'agent, sortie d'erreur, outil, jalons, consommation,
// messages de l'utilisateur). Construction INCRÉMENTALE : chaque événement poussé ne traite que les nouvelles
// entrées (au lieu de reconstruire tout le fil), et les blocs inchangés gardent leur identité — leurs composants
// mémoïsés ne se re-rendent pas pendant le flux.
import { useMemo, useRef } from "react";
import type { QuotaEvent } from "../../lib/quota.ts";
import type { RunEntry, RunStream } from "../../stores/runs.ts";
import type { AgentEvent } from "../../types.ts";

export type Block =
  | { kind: "text"; key: string; channel: "message" | "stdout"; text: string }
  | { kind: "stderr"; key: string; text: string }
  | { kind: "tool"; key: string; tool: string; ref: string }
  | {
      kind: "system";
      key: string;
      tone: "info" | "success" | "danger";
      msg: "started" | "completed" | "failed";
      detail?: string;
    }
  | { kind: "usage"; key: string; event: Extract<AgentEvent, { kind: "usage" }> }
  | { kind: "user"; key: string; text: string }
  | { kind: "run"; key: string; n: number };

export interface FollowUp {
  text: string;
  at: number;
  afterEntries: number;
}

export interface StreamView {
  blocks: Block[];
  quota?: QuotaEvent;
  /** Dernier échec : « [code] message ». */
  lastFailure?: string;
  /** Début et dernier horodatage de la dernière exécution (relances comprises), en ms. */
  runStart?: number;
  runLastAt?: number;
}

const EMPTY_FOLLOW_UPS: FollowUp[] = [];

class BlockBuilder {
  private version = -1;
  private firstKey: string | undefined;
  private count = 0;
  private committed: Block[] = [];
  /** Nombre de messages de l'utilisateur déjà insérés dans `committed`. */
  private fi = 0;
  private knownFollowUps = 0;
  private runNo = 0;
  private prevRun: string | undefined;
  private quota: QuotaEvent | undefined;
  private lastFailure: string | undefined;
  private runStart: number | undefined;
  private runLastAt: number | undefined;
  private userBlocks = new Map<number, Block>();
  private last: StreamView = { blocks: [] };

  private reset(version: number): void {
    this.version = version;
    this.firstKey = undefined;
    this.count = 0;
    this.committed = [];
    this.fi = 0;
    this.knownFollowUps = 0;
    this.runNo = 0;
    this.prevRun = undefined;
    this.quota = undefined;
    this.lastFailure = undefined;
    this.runStart = undefined;
    this.runLastAt = undefined;
  }

  private userBlock(f: FollowUp, i: number): Block {
    let b = this.userBlocks.get(i);
    if (!b || (b.kind === "user" && b.text !== f.text)) {
      b = { kind: "user", key: `u-${f.at}-${i}`, text: f.text };
      this.userBlocks.set(i, b);
    }
    return b;
  }

  update(entries: RunEntry[], version: number, followUps: FollowUp[]): StreamView {
    const mustReset =
      version !== this.version ||
      entries.length < this.count ||
      (this.count > 0 && entries[0]?.key !== this.firstKey) ||
      followUps.length < this.knownFollowUps ||
      // Message envoyé dont la position tombe avant des entrées déjà traitées : reconstruction (rare).
      followUps.slice(this.knownFollowUps).some((f) => f.afterEntries < this.count);
    if (mustReset) this.reset(version);
    const changed = mustReset || entries.length !== this.count || followUps.length !== this.knownFollowUps;
    if (!changed) return this.last;

    const out = this.committed.slice();
    const flushUser = (index: number) => {
      while (this.fi < followUps.length && (followUps[this.fi]?.afterEntries ?? 0) <= index) {
        const f = followUps[this.fi];
        if (f) out.push(this.userBlock(f, this.fi));
        this.fi += 1;
      }
    };
    for (let index = this.count; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      const { key, event, runId, at } = entry;
      flushUser(index);
      // Plusieurs exécutions (relance) : séparateur « Relance n » entre elles.
      if (runId !== this.prevRun) {
        if (this.prevRun !== undefined) out.push({ kind: "run", key: `run-${runId}`, n: this.runNo });
        this.runNo += 1;
        this.prevRun = runId;
        this.runStart = undefined;
        this.runLastAt = undefined;
      }
      if (at) {
        this.runStart ??= at;
        this.runLastAt = at;
      }
      const last = out[out.length - 1];
      switch (event.kind) {
        case "started":
          out.push({ kind: "system", key, tone: "info", msg: "started" });
          break;
        case "output":
          // Fusion avec le bloc précédent : NOUVEL objet (le composant mémoïsé de ce bloc se met à jour).
          if (event.channel === "stderr") {
            if (last?.kind === "stderr") out[out.length - 1] = { ...last, text: last.text + event.text };
            else out.push({ kind: "stderr", key, text: event.text });
          } else if (last?.kind === "text" && last.channel === event.channel) {
            out[out.length - 1] = { ...last, text: last.text + event.text };
          } else {
            out.push({ kind: "text", key, channel: event.channel, text: event.text });
          }
          break;
        case "tool-request":
          out.push({ kind: "tool", key, tool: event.tool, ref: event.payloadRef });
          break;
        case "usage":
          out.push({ kind: "usage", key, event });
          break;
        case "quota":
          this.quota = event as QuotaEvent;
          break;
        case "completed":
          out.push({ kind: "system", key, tone: "success", msg: "completed" });
          break;
        case "failed":
          this.lastFailure = `[${event.code}] ${event.message}`;
          out.push({ kind: "system", key, tone: "danger", msg: "failed", detail: this.lastFailure });
          break;
      }
    }
    this.count = entries.length;
    this.firstKey = entries[0]?.key;
    this.committed = out;
    this.knownFollowUps = followUps.length;
    // Messages envoyés après la dernière entrée : affichés à la fin, insérés pour de bon à l'entrée suivante.
    const trailing: Block[] = [];
    for (let i = this.fi; i < followUps.length; i++) {
      const f = followUps[i];
      if (f) trailing.push(this.userBlock(f, i));
    }
    this.last = {
      blocks: trailing.length > 0 ? out.concat(trailing) : out,
      ...(this.quota && { quota: this.quota }),
      ...(this.lastFailure && { lastFailure: this.lastFailure }),
      ...(this.runStart !== undefined && { runStart: this.runStart }),
      ...(this.runLastAt !== undefined && { runLastAt: this.runLastAt }),
    };
    return this.last;
  }
}

const EMPTY_ENTRIES: RunEntry[] = [];

/** Vue incrémentale du fil d'une session (un constructeur par panneau). */
export function useStreamView(stream: RunStream | undefined, followUps: FollowUp[] | undefined): StreamView {
  const builder = useRef<BlockBuilder | null>(null);
  builder.current ??= new BlockBuilder();
  const b = builder.current;
  return useMemo(
    () => b.update(stream?.entries ?? EMPTY_ENTRIES, stream?.version ?? 0, followUps ?? EMPTY_FOLLOW_UPS),
    [b, stream?.entries, stream?.version, followUps],
  );
}
