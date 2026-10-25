import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Pool } from "pg";
import { PostgresStorage } from "../storage.js";
import { activateMediaCodec3 } from "./activate-media-codec.js";
import { MediaBoundaryChanged } from "./effect-write-guard.js";

const run = promisify(execFile);

async function ownedSchema(t: test.TestContext, prefix: string) {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  await root.query(`create schema "${schema}"`);
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  t.after(async () => { await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  return { pool, connection };
}

test("room incarnations are fresh per inserted record, survive updates and cannot be rewritten", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const { pool } = await ownedSchema(t, "media_incarnation");
  const storage = new PostgresStorage(pool);
  await storage.init();
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Lineage" });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  const first = await storage.roomIdentities.mediaIncarnation(scope);
  assert.match(first ?? "", /^[a-f0-9]{32}$/);
  const seeded = (await pool.query("select count(distinct media_incarnation)::int as distinct_values, count(*)::int as total from rooms")).rows[0];
  assert.equal(seeded.distinct_values, seeded.total, "every row, including the seed, has its own generation");
  await storage.updateRoom(room.roomId, { name: "Renamed" });
  assert.equal(await storage.roomIdentities.mediaIncarnation(scope), first, "an ordinary update keeps the generation");
  await assert.rejects(pool.query("update rooms set media_incarnation=$2 where room_id=$1", [room.roomId, "f".repeat(32)]), /immutable_room_media_incarnation/);
  await assert.rejects(pool.query("insert into rooms (room_id, tenant_id, template_id, name, features, template_version, template_snapshot, media_incarnation) select 'bad', tenant_id, template_id, name, features, template_version, template_snapshot, 'not-hex' from rooms where room_id=$1", [room.roomId]), /rooms_media_incarnation/);
  assert.equal(await storage.deleteRoom(room.roomId), true);
  assert.equal(await storage.roomIdentities.mediaIncarnation(scope), null);
  const again = await storage.createRoom({ roomId: room.roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Recreated" });
  const second = await storage.roomIdentities.mediaIncarnation({ tenantId: again.tenantId, roomId: again.roomId });
  assert.match(second ?? "", /^[a-f0-9]{32}$/);
  assert.notEqual(second, first, "a recreated record never reuses the deleted generation");
  // A second init re-verifies the installed lineage schema rather than rewriting it.
  await new PostgresStorage(pool).init();
  assert.equal(await storage.roomIdentities.mediaIncarnation({ tenantId: again.tenantId, roomId: again.roomId }), second);
});

test("the media codec boundary is monotonic, needs floor two and is raised only by the confirmed operator command", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const { pool, connection } = await ownedSchema(t, "media_codec");
  const storage = new PostgresStorage(pool);
  await storage.init();
  assert.equal(await storage.identityProtocol.mediaBoundary(), null);
  await assert.rejects(storage.identityProtocol.raiseMediaCodec(3), /media_codec_requires_identity_v2/);
  await assert.rejects(pool.query("update room_identity_protocol_policy set media_codec=3"), /identity_protocol_media_codec/);
  await storage.identityProtocol.raise(2);
  const namespace = await storage.identityProtocol.mediaNamespace();
  assert.ok(namespace);
  assert.deepEqual(await storage.identityProtocol.mediaBoundary(), { namespace, codec: 2 });
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Grant fence" });
  const scope = { tenantId: room.tenantId, roomId: room.roomId }, incarnation = (await storage.roomIdentities.mediaIncarnation(scope))!;
  let released = 0;
  await storage.releaseMediaGrant(scope, { codec: 2, namespace }, () => { released++; });
  assert.equal(released, 1, "a current codec-2 pin releases inside the fence");
  await assert.rejects(storage.releaseMediaGrant(scope, { codec: 3, namespace, incarnation }, () => { released++; }), MediaBoundaryChanged);
  await assert.rejects(storage.releaseMediaGrant({ ...scope, roomId: "missing-room" }, { codec: 2, namespace }, () => { released++; }), /room_not_found/);
  // A held policy share lock (any in-flight grant fence) blocks the raise instead of racing it.
  const holder = await pool.connect();
  try {
    await holder.query("begin");
    await holder.query("select media_codec from room_identity_protocol_policy where singleton=true for share");
    await assert.rejects(storage.identityProtocol.raiseMediaCodec(3), (error: { code?: string }) => error.code === "55P03");
  } finally { await holder.query("rollback"); holder.release(); }
  assert.equal((await storage.identityProtocol.mediaBoundary())?.codec, 2);

  const cli = fileURLToPath(new URL("./activate-media-codec.js", import.meta.url));
  const env = { ...process.env, POSTGRES_URL: connection.href };
  const refused = await run(process.execPath, [cli], { env }).then(() => ({ stdout: "", code: 0 }), error => error as { stdout: string; code: number });
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(refused.stdout), { ok: false, error: "media_codec_activation_confirmation_required" });
  assert.deepEqual(JSON.parse((await run(process.execPath, [cli, "--dry-run"], { env })).stdout), { ok: true, before: 2, after: 2, raised: false, dryRun: true });
  assert.equal((await storage.identityProtocol.mediaBoundary())?.codec, 2, "a dry run never raises the boundary");
  assert.deepEqual(JSON.parse((await run(process.execPath, [cli, "--confirm-irreversible"], { env })).stdout), { ok: true, before: 2, after: 3, raised: true, dryRun: false });
  assert.deepEqual(await storage.identityProtocol.mediaBoundary(), { namespace, codec: 3 }, "the namespace is kept");
  assert.deepEqual(await activateMediaCodec3(pool, { dryRun: false }), { before: 3, after: 3, raised: false, dryRun: false });
  await assert.rejects(storage.identityProtocol.raiseMediaCodec(2), /media_codec_downgrade_forbidden/);
  await assert.rejects(pool.query("update room_identity_protocol_policy set media_codec=2"), /media_codec_downgrade_forbidden/);
  await new PostgresStorage(pool).init();
  assert.equal((await storage.identityProtocol.mediaBoundary())?.codec, 3, "a restart keeps the raised boundary");
  await assert.rejects(storage.releaseMediaGrant(scope, { codec: 2, namespace }, () => { released++; }), MediaBoundaryChanged,
    "a codec-2 grant prepared before the raise is never released after it");
  await assert.rejects(storage.releaseMediaGrant(scope, { codec: 3, namespace, incarnation: "f".repeat(32) }, () => { released++; }), MediaBoundaryChanged);
  await storage.releaseMediaGrant(scope, { codec: 3, namespace, incarnation }, () => { released++; });
  assert.equal(released, 2);
  // A managed room's epoch row is locked too: a rotation is seen, and an unmanaged pin never matches it.
  const managed = await storage.createManagedRoom({ roomId: randomUUID(), tenantId: "demo-tenant", name: "Managed fence", visibility: "private" }, {
    managedBy: "portal:stage", kind: "reference", accessUntil: new Date(Date.now() + 3_600_000).toISOString(), graceSeconds: 0, operationId: randomUUID() });
  const managedScope = { tenantId: managed.tenantId, roomId: managed.roomId };
  const managedPin = { codec: 3 as const, namespace, incarnation: (await storage.roomIdentities.mediaIncarnation(managedScope))!, accessEpoch: managed.managed!.accessEpoch };
  await storage.releaseMediaGrant(managedScope, managedPin, () => { released++; });
  assert.equal(released, 3);
  assert.ok(await storage.rotateManagedRoomEpoch(managed.roomId, managed.managed!.accessEpoch, null));
  await assert.rejects(storage.releaseMediaGrant(managedScope, managedPin, () => { released++; }), MediaBoundaryChanged);
  await assert.rejects(storage.releaseMediaGrant(managedScope, { ...managedPin, accessEpoch: undefined }, () => { released++; }), MediaBoundaryChanged);
  assert.equal(released, 3);
});
