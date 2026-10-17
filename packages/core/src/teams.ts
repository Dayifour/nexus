// Équipes, rôles et gouvernance (FR-002, FR-008, FR-009, ADR-006, T-010).
// Bascule de superviseur : pause -> instantané -> nouvelle attribution explicite, journalisée (§10).
import { randomUUID } from "node:crypto";
import type { Capability, GovernanceMode, PermissionMode, TeamSummary } from "@nexus/contracts";
import type { EventStore, Projector } from "@nexus/event-store";
import { DomainError, domainEvent, type Actor, type Clock } from "./events.ts";

type AuthMode = "vendor-login" | "api-key" | "local-none";

export const teamsProjector: Projector = {
  name: "teams",
  async apply(tx, e) {
    if (e.aggregateType !== "team") return;
    const p = e.payload as Record<string, any>;
    switch (e.eventType) {
      case "team.created":
        await tx.team.create({
          data: {
            id: e.aggregateId,
            projectId: p.projectId,
            name: p.name,
            governanceMode: p.governanceMode,
            supervisorId: null,
            createdAt: e.occurredAt,
            updatedAt: e.occurredAt,
            version: e.aggregateVersion,
          },
        });
        return;
      case "team.agent_added":
        await tx.agentProfile.create({
          data: {
            id: p.agentId,
            teamId: e.aggregateId,
            role: p.role,
            displayName: p.displayName,
            connectorId: p.connectorId,
            permissionMode: p.permissionMode,
            authMode: p.authMode,
            capabilitiesJson: JSON.stringify(p.capabilities ?? []),
            createdAt: e.occurredAt,
            updatedAt: e.occurredAt,
            version: 1,
          },
        });
        break;
      case "team.agent_removed":
        await tx.agentProfile.delete({ where: { id: p.agentId } });
        break;
      case "team.governance_changed":
        await tx.team.update({
          where: { id: e.aggregateId },
          data: { governanceMode: p.governanceMode, supervisorId: p.supervisorAgentId ?? null },
        });
        break;
      case "team.agent_permission_changed":
        await tx.agentProfile.update({
          where: { id: p.agentId },
          data: { permissionMode: p.permissionMode, updatedAt: e.occurredAt },
        });
        break;
    }
    await tx.team.update({
      where: { id: e.aggregateId },
      data: { updatedAt: e.occurredAt, version: e.aggregateVersion },
    });
  },
  async reset(tx) {
    await tx.agentProfile.deleteMany({});
    await tx.team.deleteMany({});
  },
};

export type NewAgent = {
  role: string;
  displayName: string;
  connectorId: string;
  permissionMode: PermissionMode;
  authMode: AuthMode;
  capabilities?: Capability[];
};

export class TeamService {
  readonly #store: EventStore;
  readonly #clock: Clock;
  constructor(store: EventStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  async #version(teamId: string): Promise<number> {
    const t = await this.#store.prisma.team.findUnique({ where: { id: teamId }, select: { version: true } });
    if (!t) throw new DomainError("not_found", "Équipe introuvable");
    return t.version;
  }

  async create(
    input: { projectId: string; name: string; governanceMode: GovernanceMode },
    actor: Actor,
  ): Promise<TeamSummary> {
    const project = await this.#store.prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw new DomainError("not_found", "Projet introuvable");
    const dup = await this.#store.prisma.team.findFirst({ where: { projectId: input.projectId, name: input.name } });
    if (dup) throw new DomainError("conflict", "Une équipe porte déjà ce nom dans ce projet");
    const teamId = randomUUID();
    await this.#store.append([
      domainEvent("team", teamId, 1, "team.created", { ...input }, { actor, clock: this.#clock }),
    ]);
    return this.get(teamId);
  }

  async addAgent(teamId: string, agent: NewAgent, actor: Actor): Promise<string> {
    const v = await this.#version(teamId);
    const agentId = randomUUID();
    await this.#store.append([
      domainEvent("team", teamId, v + 1, "team.agent_added", { agentId, ...agent }, { actor, clock: this.#clock }),
    ]);
    return agentId;
  }

  /**
   * Changement de gouvernance. Les tâches actives de l'équipe doivent être en pause (aucune en `running`/`queued`)
   * pour que l'instantané soit cohérent ; le superviseur IA doit être membre de l'équipe.
   */
  async setGovernance(
    teamId: string,
    governanceMode: GovernanceMode,
    supervisorAgentId: string | undefined,
    actor: Actor,
  ): Promise<void> {
    if (actor.actorType !== "user") throw new DomainError("policy_denied", "Seul l'utilisateur choisit la gouvernance");
    const v = await this.#version(teamId);
    if (governanceMode !== "MANUAL") {
      if (!supervisorAgentId) throw new DomainError("invalid_request", "Un superviseur IA doit être désigné");
      const sup = await this.#store.prisma.agentProfile.findUnique({ where: { id: supervisorAgentId } });
      if (!sup || sup.teamId !== teamId)
        throw new DomainError("invalid_request", "Le superviseur doit être membre de l'équipe");
    }
    const active = await this.#store.prisma.task.count({
      where: { status: { in: ["queued", "running"] }, mission: { teamId } },
    });
    if (active > 0)
      throw new DomainError("conflict", "Mettre en pause les tâches actives avant de changer de superviseur");
    const snapshot = await this.get(teamId);
    await this.#store.append([
      domainEvent(
        "team",
        teamId,
        v + 1,
        "team.governance_changed",
        {
          governanceMode,
          ...(supervisorAgentId && { supervisorAgentId }),
          previous: { mode: snapshot.governanceMode, supervisorAgentId: snapshot.supervisorAgentId ?? null },
        },
        { actor, clock: this.#clock },
      ),
    ]);
  }

  async get(teamId: string): Promise<TeamSummary> {
    const t = await this.#store.prisma.team.findUnique({
      where: { id: teamId },
      include: { members: { orderBy: { createdAt: "asc" } } },
    });
    if (!t) throw new DomainError("not_found", "Équipe introuvable");
    return {
      teamId: t.id,
      projectId: t.projectId,
      name: t.name,
      governanceMode: t.governanceMode as GovernanceMode,
      ...(t.supervisorId && { supervisorAgentId: t.supervisorId }),
      members: t.members.map((m) => ({
        agentId: m.id,
        role: m.role,
        displayName: m.displayName,
        connectorId: m.connectorId,
        permissionMode: m.permissionMode as PermissionMode,
        authMode: m.authMode as AuthMode,
      })),
    };
  }
}
