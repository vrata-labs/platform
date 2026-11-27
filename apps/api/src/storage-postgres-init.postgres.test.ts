import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { initializePostgresStorage } from "./storage-postgres-init.js";
import { PostgresStorage } from "./storage.js";
import { installRoomIdentitySchema } from "./identity/postgres-schema.js";
import { installRoomPluginSchema } from "./plugins/postgres-schema.js";
const installRoomExtensions = async (client: import("pg").PoolClient) => { await installRoomIdentitySchema(client); await installRoomPluginSchema(client); };

const postgresUrl = process.env.VRATA_TEST_POSTGRES_URL;

test("browser URL policy migration preserves old room rows and supports previous visibility writers", {
  skip: !postgresUrl && !process.env.CI, timeout: 120_000
}, async t => {
  assert.ok(postgresUrl);
  const schema = `browser_policy_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: postgresUrl });
  const pool = new Pool({ connectionString: postgresUrl, max: 1, options: `-c search_path=${schema},public` });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${schema}" cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema "${schema}"`);
  const storage = new PostgresStorage(pool);
  await storage.init();
  const before = await storage.createRoom({ name: "Old private room", visibility: "private" });
  const roomId = before.roomId;
  // Remove only this migration's objects: the schema and populated rows are now in the pre-policy shape.
  await pool.query(`drop trigger reset_room_browser_url_policy on rooms;
    drop function vrata_reset_room_browser_url_policy();
    alter table rooms drop column remote_browser_url_policy`);
  const oldRead = async () => (await pool.query("select name, visibility, guest_allowed from rooms where room_id=$1", [roomId])).rows[0];
  const oldRow = await oldRead();

  await storage.init();
  assert.deepEqual(await storage.getRoom(roomId), before);
  const storedPolicy = async () => (await pool.query("select remote_browser_url_policy from rooms where room_id=$1", [roomId])).rows[0].remote_browser_url_policy;
  assert.equal(await storedPolicy(), null);
  await assert.rejects(pool.query("update rooms set remote_browser_url_policy='http' where room_id=$1", [roomId]), { code: "23514" });
  await storage.updateRoom(roomId, { remoteBrowserUrlPolicy: "public-https" });
  await storage.init();
  assert.equal(await storedPolicy(), "public-https");
  assert.equal((await storage.getRoom(roomId))?.remoteBrowserUrlPolicy, "public-https");
  assert.deepEqual(await oldRead(), oldRow);
  for (const visibility of ["unlisted", "private"]) {
    // Previous API versions write only visibility; reopening must not recover the former opt-in.
    await pool.query("update rooms set visibility=$2 where room_id=$1", [roomId, visibility]);
    assert.equal(await storedPolicy(), null);
    assert.equal((await storage.getRoom(roomId))?.remoteBrowserUrlPolicy, undefined);
  }
  await assert.rejects(pool.query("update rooms set visibility='public', remote_browser_url_policy='public-https' where room_id=$1", [
    (await storage.createRoom({ name: "Public room" })).roomId
  ]), { code: "23514" });
});

test("Postgres initialization rolls back schema/data changes, unlocks and permits reinitialization on the same connection", {
  skip: postgresUrl ? false : "VRATA_TEST_POSTGRES_URL is required",
  timeout: 120_000
}, async () => {
  assert(postgresUrl);
  const schema = `init_refactor_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: postgresUrl });
  const pool = new Pool({ connectionString: postgresUrl, max: 1, options: `-c search_path=${schema},public` });
  const failure = new Error("injected_catalog_failure");
  try {
    await admin.query(`create schema "${schema}"`);
    await assert.rejects(initializePostgresStorage(pool, {
      installRoomExtensions,
      async seed(client) {
        await client.query("insert into tenants (tenant_id, name) values ('rolled-back', 'Uncommitted')");
        throw failure;
      },
      async validateStoredTemplateVersions() { assert.fail("must not validate after failed seed"); },
      async synchronizeTemplateCatalog() { assert.fail("must not synchronize after failed seed"); }
    }), error => error === failure);
    const tables = await admin.query("select tablename from pg_tables where schemaname = $1", [schema]);
    assert.deepEqual(tables.rows, [], "transaction must roll back DDL as well as data");
    const locks = await pool.query("select count(*)::int as count from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'");
    assert.equal(locks.rows[0].count, 0);

    const storage = new PostgresStorage(pool);
    await storage.init();
    const room = await storage.createRoom({ roomId: "preserved-room", name: "Preserved" });
    const tenantBefore = (await pool.query("select name from tenants where tenant_id = 'demo-tenant'")).rows[0].name;
    await assert.rejects(initializePostgresStorage(pool, {
      installRoomExtensions,
      async seed(client) { await client.query("update tenants set name = 'Uncommitted' where tenant_id = 'demo-tenant'"); },
      async validateStoredTemplateVersions() { throw failure; },
      async synchronizeTemplateCatalog() { assert.fail("must not synchronize after failed validation"); }
    }), error => error === failure);
    assert.equal((await pool.query("select name from tenants where tenant_id = 'demo-tenant'")).rows[0].name, tenantBefore);
    assert.equal((await pool.query("select count(*)::int as count from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'")).rows[0].count, 0);
    await storage.init();
    assert.deepEqual(await storage.getRoom(room.roomId), room);
  } finally {
    await pool.end();
    try { await admin.query(`drop schema if exists "${schema}" cascade`); }
    finally { await admin.end(); }
  }
});
