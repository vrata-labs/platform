import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Pool } from "pg";
import { PostgresStorage } from "./storage.js";
import { createRoomIdentityService } from "./identity/service.js";
import { IdentityStorageError } from "./identity/contracts.js";
import type { RoomEffectGuard } from "./identity/effect-write-guard.js";

test("guarded note writes and v2 revocation serialize on the same parent room", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `identity_effect_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  t.after(async () => {
    await pool.end();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  });
  await admin.query(`create schema "${schema}"`);
  const storage = new PostgresStorage(pool);
  await storage.init();
  await storage.identityProtocol.raise(2);
  const service = createRoomIdentityService(storage.roomIdentities, "identity-effect-proof-key-32-bytes-or-longer");

  async function createHost() {
    const legacyId = randomUUID();
    const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Guarded notes",
      sessionControl: { hostParticipantId: legacyId } });
    const scope = { tenantId: room.tenantId, roomId: room.roomId };
    const recovery = await service.issueRecovery({ ...scope, targetParticipantId: legacyId, targetRole: "host",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      issuer: { actorType: "admin-token", actorId: "test-admin", role: "admin" } });
    const host = await service.redeemRecovery(recovery.credential, scope);
    const guard: RoomEffectGuard = { ...host.identity, expiresAtSeconds: Math.floor(Date.now() / 1000) + 120,
      permission: "notes.edit" };
    return { room, scope, host, guard };
  }

  const revoked = await createHost();
  const holder = await pool.connect();
  try {
    await holder.query("begin");
    await holder.query("select room_id from rooms where tenant_id=$1 and room_id=$2 for update",
      [revoked.scope.tenantId, revoked.scope.roomId]);
    let enteredEffect = false;
    const pending = storage.withRoomIdentityEffect(revoked.guard, scoped => {
      enteredEffect = true;
      return scoped.upsertRoomNote({ roomId: revoked.room.roomId, scope: "shared", content: "must not publish",
        updatedBy: revoked.host.identity.participantId });
    });
    await delay(40);
    assert.equal(enteredEffect, false, "the effect must wait behind the revoking room transaction");
    await holder.query("update room_identities_v2 set auth_epoch=auth_epoch+1, revoked_at=now() where room_id=$1 and identity_id=$2",
      [revoked.room.roomId, revoked.host.identity.identityId]);
    await holder.query("commit");
    await assert.rejects(pending, (error: unknown) => error instanceof IdentityStorageError && error.code === "identity_not_active");
    assert.equal(await storage.getRoomNote(revoked.room.roomId, "shared"), null);
    assert.deepEqual(await storage.listRoomNoteVersions(revoked.room.roomId, "shared"), []);
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
  }

  const allowed = await createHost();
  let releaseEffect!: () => void;
  const holdEffect = new Promise<void>(resolve => { releaseEffect = resolve; });
  let enteredEffect!: () => void;
  const effectStarted = new Promise<void>(resolve => { enteredEffect = resolve; });
  const approvedWrite = storage.withRoomIdentityEffect(allowed.guard, async scoped => {
    enteredEffect();
    await holdEffect;
    return scoped.upsertRoomNote({ roomId: allowed.room.roomId, scope: "shared", content: "published before revoke",
      updatedBy: allowed.host.identity.participantId });
  });
  await effectStarted;
  let revokeCompleted = false;
  const remove = storage.roomIdentities.revoke(allowed.scope, allowed.host.identity.identityId, 1)
    .then(value => { revokeCompleted = true; return value; });
  await delay(40);
  assert.equal(revokeCompleted, false, "revocation must queue behind a committed guarded write");
  releaseEffect();
  assert.equal((await approvedWrite).content, "published before revoke");
  await remove;
  assert.equal((await storage.getRoomNote(allowed.room.roomId, "shared"))?.content, "published before revoke");
  await assert.rejects(storage.withRoomIdentityEffect(allowed.guard, scoped => scoped.upsertRoomNote({
    roomId: allowed.room.roomId, scope: "shared", content: "must not follow revoke"
  })), (error: unknown) => error instanceof IdentityStorageError && error.code === "identity_not_active");

  const atomic = await createHost();
  const singlePool = new Pool({ connectionString: connection.href, max: 1, connectionTimeoutMillis: 1000 });
  try {
    const singleStorage = new PostgresStorage(singlePool);
    await assert.rejects(singleStorage.withRoomIdentityEffect(atomic.guard, async scoped => {
      await scoped.upsertRoomNote({ roomId: atomic.room.roomId, scope: "shared", content: "must roll back" });
      throw new Error("abort_effect");
    }), /abort_effect/);
    assert.equal(await storage.getRoomNote(atomic.room.roomId, "shared"), null);
    assert.deepEqual(await storage.listRoomNoteVersions(atomic.room.roomId, "shared"), []);
    const saved = await singleStorage.withRoomIdentityEffect(atomic.guard, scoped => scoped.upsertRoomNote({
      roomId: atomic.room.roomId, scope: "shared", content: "one connection suffices"
    }));
    assert.equal(saved.content, "one connection suffices");
  } finally { await singlePool.end(); }
  const concurrentPool = new Pool({ connectionString: connection.href, max: 3, connectionTimeoutMillis: 1000 });
  try {
    const concurrentStorage = new PostgresStorage(concurrentPool);
    const writes = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      concurrentStorage.withRoomIdentityEffect(atomic.guard, scoped => scoped.upsertRoomNote({
        roomId: atomic.room.roomId, scope: "shared", content: `concurrent-${index}`
      }))));
    assert.equal(writes.length, 6);
    assert.equal((await storage.listRoomNoteVersions(atomic.room.roomId, "shared")).length, 7);
  } finally { await concurrentPool.end(); }
});
