import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Pool } from "pg";
import { PostgresStorage } from "../storage.js";
import { activateIdentityProtocolV2 } from "./activate-v2.js";

const run = promisify(execFile);

test("operator activation audits lifecycle counts, raises the floor once and is idempotent; dry-run and missing confirmation change nothing", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `identity_activation_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  await root.query(`create schema "${schema}"`);
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  t.after(async () => { await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const storage = new PostgresStorage(pool);
  await storage.init();
  const created = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Ended before activation" });
  await pool.query(`update rooms set session_control = jsonb_set(session_control, '{endedAt}', to_jsonb('2026-10-01T00:00:00.000Z'::text)) where room_id=$1`, [created.roomId]);

  const cli = fileURLToPath(new URL("./activate-v2.js", import.meta.url));
  const env = { ...process.env, POSTGRES_URL: connection.href, STATE_TOKEN_SECRET: "identity-activation-test-secret-0123456789" };
  const refused = await run(process.execPath, [cli], { env }).then(() => ({ stdout: "", code: 0 }), error => error as { stdout: string; code: number });
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(refused.stdout), { ok: false, error: "identity_activation_confirmation_required" });
  const dry = JSON.parse((await run(process.execPath, [cli, "--dry-run"], { env })).stdout);
  assert.equal(dry.ok, true); assert.equal(dry.before, 1); assert.equal(dry.after, 1); assert.equal(dry.raised, false);
  assert.ok(dry.audit.rooms >= 1); assert.ok(dry.audit.endedRooms >= 1); assert.equal(dry.secretReady, true);
  const short = { ...env, STATE_TOKEN_SECRET: "short-activation-secret" };
  assert.equal(JSON.parse((await run(process.execPath, [cli, "--dry-run"], { env: short })).stdout).secretReady, false);
  const refusedShort = await run(process.execPath, [cli, "--confirm-irreversible"], { env: short })
    .then(() => ({ stdout: "", code: 0 }), error => error as { stdout: string; code: number });
  assert.deepEqual([refusedShort.code, JSON.parse(refusedShort.stdout)], [1, { ok: false, error: "identity_activation_secret_too_short" }]);
  assert.equal(await storage.identityProtocol.minimum(), 1, "a dry run never raises the floor");
  assert.equal(JSON.stringify(dry).includes(created.roomId), false, "the audit carries counts, not room identifiers");

  const raised = JSON.parse((await run(process.execPath, [cli, "--confirm-irreversible"], { env })).stdout);
  assert.deepEqual([raised.ok, raised.before, raised.after, raised.raised], [true, 1, 2, true]);
  assert.equal(await storage.identityProtocol.minimum(), 2);
  assert.match(await storage.identityProtocol.mediaNamespace() ?? "", /^[a-f0-9]{32}$/);
  const ended = (await pool.query("select session_control->>'endedAt' as ended from rooms where room_id=$1", [created.roomId])).rows[0];
  assert.equal(ended.ended, "2026-10-01T00:00:00.000Z", "saved lifecycle decisions are kept, not cleared");

  const again = await activateIdentityProtocolV2(pool, { dryRun: false });
  assert.deepEqual([again.before, again.after, again.raised], [2, 2, false]);
  await assert.rejects(storage.identityProtocol.raise(1), /identity_protocol_downgrade_forbidden/);
});
