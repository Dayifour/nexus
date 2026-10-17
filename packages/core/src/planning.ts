// Plan proposé par un superviseur IA ou saisi par l'humain : validation explicable et routage (FR-009, UC-03, T-013).
// Un plan n'est jamais exécuté tel quel : il est validé (schéma, DAG, chemins, capacités, politique), puis, selon la
// gouvernance, approuvé par l'humain (ASSISTED) ou accepté automatiquement (AI_SUPERVISED, sans action sensible).
import {
  MissionPlan,
  type Capability,
  type GovernanceMode,
  type PermissionMode,
  type PlannedTask,
} from "@nexus/contracts";
import { validateDag } from "./dag.ts";

export type PlanCheck = { rule: string; ok: boolean; detail?: string };

export type PlanValidation = { valid: boolean; checks: PlanCheck[]; plan?: MissionPlan };

export type RoutableAgent = {
  agentId: string;
  role: string;
  connectorId: string;
  capabilities: readonly Capability[];
  permissionMode: PermissionMode;
  available: boolean;
  /** Coût relatif déclaré par l'utilisateur (1 = référence) ; jamais inventé. */
  relativeCost?: number;
};

/** Valide un plan brut (sortie JSON d'un modèle) et explique chaque règle (décision explicable, T-013). */
export function validatePlan(raw: unknown, agents: readonly RoutableAgent[]): PlanValidation {
  const checks: PlanCheck[] = [];
  const parsed = MissionPlan.safeParse(raw);
  if (!parsed.success) {
    checks.push({
      rule: "schema",
      ok: false,
      detail: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    });
    return { valid: false, checks };
  }
  checks.push({ rule: "schema", ok: true });
  const plan = parsed.data;

  const keys = new Set(plan.tasks.map((t) => t.key));
  const dagIssues = validateDag(plan.tasks.map((t) => ({ id: t.key, dependsOn: t.dependsOn })));
  checks.push({
    rule: "dag",
    ok: dagIssues.length === 0,
    ...(dagIssues.length && { detail: JSON.stringify(dagIssues) }),
  });
  checks.push({ rule: "unique_keys", ok: keys.size === plan.tasks.length });

  const caps = new Set(agents.filter((a) => a.available).flatMap((a) => a.capabilities));
  const missing = [...new Set(plan.tasks.flatMap((t) => t.requiredCapabilities.filter((c) => !caps.has(c))))];
  checks.push({
    rule: "capabilities_available",
    ok: missing.length === 0,
    ...(missing.length && { detail: `manquantes : ${missing.join(", ")}` }),
  });

  const highRisk = plan.tasks.filter((t) => t.risk === "high").map((t) => t.key);
  checks.push({
    rule: "risk_review",
    ok: true,
    ...(highRisk.length && { detail: `tâches à risque élevé (revue humaine conseillée) : ${highRisk.join(", ")}` }),
  });

  const valid = checks.every((c) => c.ok);
  return { valid, checks, ...(valid && { plan }) };
}

/** Le plan nécessite-t-il une approbation humaine avant création des tâches ? */
export function planNeedsHumanApproval(mode: GovernanceMode, plan: MissionPlan): boolean {
  if (mode === "MANUAL" || mode === "ASSISTED") return true;
  // AI_SUPERVISED : autonomie bornée, une tâche à risque élevé repasse par l'humain.
  return plan.tasks.some((t) => t.risk === "high");
}

export type RoutingDecision = { taskKey: string; agentId: string | null; reasons: string[] };

/**
 * Routage explicable : capacités requises couvertes, agent disponible, rôle suggéré préféré, coût relatif le plus bas.
 * `overrides` (choix manuel de l'utilisateur) prime toujours.
 */
export function routeTasks(
  tasks: readonly PlannedTask[],
  agents: readonly RoutableAgent[],
  overrides: Readonly<Record<string, string>> = {},
): RoutingDecision[] {
  return tasks.map((t) => {
    const forced = overrides[t.key];
    if (forced) {
      const a = agents.find((x) => x.agentId === forced);
      return {
        taskKey: t.key,
        agentId: a ? forced : null,
        reasons: a ? ["choix manuel de l'utilisateur"] : ["agent imposé introuvable"],
      };
    }
    const candidates = agents
      .filter((a) => a.available)
      .filter((a) => t.requiredCapabilities.every((c) => a.capabilities.includes(c)))
      .filter((a) => a.permissionMode !== "read-only" || t.requiredCapabilities.every((c) => c !== "edit"));
    if (candidates.length === 0)
      return { taskKey: t.key, agentId: null, reasons: ["aucun agent disponible ne couvre les capacités requises"] };
    const scored = candidates
      .map((a) => ({
        a,
        roleMatch: t.suggestedRole ? a.role.toLowerCase() === t.suggestedRole.toLowerCase() : false,
        cost: a.relativeCost ?? 1,
      }))
      .sort(
        (x, y) =>
          Number(y.roleMatch) - Number(x.roleMatch) || x.cost - y.cost || x.a.agentId.localeCompare(y.a.agentId),
      );
    const best = scored[0]!;
    const reasons = ["capacités requises couvertes", "agent disponible"];
    if (best.roleMatch) reasons.push(`rôle suggéré « ${t.suggestedRole} »`);
    if (best.a.relativeCost !== undefined) reasons.push(`coût relatif ${best.a.relativeCost}`);
    return { taskKey: t.key, agentId: best.a.agentId, reasons };
  });
}

/**
 * Extrait le premier objet JSON d'une réponse de modèle (texte libre autour toléré), sans `eval`.
 * Avec `accept`, chaque objet équilibré est essayé dans l'ordre et le premier accepté est renvoyé (ex. celui qui porte
 * un `verdict`, même précédé d'un autre objet ou d'accolades parasites).
 */
export function extractJsonObject(text: string, accept?: (value: unknown) => boolean): unknown {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = balancedEnd(text, start);
    if (end !== -1) {
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (!accept || accept(value)) return value;
      } catch {
        /* objet invalide : candidat suivant (avec `accept` seulement) */
      }
    }
    if (!accept) return undefined;
  }
  return undefined;
}

/** Position de l'accolade fermante qui équilibre celle de `start` (chaînes JSON respectées), ou -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
