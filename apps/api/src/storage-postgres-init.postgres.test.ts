import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { initializePostgresStorage } from "./storage-postgres-init.js";
import { PostgresStorage } from "./storage.js";

const postgresUrl = process.env.VRATA_TEST_POSTGRES_URL;

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
