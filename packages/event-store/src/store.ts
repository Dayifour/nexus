// Event store append-only au-dessus de Prisma + libSQL.
// Garanties : écriture atomique événements + projections (une seule transaction), contrôle de concurrence
// optimiste par agrégat (unicité aggregateId+aggregateVersion), événement enregistré avant tout signal UI.
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { DomainEvent, NewDomainEvent } from "@nexus/contracts";
import { PrismaClient, type Prisma } from "./generated/prisma/client.ts";
import { migrate, type MigrationReport } from "./migrator.ts";

export type Tx = Prisma.TransactionClient;

/** Projection : applique un événement à l'état matérialisé, dans la transaction de l'événement. */
export type Projector = {
  name: string;
  apply(tx: Tx, event: DomainEvent): Promise<void>;
  /** Vide l'état matérialisé avant un replay complet. */
  reset(tx: Tx): Promise<void>;
};

/** Expurgation obligatoire des charges utiles avant écriture (NFR-008). Identité par défaut. */
export type PayloadRedactor = (payload: Record<string, unknown>) => Record<string, unknown>;

export class ConcurrencyError extends Error {
  readonly aggregateId: string;
  constructor(aggregateId: string, expected: number, actual: number) {
    super(`Aggregate ${aggregateId}: expected version ${expected}, current version is ${actual}`);
    this.aggregateId = aggregateId;
  }
}

type Row = {
  globalSequence: number;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  payloadSchemaVersion: number;
  payloadJson: string;
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
  actorType: string;
  actorId: string;
};

function toDomainEvent(r: Row): DomainEvent {
  return DomainEvent.parse({
    globalSequence: r.globalSequence,
    eventId: r.eventId,
    aggregateType: r.aggregateType,
    aggregateId: r.aggregateId,
    aggregateVersion: r.aggregateVersion,
    eventType: r.eventType,
    payloadSchemaVersion: r.payloadSchemaVersion,
    payload: JSON.parse(r.payloadJson),
    occurredAt: r.occurredAt,
    correlationId: r.correlationId,
    ...(r.causationId !== null && { causationId: r.causationId }),
    actorType: r.actorType,
    actorId: r.actorId,
  });
}

export type EventStoreOptions = {
  filePath: string;
  projectors?: Projector[];
  redact?: PayloadRedactor;
  now?: () => string;
};

export class EventStore {
  readonly prisma: PrismaClient;
  readonly migration: MigrationReport;
  readonly #projectors: Projector[];
  readonly #redact: PayloadRedactor;
  readonly #now: () => string;
  readonly #listeners = new Set<(events: DomainEvent[]) => void>();

  private constructor(prisma: PrismaClient, migration: MigrationReport, opts: EventStoreOptions) {
    this.prisma = prisma;
    this.migration = migration;
    this.#projectors = opts.projectors ?? [];
    this.#redact = opts.redact ?? ((p) => p);
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  /** Migre la base puis ouvre le client Prisma. */
  static async open(opts: EventStoreOptions): Promise<EventStore> {
    const migration = await migrate(opts.filePath);
    const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${opts.filePath}` }) });
    await prisma.$connect();
    // Chaque connexion doit porter les réglages de durabilité (ils ne sont pas tous persistés dans le fichier).
    await prisma.$queryRawUnsafe("PRAGMA synchronous = FULL");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
    return new EventStore(prisma, migration, opts);
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /** Notifié APRÈS validation de la transaction (l'UI ne voit jamais un événement non persisté). */
  subscribe(listener: (events: DomainEvent[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Ajoute des événements et applique les projections dans la même transaction.
   * `aggregateVersion` de chaque événement doit valoir version courante + 1 (sinon ConcurrencyError).
   * `extra` permet d'écrire dans la même transaction des données dérivées (ex. lecture de contrôle).
   */
  async append(
    events: NewDomainEvent[],
    extra?: (tx: Tx, written: DomainEvent[]) => Promise<void>,
  ): Promise<DomainEvent[]> {
    if (events.length === 0) return [];
    const parsed = events.map((e) => NewDomainEvent.parse({ ...e, payload: this.#redact(e.payload) }));
    const written = await this.prisma.$transaction(async (tx) => {
      const out: DomainEvent[] = [];
      const versions = new Map<string, number>();
      for (const e of parsed) {
        let current = versions.get(e.aggregateId);
        if (current === undefined) {
          const last = await tx.event.findFirst({
            where: { aggregateId: e.aggregateId },
            orderBy: { aggregateVersion: "desc" },
            select: { aggregateVersion: true },
          });
          current = last?.aggregateVersion ?? 0;
        }
        if (e.aggregateVersion !== current + 1) throw new ConcurrencyError(e.aggregateId, e.aggregateVersion, current);
        const row = await tx.event.create({
          data: {
            eventId: e.eventId,
            aggregateType: e.aggregateType,
            aggregateId: e.aggregateId,
            aggregateVersion: e.aggregateVersion,
            eventType: e.eventType,
            payloadSchemaVersion: e.payloadSchemaVersion,
            payloadJson: JSON.stringify(e.payload),
            occurredAt: e.occurredAt,
            correlationId: e.correlationId,
            causationId: e.causationId ?? null,
            actorType: e.actorType,
            actorId: e.actorId,
            recordedAt: this.#now(),
          },
        });
        versions.set(e.aggregateId, e.aggregateVersion);
        const domain = toDomainEvent(row);
        for (const p of this.#projectors) await p.apply(tx, domain);
        out.push(domain);
      }
      if (extra) await extra(tx, out);
      return out;
    });
    for (const l of this.#listeners) {
      try {
        l(written);
      } catch {
        /* un abonné défaillant n'invalide pas un événement déjà persisté */
      }
    }
    return written;
  }

  async currentVersion(aggregateId: string): Promise<number> {
    const last = await this.prisma.event.findFirst({
      where: { aggregateId },
      orderBy: { aggregateVersion: "desc" },
      select: { aggregateVersion: true },
    });
    return last?.aggregateVersion ?? 0;
  }

  async loadAggregate(aggregateId: string): Promise<DomainEvent[]> {
    const rows = await this.prisma.event.findMany({ where: { aggregateId }, orderBy: { aggregateVersion: "asc" } });
    return rows.map(toDomainEvent);
  }

  /**
   * Événements de plusieurs agrégats filtrés dans la base (type, séquence globale), au lieu de tout charger.
   * `last` : les `limit` plus récents (renvoyés dans l'ordre chronologique).
   */
  async queryEvents(q: {
    aggregateIds: readonly string[];
    eventType?: string;
    afterGlobalSequence?: number;
    limit?: number;
    last?: boolean;
  }): Promise<DomainEvent[]> {
    if (q.aggregateIds.length === 0) return [];
    const rows = await this.prisma.event.findMany({
      where: {
        aggregateId: { in: [...q.aggregateIds] },
        ...(q.eventType !== undefined && { eventType: q.eventType }),
        ...(q.afterGlobalSequence !== undefined && { globalSequence: { gt: q.afterGlobalSequence } }),
      },
      orderBy: { globalSequence: q.last ? "desc" : "asc" },
      ...(q.limit !== undefined && { take: Math.min(Math.max(q.limit, 1), 100_000) }),
    });
    if (q.last) rows.reverse();
    return rows.map(toDomainEvent);
  }

  async readFrom(afterGlobalSequence: number, limit = 1000): Promise<DomainEvent[]> {
    const rows = await this.prisma.event.findMany({
      where: { globalSequence: { gt: afterGlobalSequence } },
      orderBy: { globalSequence: "asc" },
      take: Math.min(Math.max(limit, 1), 10_000),
    });
    return rows.map(toDomainEvent);
  }

  /** Reconstruit toutes les projections depuis le journal (réparation au démarrage, §11). */
  async rebuildProjections(batchSize = 500): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        for (const p of this.#projectors) await p.reset(tx);
        let after = 0;
        let count = 0;
        for (;;) {
          const rows = await tx.event.findMany({
            where: { globalSequence: { gt: after } },
            orderBy: { globalSequence: "asc" },
            take: batchSize,
          });
          if (rows.length === 0) break;
          for (const r of rows) {
            const e = toDomainEvent(r);
            for (const p of this.#projectors) await p.apply(tx, e);
            after = r.globalSequence;
            count++;
          }
        }
        return count;
      },
      { timeout: 120_000 },
    );
  }

  async integrityCheck(): Promise<string> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ integrity_check: string }>>("PRAGMA integrity_check");
    return rows.map((r) => r.integrity_check).join(";");
  }
}
