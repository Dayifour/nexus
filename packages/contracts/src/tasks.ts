// Machine d'états des tâches (cahier maître §10) et modes de gouvernance.
import { z } from "zod";

export const TaskStatus = z.enum([
  "draft",
  "ready",
  "queued",
  "running",
  "waiting_input",
  "waiting_review",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];

/**
 * Transitions autorisées. `interrupted` n'est jamais terminal : la reprise repasse par `queued`.
 * `cancelled` est atteignable depuis tout état non terminal (arrêt d'urgence, FR-023).
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ["ready", "cancelled"],
  ready: ["queued", "draft", "cancelled"],
  // `failed` : la préparation a échoué avant le lancement (connecteur indisponible, dossier de travail impossible…).
  queued: ["running", "ready", "cancelled", "interrupted", "failed"],
  running: ["waiting_input", "waiting_review", "completed", "failed", "cancelled", "interrupted"],
  waiting_input: ["running", "cancelled", "interrupted", "failed"],
  // `queued` : l'utilisateur demande des changements et relance la session avec une nouvelle consigne.
  waiting_review: ["completed", "queued", "running", "failed", "cancelled", "interrupted"],
  interrupted: ["queued", "failed", "cancelled"],
  // Une session terminée ou annulée peut reprendre (nouveau message dans la conversation).
  completed: ["queued"],
  failed: ["queued"],
  cancelled: ["queued"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export const GovernanceMode = z.enum(["MANUAL", "ASSISTED", "AI_SUPERVISED"]);
export type GovernanceMode = z.infer<typeof GovernanceMode>;
