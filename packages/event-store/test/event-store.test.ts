import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NewDomainEvent } from "@nexus/contracts";
import { ConcurrencyError, EventStore, MigrationChecksumError, migrate } from "../src/index.ts";
import { MIGRATIONS } from "../src/generated/migrations.ts";
import { projectsProjector } from "./fixtures/projects-projector.ts";

function dbPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-es-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "nexus.db");
}

function ev(aggregateId: string, version: number, payload: Record<string, unknown> = {}): NewDomainEvent {
  return {
    eventId: randomUUID(),
    aggregateType: "project",
    aggregateId,
    aggregateVersion: version,
    eventType: "project.created",
    payloadSchemaVersion: 1,
    payload: { name: "demo", rootPath: `/tmp/${aggregateId}`, ...payload },
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    actorType: "user",
    actorId: "owner",
  };
}

test("migrations : base neuve migrée, réouverture idempotente", async (t) => {
  const file = dbPath(t);
  const first = await migrate(file);
  assert.deepEqual(
    first.applied,
    MIGRATIONS.map((m) => m.name),
  );
  const second = await migrate(file);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(
    second.alreadyApplied,
    MIGRATIONS.map((m) => m.name),
  );
});

test("migrations : contenu modifié après application → démarrage refusé", async (t) => {
  const file = dbPath(t);
  await migrate(file);
  const tampered = MIGRATIONS.map((m) => ({ ...m, checksum: "0".repeat(64) }));
  await assert.rejects(migrate(file, tampered), MigrationChecksumError);
});

test("migrations : nouvelle migration → sauvegarde préalable de la base, puis application", async (t) => {
  const file = dbPath(t);
  await migrate(file);
  const extra = [
    ...MIGRATIONS,
    { name: "9999_test_extra", checksum: "a".repeat(64), sql: 'CREATE TABLE "x_extra" ("id" TEXT PRIMARY KEY);' },
  ];
  const r = await migrate(file, extra);
  assert.deepEqual(r.applied, ["9999_test_extra"]);
  assert.ok(r.backupPath && existsSync(r.backupPath));
});

test("migrations : migration en erreur → rien n'est appliqué (transaction)", async (t) => {
  const file = dbPath(t);
  await migrate(file);
  const broken = [
    ...MIGRATIONS,
    { name: "9998_broken", checksum: "b".repeat(64), sql: 'CREATE TABLE "half" ("id" TEXT); THIS IS NOT SQL;' },
  ];
  await assert.rejects(migrate(file, broken));
  const after = await migrate(file);
  assert.equal(after.applied.length, 0);
  const store = await EventStore.open({ filePath: file });
  t.after(() => store.close());
  const half = await store.prisma.$queryRawUnsafe<unknown[]>(`SELECT name FROM sqlite_master WHERE name = 'half'`);
  assert.equal(half.length, 0, "la table partielle a été annulée");
});

test("append : événement et projection écrits ensemble ; abonnés notifiés après validation", async (t) => {
  const store = await EventStore.open({ filePath: dbPath(t), projectors: [projectsProjector] });
  t.after(() => store.close());
  const id = randomUUID();
  const seen: number[] = [];
  store.subscribe((events) => seen.push(...events.map((e) => e.globalSequence)));
  const [written] = await store.append([ev(id, 1)]);
  assert.equal(written!.globalSequence, 1);
  assert.deepEqual(seen, [1]);
  const project = await store.prisma.project.findUnique({ where: { id } });
  assert.equal(project?.version, 1);
});

test("append : échec de projection → ni événement ni projection (atomicité, NFR-002)", async (t) => {
  const store = await EventStore.open({ filePath: dbPath(t), projectors: [projectsProjector] });
  t.after(() => store.close());
  const id = randomUUID();
  await store.append([ev(id, 1)]);
  let notified = false;
  store.subscribe(() => (notified = true));
  await assert.rejects(store.append([ev(id, 2, { name: "ok" }), ev(id, 3, { fail: true })]));
  assert.equal(await store.currentVersion(id), 1);
  assert.equal((await store.prisma.project.findUnique({ where: { id } }))?.version, 1);
  assert.equal(notified, false, "aucun signal UI pour un événement non persisté");
});

test("concurrence optimiste : version attendue incorrecte → ConcurrencyError", async (t) => {
  const store = await EventStore.open({ filePath: dbPath(t), projectors: [projectsProjector] });
  t.after(() => store.close());
  const id = randomUUID();
  await store.append([ev(id, 1)]);
  await assert.rejects(store.append([ev(id, 1)]), ConcurrencyError);
  await assert.rejects(store.append([ev(id, 3)]), ConcurrencyError);
  const results = await Promise.allSettled([store.append([ev(id, 2)]), store.append([ev(id, 2)])]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "un seul écrivain gagne");
  assert.equal(await store.currentVersion(id), 2);
});

test("journal en ajout seul au niveau SQLite : UPDATE et DELETE refusés même en SQL brut", async (t) => {
  const store = await EventStore.open({ filePath: dbPath(t) });
  t.after(() => store.close());
  await store.append([ev(randomUUID(), 1)]);
  await assert.rejects(store.prisma.$executeRawUnsafe(`UPDATE "events" SET "eventType" = 'x'`), /append-only/);
  await assert.rejects(store.prisma.$executeRawUnsafe(`DELETE FROM "events"`), /append-only/);
});

test("expurgation appliquée avant écriture : la valeur secrète n'atteint jamais la base", async (t) => {
  const secret = "sk-fixture-secret-value";
  const store = await EventStore.open({
    filePath: dbPath(t),
    redact: (p) => JSON.parse(JSON.stringify(p).split(secret).join("[REDACTED]")),
  });
  t.after(() => store.close());
  await store.append([ev(randomUUID(), 1, { note: `token ${secret}` })]);
  const raw = await store.prisma.$queryRawUnsafe<Array<{ payloadJson: string }>>(`SELECT "payloadJson" FROM "events"`);
  assert.ok(raw.every((r) => !r.payloadJson.includes(secret)));
});

test("lecture : agrégat ordonné, flux global paginé, enveloppe validée", async (t) => {
  const store = await EventStore.open({ filePath: dbPath(t) });
  t.after(() => store.close());
  const a = randomUUID();
  const b = randomUUID();
  await store.append([ev(a, 1), ev(b, 1), ev(a, 2)]);
  assert.deepEqual(
    (await store.loadAggregate(a)).map((e) => e.aggregateVersion),
    [1, 2],
  );
  assert.deepEqual(
    (await store.readFrom(1, 10)).map((e) => e.globalSequence),
    [2, 3],
  );
});

test("queryEvents : filtre par agrégats, type et séquence dans la base ; `last` = les plus récents en ordre", async (t) => {
  const store = await EventStore.open({ filePath: dbPath(t) });
  t.after(() => store.close());
  const a = randomUUID();
  const b = randomUUID();
  const c = randomUUID();
  await store.append([ev(a, 1), ev(b, 1), ev(c, 1), { ...ev(a, 2), eventType: "project.renamed" }, ev(b, 2)]);
  assert.deepEqual(
    (await store.queryEvents({ aggregateIds: [a, b], eventType: "project.created" })).map((e) => e.globalSequence),
    [1, 2, 5],
  );
  assert.deepEqual(
    (await store.queryEvents({ aggregateIds: [a, b], afterGlobalSequence: 1, limit: 2, last: true })).map(
      (e) => e.globalSequence,
    ),
    [4, 5],
  );
  assert.deepEqual(await store.queryEvents({ aggregateIds: [] }), []);
});

test("replay : projections reconstruites à l'identique depuis le journal", async (t) => {
  const store = await EventStore.open({ filePath: dbPath(t), projectors: [projectsProjector] });
  t.after(() => store.close());
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) await store.append([ev(id, 1), ev(id, 2, { name: "renamed" })]);
  const before = await store.prisma.project.findMany({ orderBy: { id: "asc" } });
  await store.prisma.project.deleteMany({});
  assert.equal(await store.rebuildProjections(), 4);
  assert.deepEqual(await store.prisma.project.findMany({ orderBy: { id: "asc" } }), before);
});

test("CRASH (AC-04) : SIGKILL pendant l'écriture → base intègre, projections = journal, lots tout-ou-rien", async (t) => {
  const file = dbPath(t);
  const writer = fileURLToPath(new URL("./fixtures/crash-writer.ts", import.meta.url));
  for (let round = 0; round < 3; round++) {
    const child = spawn(process.execPath, [writer, file], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) => d.toString().includes("READY") && resolve());
      child.once("exit", (c) => reject(new Error(`writer exited early (${c})`)));
    });
    await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 250)));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  const store = await EventStore.open({ filePath: file, projectors: [projectsProjector] });
  t.after(() => store.close());
  assert.equal(await store.integrityCheck(), "ok");
  const events = await store.readFrom(0, 10_000);
  assert.ok(events.length > 0, "le writer a écrit avant d'être tué");
  // Lots de 3 : le nombre d'événements par agrégat est toujours un multiple de 3.
  const byAggregate = new Map<string, number[]>();
  for (const e of events)
    byAggregate.set(e.aggregateId, [...(byAggregate.get(e.aggregateId) ?? []), e.aggregateVersion]);
  for (const [id, versions] of byAggregate) {
    assert.equal(versions.length % 3, 0, `lot partiel détecté pour ${id}`);
    assert.deepEqual(
      versions,
      versions.map((_, i) => i + 1),
      "versions contiguës",
    );
    const projected = await store.prisma.project.findUnique({ where: { id } });
    assert.equal(projected?.version, versions.length, "projection alignée sur le journal");
  }
});
