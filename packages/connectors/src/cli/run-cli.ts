// Exécution d'une tâche CLI et normalisation de sa sortie en AgentEvent validés.
// Garanties : séquences strictement croissantes, exactement un événement terminal (completed | failed),
// chaque événement validé par le contrat avant émission (un événement non conforme n'atteint jamais le journal).
import { AgentEvent, type FailureCode } from "@nexus/contracts";
import { runProcess, type RunOptions } from "@nexus/process-supervisor";
import { AsyncQueue } from "../queue.ts";
import type { Runner } from "../probe.ts";

type Body<K extends AgentEvent["kind"]> = Omit<Extract<AgentEvent, { kind: K }>, "taskId" | "sequence">;
export type EventBody = { [K in AgentEvent["kind"]]: Body<K> }[AgentEvent["kind"]];

/** Attribue taskId/sequence, garantit un seul terminal, valide chaque événement. */
export class EventSequencer {
  readonly taskId: string;
  #sequence = 0;
  #terminal = false;
  readonly #emit: (e: AgentEvent) => void;
  constructor(taskId: string, emit: (e: AgentEvent) => void) {
    this.taskId = taskId;
    this.#emit = emit;
  }
  get terminal(): boolean {
    return this.#terminal;
  }
  emit(body: EventBody): void {
    if (this.#terminal) return;
    const event = AgentEvent.parse({ ...body, taskId: this.taskId, sequence: ++this.#sequence });
    if (event.kind === "completed" || event.kind === "failed") this.#terminal = true;
    this.#emit(event);
  }
  fail(code: FailureCode, message: string): void {
    this.emit({ kind: "failed", code, message: message.slice(0, 2000) });
  }
}

/** Traduit les lignes de sortie d'une CLI. `finish` est appelé à la fin du processus s'il n'y a pas eu de terminal. */
export type OutputNormalizer = {
  onStdout(line: string, seq: EventSequencer): void;
  onStderr?(line: string, seq: EventSequencer): void;
  finish(exit: { exitCode: number | null; signal: string | null }, seq: EventSequencer): void;
};

export type CliTask = {
  taskId: string;
  file: string;
  args: readonly string[];
  stdin?: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  normalizer: OutputNormalizer;
  runner?: Runner;
  redact?: readonly string[];
  wrapper?: RunOptions["wrapper"];
};

export function runCliTask(task: CliTask): AsyncIterable<AgentEvent> {
  // Le consommateur qui cesse de lire (exception, `break`) arrête aussi la CLI : aucun processus orphelin.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (task.signal.aborted) stop.abort();
  else task.signal.addEventListener("abort", onAbort, { once: true });
  const queue = new AsyncQueue<AgentEvent>({ onReturn: () => stop.abort() });
  const seq = new EventSequencer(task.taskId, (e) => queue.push(e));
  const stderrTail: string[] = [];

  void (async () => {
    try {
      const opts: RunOptions = {
        file: task.file,
        args: task.args,
        ...(task.stdin !== undefined && { stdin: task.stdin }),
        cwd: task.cwd,
        env: task.env,
        timeoutMs: task.timeoutMs,
        signal: stop.signal,
        ...(task.redact && { redact: task.redact }),
        ...(task.wrapper && { wrapper: task.wrapper }),
        onLine: (line, channel) => {
          // Appelé depuis un callback du processus : une exception ici deviendrait une uncaughtException. Une ligne
          // que le normaliseur ne sait pas traduire (ou un événement non conforme au contrat) est écartée.
          try {
            if (channel === "stdout") task.normalizer.onStdout(line, seq);
            else {
              stderrTail.push(line);
              if (stderrTail.length > 20) stderrTail.shift();
              task.normalizer.onStderr?.(line, seq);
            }
          } catch {
            /* ligne écartée : jamais d'événement non validé dans le journal */
          }
        },
      };
      const r = task.runner ? await task.runner(opts, { taskId: task.taskId }) : await runProcess(opts);
      if (r.spawnError)
        seq.fail(r.spawnError === "ENOENT" ? "binary_not_found" : "spawn_failed", `Cannot start CLI (${r.spawnError})`);
      else if (r.cancelled) seq.fail("cancelled", "Task cancelled");
      else if (r.timedOut) seq.fail("timeout", `Task exceeded ${task.timeoutMs} ms`);
      else if (r.outputLimitExceeded) seq.fail("invalid_output", "CLI output exceeded the configured limit");
      else {
        task.normalizer.finish({ exitCode: r.exitCode, signal: r.signal }, seq);
        if (!seq.terminal) {
          const hint = stderrTail.slice(-3).join(" | ");
          seq.fail(
            "stream_ended_without_result",
            `CLI exited (${r.exitCode ?? r.signal}) without a result${hint ? `: ${hint}` : ""}`,
          );
        }
      }
    } catch (e) {
      seq.fail("spawn_failed", (e as Error).message);
    } finally {
      task.signal.removeEventListener("abort", onAbort);
      queue.end();
    }
  })();

  return queue;
}
