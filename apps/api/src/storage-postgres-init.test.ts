import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { initializePostgresStorage } from "./storage-postgres-init.js";
import { createStorageInitHarness, deferred, type InitPhase } from "./testing/storage-postgres-init-harness.js";

function transactionTrace(h: ReturnType<typeof createStorageInitHarness>): string[] {
  return h.trace.flatMap(entry => entry.kind !== "query" ? [entry.kind]
    : /pg_advisory_|^(begin|commit|rollback)$/.test(entry.sql) ? [entry.sql] : []);
}
const lockSql = "select pg_advisory_lock(hashtextextended('vrata:postgres-storage-init:v1', 0))";
const unlockSql = "select pg_advisory_unlock(hashtextextended('vrata:postgres-storage-init:v1', 0)) as unlocked";

test("Postgres initialization preserves the full original query/phase/client lifecycle trace", async () => {
  const h = createStorageInitHarness();
  await initializePostgresStorage(h.pool, h.hooks);
  // Original implementation, with the same three catalog phases supplied by this harness.
  assert.equal(createHash("sha256").update(JSON.stringify(h.trace)).digest("hex"), "3058f515129030d1f7822bc000352c9a63340a893e01192402d9223349e6bdaf");
  assert.deepEqual(transactionTrace(h), ["connect", lockSql, "begin", "seed", "validateStoredTemplateVersions", "synchronizeTemplateCatalog", "commit", unlockSql, "release"]);
});

test("Postgres initialization propagates connection acquisition failure without cleanup", async () => {
  const failure = new Error("connect_failed");
  const h = createStorageInitHarness({ connectError: failure });
  await assert.rejects(initializePostgresStorage(h.pool, h.hooks), error => error === failure);
  assert.deepEqual(transactionTrace(h), ["connect"]);
});

for (const sql of [lockSql, "begin"]) {
  test(`Postgres initialization releases the client after ${sql === lockSql ? "lock" : "begin"} failure`, async () => {
    const failure = new Error("query_failed");
    const h = createStorageInitHarness({ beforeQuery: query => { if (query.sql === sql) throw failure; } });
    await assert.rejects(initializePostgresStorage(h.pool, h.hooks), error => error === failure);
    assert.deepEqual(transactionTrace(h), sql === lockSql
      ? ["connect", lockSql, "release"] : ["connect", lockSql, "begin", unlockSql, "release"]);
  });
}

const failedQueries = [
  ["schema", (sql: string) => sql.includes("create table if not exists tenants")],
  ["base constraints", (sql: string) => sql.includes("add constraint template_versions_template_id_fkey")],
  ["room backfill", (sql: string) => sql.includes("with desired as")],
  ["version constraints", (sql: string) => sql.includes("add constraint templates_current_version_fkey")],
  ["backfill verification", (sql: string) => sql.startsWith("select 1 from rooms where template_version")],
  ["not null constraints", (sql: string) => sql.startsWith("alter table rooms alter column template_version set not null")],
  ["immutable trigger", (sql: string) => sql.includes("create trigger template_versions_immutable")],
  ["commit", (sql: string) => sql === "commit"]
] as const;
for (const [label, matches] of failedQueries) {
  test(`Postgres initialization rolls back and unlocks after ${label} failure`, async () => {
    const failure = new Error(label);
    let injected = false;
    const h = createStorageInitHarness({ beforeQuery: query => {
      if (matches(query.sql)) { injected = true; throw failure; }
    } });
    await assert.rejects(initializePostgresStorage(h.pool, h.hooks), error => error === failure);
    assert(injected);
    assert.deepEqual(h.queries.slice(-2).map(query => query.sql), ["rollback", unlockSql]);
    assert.equal(h.trace.at(-1)?.kind, "release");
    assert.equal(h.queries.filter(query => query.sql === "commit").length, label === "commit" ? 1 : 0);
  });
}

for (const phase of ["seed", "validateStoredTemplateVersions", "synchronizeTemplateCatalog"] as const) {
  test(`Postgres initialization stops after a failed ${phase} callback and preserves its error`, async () => {
    const failure = new Error(phase);
    const phases: InitPhase[] = [];
    const h = createStorageInitHarness({ beforePhase: name => {
      phases.push(name);
      if (name === phase) throw failure;
    } });
    await assert.rejects(initializePostgresStorage(h.pool, h.hooks), error => error === failure);
    assert.equal(phases.at(-1), phase);
    assert.deepEqual(transactionTrace(h), ["connect", lockSql, "begin", ...phases, "rollback", unlockSql, "release"]);
    assert(!h.queries.some(query => query.sql.includes("with desired as")));
  });
}

test("Postgres initialization waits for seeding before validation, commit and connection release", async () => {
  const reached = deferred();
  const resume = deferred();
  const h = createStorageInitHarness({ beforePhase: async name => {
    if (name === "seed") { reached.resolve(); await resume.promise; }
  } });
  const pending = initializePostgresStorage(h.pool, h.hooks);
  try {
    await reached.promise;
    assert.deepEqual(transactionTrace(h), ["connect", lockSql, "begin", "seed"]);
  } finally { resume.resolve(); }
  await pending;
  assert.equal(h.trace.at(-1)?.kind, "release");
});

test("Postgres initialization rejects incomplete room metadata before not-null constraints and trigger installation", async () => {
  const h = createStorageInitHarness({ incompleteBackfill: true });
  await assert.rejects(initializePostgresStorage(h.pool, h.hooks), /incomplete_room_template_backfill/);
  assert(!h.queries.some(query => query.sql.includes("set not null") || query.sql.includes("create trigger")));
  assert.deepEqual(h.queries.slice(-2).map(query => query.sql), ["rollback", unlockSql]);
});

test("Postgres initialization rolls back when the immutable table schema cannot be resolved", async () => {
  const h = createStorageInitHarness({ tableSchema: null });
  await assert.rejects(initializePostgresStorage(h.pool, h.hooks), /postgres_table_schema_not_found:template_versions/);
  assert.deepEqual(h.queries.slice(-2).map(query => query.sql), ["rollback", unlockSql]);
});

for (const unlockRows of [[], [{ unlocked: false }], [{ unlocked: "true" }]]) {
  test(`Postgres initialization requires the exact successful unlock value: ${JSON.stringify(unlockRows)}`, async () => {
    const h = createStorageInitHarness({ unlockRows });
    await assert.rejects(initializePostgresStorage(h.pool, h.hooks), /postgres_init_advisory_unlock_failed/);
    assert.equal(h.trace.at(-1)?.kind, "release");
    assert(h.queries.some(query => query.sql === "commit"));
    assert(!h.queries.some(query => query.sql === "rollback"));
  });
}

for (const cleanup of ["rollback", "unlock", "release"] as const) {
  test(`Postgres initialization preserves ${cleanup} error precedence and still attempts the original cleanup`, async () => {
    const initial = new Error("seed_failed");
    const failure = new Error(`${cleanup}_failed`);
    const h = createStorageInitHarness({
      beforePhase: () => { throw initial; },
      beforeQuery: ({ sql }) => {
        if ((cleanup === "rollback" && sql === "rollback") || (cleanup === "unlock" && sql === unlockSql)) throw failure;
      },
      releaseError: cleanup === "release" ? failure : undefined
    });
    await assert.rejects(initializePostgresStorage(h.pool, h.hooks), error => error === failure);
    assert.deepEqual(transactionTrace(h), ["connect", lockSql, "begin", "seed", "rollback", unlockSql, "release"]);
  });
}

test("Postgres initialization keeps concurrent calls independent when one seed fails", async () => {
  const ready = deferred();
  const resume = deferred();
  const failure = new Error("first_seed_failed");
  const first = createStorageInitHarness({ beforePhase: async () => {
    ready.resolve(); await resume.promise; throw failure;
  } });
  const second = createStorageInitHarness();
  const pending = assert.rejects(initializePostgresStorage(first.pool, first.hooks), error => error === failure);
  try {
    await ready.promise;
    await initializePostgresStorage(second.pool, second.hooks);
    assert(!first.queries.some(query => query.sql === "commit" || query.sql === unlockSql));
    assert(second.queries.some(query => query.sql === "commit"));
  } finally { resume.resolve(); }
  await pending;
  assert.equal(first.trace.at(-1)?.kind, "release");
  assert.equal(second.trace.at(-1)?.kind, "release");
});
