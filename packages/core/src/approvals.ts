// Approbations (FR-014, AC-08, NFR-009) : portée, expiration, empreinte du plan, usage unique.
// Seul l'utilisateur répond ; une approbation ne peut jamais être accordée par un agent.
import { randomUUID } from "node:crypto";
import type { Approval, SensitiveAction } from "@nexus/contracts";
import type { EventStore, Projector } from "@nexus/event-store";
import { DomainError, domainEvent, type Actor, type Clock } from "./events.ts";
import { planFingerprint } from "./policy.ts";

export const approvalsProjector: Projector = {
  name: "approvals",
  async apply(tx, e) {
    if (e.aggregateType !== "approval") return;
    const p = e.payload as Record<string, string>;
    if (e.eventType === "approval.requested") {
      await tx.approval.create({
        data: {
          id: e.aggregateId,
          action: p.action!,
          projectId: p.projectId!,
          taskId: p.taskId ?? null,
          summary: p.summary!,
          planFingerprint: p.planFingerprint!,
          status: "pending",
          requestedAt: e.occurredAt,
          expiresAt: p.expiresAt!,
        },
      });
    } else if (e.eventType === "approval.decided" || e.eventType === "approval.consumed") {
      await tx.approval.update({
        where: { id: e.aggregateId },
        data: { status: p.status!, ...(e.eventType === "approval.decided" && { decidedAt: e.occurredAt }) },
      });
    }
  },
  async reset(tx) {
    await tx.approval.deleteMany({});
  },
};

const toApproval = (r: {
  id: string;
  action: string;
  projectId: string;
  taskId: string | null;
  summary: string;
  planFingerprint: string;
  status: string;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
}): Approval => ({
  approvalId: r.id,
  action: r.action as SensitiveAction,
  projectId: r.projectId,
  ...(r.taskId && { taskId: r.taskId }),
  summary: r.summary,
  planFingerprint: r.planFingerprint,
  status: r.status as Approval["status"],
  requestedAt: r.requestedAt,
  expiresAt: r.expiresAt,
  ...(r.decidedAt && { decidedAt: r.decidedAt }),
});

export class ApprovalService {
  readonly #store: EventStore;
  readonly #clock: Clock;
  constructor(store: EventStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  async request(
    input: {
      action: SensitiveAction;
      projectId: string;
      taskId?: string;
      summary: string;
      plan: unknown;
      ttlMs?: number;
    },
    actor: Actor,
  ): Promise<Approval> {
    const id = randomUUID();
    const expiresAt = new Date(Date.parse(this.#clock()) + (input.ttlMs ?? 15 * 60_000)).toISOString();
    await this.#store.append([
      domainEvent(
        "approval",
        id,
        1,
        "approval.requested",
        {
          action: input.action,
          projectId: input.projectId,
          ...(input.taskId && { taskId: input.taskId }),
          summary: input.summary.slice(0, 2000),
          planFingerprint: planFingerprint(input.plan),
          expiresAt,
        },
        { actor, clock: this.#clock },
      ),
    ]);
    return this.get(id);
  }

  async get(approvalId: string): Promise<Approval> {
    const r = await this.#store.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!r) throw new DomainError("not_found", "Approbation introuvable");
    return toApproval(r);
  }

  async respond(approvalId: string, decision: "allow" | "deny", actor: Actor): Promise<Approval> {
    if (actor.actorType !== "user")
      throw new DomainError("policy_denied", "Seul l'utilisateur peut répondre à une approbation");
    const a = await this.get(approvalId);
    if (a.status !== "pending") throw new DomainError("conflict", `Approbation déjà ${a.status}`);
    const expired = Date.parse(a.expiresAt) <= Date.parse(this.#clock());
    const version = await this.#store.currentVersion(approvalId);
    await this.#store.append([
      domainEvent(
        "approval",
        approvalId,
        version + 1,
        "approval.decided",
        { status: expired ? "expired" : decision === "allow" ? "allowed" : "denied" },
        { actor, clock: this.#clock },
      ),
    ]);
    if (expired) throw new DomainError("conflict", "Approbation expirée : relancer la demande");
    return this.get(approvalId);
  }

  /**
   * Vérifie puis consomme une approbation pour exécuter EXACTEMENT le plan approuvé (usage unique).
   * Toute divergence de plan, expiration ou refus lève une erreur : l'action ne doit pas s'exécuter.
   */
  async consume(approvalId: string, action: SensitiveAction, plan: unknown, actor: Actor): Promise<void> {
    const a = await this.get(approvalId);
    if (a.action !== action) throw new DomainError("policy_denied", "Approbation accordée pour une autre action");
    if (a.status !== "allowed") throw new DomainError("policy_denied", `Approbation non valide (${a.status})`);
    if (Date.parse(a.expiresAt) <= Date.parse(this.#clock()))
      throw new DomainError("policy_denied", "Approbation expirée");
    if (a.planFingerprint !== planFingerprint(plan))
      throw new DomainError("policy_denied", "Le plan a changé depuis l'approbation");
    const version = await this.#store.currentVersion(approvalId);
    await this.#store.append([
      domainEvent(
        "approval",
        approvalId,
        version + 1,
        "approval.consumed",
        { status: "consumed" },
        { actor, clock: this.#clock },
      ),
    ]);
  }
}
