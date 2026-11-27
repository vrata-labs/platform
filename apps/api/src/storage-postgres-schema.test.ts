import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ensurePostgresStorageSchema as runSchema, DEFAULT_PERSONAL_STATE_JSON, DEFAULT_SESSION_CONTROL_JSON } from "./storage-postgres-schema.js";
import type { PoolClient } from "pg";
import { createStorageInitHarness, deferred } from "./testing/storage-postgres-init-harness.js";

// Captured from the original PostgresStorage.initWithClient on 4734791267932326f053b4d32d5bb1d186ec4d66.
// Include raw SQL whitespace and values, not a normalized rendering of the new implementation.
const historicalSchemaQueryCount = 41;
const schemaQueriesSha256 = "cdbf7debef65bf61c5728f5217e537a0fdeb0e68450a251e1088eb79cba6a586";
const browserMigration = new Map([
  [19, "c4bf1bdc83708e99a9ec76670ece4e4debbc236e88d9898aedbb4b6513e3861e"],
  [35, "082e9619046b43ed3fe1ba2b4892663ea974e0dde079ca444a1de74c729fc816"]
]);
const schemaQueryCount = historicalSchemaQueryCount + browserMigration.size;
const ensurePostgresStorageSchema = (client: PoolClient) => runSchema(client, async () => {});

test("room schema extensions are awaited once after session migration and before bundle migration", async () => {
  const h = createStorageInitHarness(), reached = deferred(), resume = deferred(); let calls = 0;
  const pending = runSchema(h.client, async client => {
    assert.equal(client, h.client); calls++;
    assert(h.queries.at(-2)!.sql.endsWith("::jsonb || session_control"));
    assert(h.queries.at(-1)!.sql.includes("create or replace trigger version_room_browser_policy"));
    reached.resolve(); await resume.promise;
  });
  try { await reached.promise; assert(!h.queries.some(query => query.sql.startsWith("alter table scene_bundles"))); }
  finally { resume.resolve(); }
  await pending; assert.equal(calls, 1);
});

test("Postgres schema preserves the original SQL and installs the two browser policy migrations in order", async () => {
  const h = createStorageInitHarness();
  await ensurePostgresStorageSchema(h.client);
  assert.equal(h.queries.length, schemaQueryCount);
  for (const [index, digest] of browserMigration) {
    assert.equal(createHash("sha256").update(JSON.stringify(h.queries[index])).digest("hex"), digest, `browser policy query ${index}`);
  }
  const original = h.queries.filter((_, index) => !browserMigration.has(index));
  assert.equal(createHash("sha256").update(JSON.stringify(original)).digest("hex"), schemaQueriesSha256);
  assert(h.trace.every(entry => entry.kind === "query"), "schema must not own the connection or transaction");
});

test("Postgres schema adds session control before changing defaults or filling legacy rows", async () => {
  const h = createStorageInitHarness();
  await ensurePostgresStorageSchema(h.client);
  const sql = h.queries.map(query => query.sql);
  const add = sql.findIndex(value => value.startsWith("alter table rooms add column if not exists session_control"));
  const alter = sql.findIndex(value => value.startsWith("alter table rooms alter column session_control"));
  const fill = sql.findIndex(value => value.startsWith("update rooms set session_control") && value.includes("where session_control is null"));
  const merge = sql.findIndex(value => value.endsWith("::jsonb || session_control"));
  assert(add > 0 && alter > add && fill > alter && merge > fill);
  for (const index of [add, alter, fill, merge]) assert(sql[index]!.includes(DEFAULT_SESSION_CONTROL_JSON));
  assert.equal(DEFAULT_PERSONAL_STATE_JSON, "{}");
  assert.equal(JSON.parse(DEFAULT_SESSION_CONTROL_JSON).hostParticipantId, null);
});

test("Postgres schema keeps stored avatar and session values on the right of the JSON merge", async () => {
  const h = createStorageInitHarness();
  await ensurePostgresStorageSchema(h.client);
  for (const column of ["avatar_config", "session_control"]) {
    const merges = h.queries.filter(query => query.sql.endsWith(`::jsonb || ${column}`));
    assert.equal(merges.length, 1);
    assert(merges[0]!.sql.startsWith(`update rooms set ${column} = '`));
  }
});

for (const stopAt of [0, 19, 20, 35, schemaQueryCount - 1]) {
  test(`Postgres schema awaits query ${stopAt} before issuing the next query`, async () => {
    const reached = deferred();
    const resume = deferred();
    const h = createStorageInitHarness({ beforeQuery: async (_, index) => {
      if (index === stopAt) { reached.resolve(); await resume.promise; }
    } });
    const pending = ensurePostgresStorageSchema(h.client);
    try {
      await reached.promise;
      assert.equal(h.queries.length, stopAt + 1);
      await Promise.resolve();
      assert.equal(h.queries.length, stopAt + 1);
    } finally { resume.resolve(); }
    await pending;
    assert.equal(h.queries.length, schemaQueryCount);
  });

  test(`Postgres schema stops at failed query ${stopAt} without replacing its error`, async () => {
    const failure = new Error(`schema_failure_${stopAt}`);
    const h = createStorageInitHarness({ beforeQuery: (_, index) => {
      if (index === stopAt) throw failure;
    } });
    await assert.rejects(ensurePostgresStorageSchema(h.client), error => error === failure);
    assert.equal(h.queries.length, stopAt + 1);
    assert(h.trace.every(entry => entry.kind === "query"));
  });
}

test("Postgres schema runs the complete sequence on repeated initialization without a process cache", async () => {
  const h = createStorageInitHarness();
  await ensurePostgresStorageSchema(h.client);
  const first = structuredClone(h.queries);
  await ensurePostgresStorageSchema(h.client);
  assert.deepEqual(h.queries, [...first, ...first]);
});
