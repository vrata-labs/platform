import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { MemoryStorage, PostgresStorage } from "./storage.js";
import type { Storage } from "./storage-contracts.js";
import { IdentityStorageError } from "./identity/contracts.js";
import { createRoomIdentityService } from "./identity/service.js";
import { PersonalOwnerRoomBlocked } from "./identity/personal-owner-response.js";

const secret = "personal-owner-response-test-key-32-bytes";
const admin = { actorType: "admin-token" as const, actorId: "verified-admin", role: "admin" as const };
const code = (expected: string) => (error: unknown) => error instanceof IdentityStorageError && error.code === expected;

async function fixture(t: TestContext, postgres: boolean) {
  let at = Date.now();
  const now = () => at;
  let storage: Storage;
  let pool: Pool | undefined;
  let observer: Pool | undefined;
  if (postgres) {
    assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
    const schema = `personal_owner_${randomUUID().replaceAll("-", "")}`;
    const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
    await root.query(`create schema "${schema}"`);
    const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
    connection.searchParams.set("options", `-c search_path=${schema},public`);
    pool = new Pool({ connectionString: connection.href, max: 1, connectionTimeoutMillis: 1000 });
    observer = new Pool({ connectionString: connection.href });
    t.after(async () => { await pool!.end(); await observer!.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
    const adapter = new PostgresStorage(pool, now);
    await adapter.init();
    storage = adapter;
  } else storage = new MemoryStorage(now);
  await storage.identityProtocol.raise(2);
  const codec = createRoomIdentityCodec(secret);
  const service = createRoomIdentityService(storage.roomIdentities, secret, now, { identityLifetimeSeconds: 86_400 });
  const owner = async () => {
    const created = await storage.createPersonalOwnedRoom({ tenantId: "demo-tenant", templateId: "personal-workspace-basic", displayName: "Owner" });
    const credential = codec.sign(created.identity, { nowSeconds: Math.floor(at / 1000), lifetimeSeconds: 60 });
    const proof = codec.verify(credential, created.room, Math.floor(at / 1000))!;
    return { ...created, credential, proof, scope: { tenantId: created.room.tenantId, roomId: created.room.roomId } };
  };
  return { storage, pool, observer, service, owner, now, setTime(value: number) { at = value; } };
}

for (const postgres of [false, true]) test(`${postgres ? "postgres max=1" : "memory"}: personal reopen release uses original credential and current owner`, {
  skip: postgres && !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const f = await fixture(t, postgres);
  const first = await f.owner();
  let released = 0;
  await f.storage.releasePersonalRoomOwnerResponse(first.proof, (room, identity) => {
    released++; assert.equal(room.ownerParticipantId, first.identity.participantId);
    assert.deepEqual(identity, first.identity);
    const renewed = createRoomIdentityCodec(secret).sign(identity, { nowSeconds: Math.floor(f.now() / 1000), lifetimeSeconds: 86_400 });
    assert.equal(createRoomIdentityCodec(secret).verify(renewed, first.scope, Math.floor(f.now() / 1000))!.authEpoch, identity.authEpoch);
  });
  assert.equal(released, 1);
  const invite = await f.storage.createRoomInviteV2({ roomId: first.room.roomId, role: "member", waitingRoomEnabled: false,
    tokenHash: randomBytes(32).toString("base64url"), expiresAt: new Date(f.now() + 600_000).toISOString(), actor: admin });
  const successor = await f.service.admit({ ...first.scope, displayName: "New owner", inviteTokenHash: invite.tokenHash });
  const authority = await f.storage.roomIdentities.authority(first.scope);
  await f.storage.roomIdentities.transition(first.scope, admin, authority!.revision,
    { type: "transfer-owner", targetParticipantId: successor.identity.participantId });
  await assert.rejects(f.storage.releasePersonalRoomOwnerResponse(first.proof, () => { released++; }), code("identity_forbidden"));
  const successorProof = createRoomIdentityCodec(secret).verify(successor.credential, first.scope, Math.floor(f.now() / 1000))!;
  await f.storage.releasePersonalRoomOwnerResponse(successorProof, (room, identity) => {
    released++; assert.equal(room.ownerParticipantId, successor.identity.participantId, "DTO projects current owner, not frozen legacy owner");
    assert.deepEqual(identity, successor.identity, "release supplies the freshly authorized identity to the synchronous signer");
  });
  assert.equal(released, 2);
  assert.equal((await f.storage.roomIdentities.resolve(first.identity))!.role, "host", "Host is not owner proof after transfer");
  const standard = await f.storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Not personal" });
  const guest = await f.service.admit({ tenantId: standard.tenantId, roomId: standard.roomId, displayName: "Guest" });
  const guestProof = createRoomIdentityCodec(secret).verify(guest.credential, standard, Math.floor(f.now() / 1000))!;
  await assert.rejects(f.storage.releasePersonalRoomOwnerResponse(guestProof, () => { released++; }), code("room_not_found"));
  assert.equal(released, 2, "a valid proof for another room type cannot reopen a personal room");

  for (const change of ["expiry", "epoch", "revoke", "delete", "disable", "end", "scope"] as const) {
    const owned = await f.owner();
    let sent = false;
    if (change === "expiry") {
      f.setTime(owned.proof.expiresAtSeconds * 1000);
    } else if (change === "epoch") {
      const recovery = await f.service.issueRecovery({ ...owned.scope, issuer: admin, targetRole: "owner", targetParticipantId: owned.identity.participantId,
        expiresAt: new Date(f.now() + 600_000).toISOString() });
      await f.service.redeemRecovery(recovery.credential, owned.scope);
    } else if (change === "revoke") await f.storage.roomIdentities.revoke(owned.scope, owned.identity.identityId, 1);
    else if (change === "delete") await f.storage.deleteRoom(owned.room.roomId);
    else if (change === "disable") await f.storage.updateRoom(owned.room.roomId, { status: "disabled", disabledAt: new Date(f.now()).toISOString() });
    else if (change === "end") await f.storage.roomIdentities.transition(owned.scope, admin, 1, { type: "end" });
    const proof = change === "scope" ? { ...owned.proof, tenantId: "foreign-tenant" } : owned.proof;
    await assert.rejects(f.storage.releasePersonalRoomOwnerResponse(proof, () => { sent = true; }),
      error => code(change === "delete" || change === "scope" ? "room_not_found" : change === "disable" || change === "end" ? "room_blocked" : "identity_not_active")(error)
        && (change !== "disable" && change !== "end" || error instanceof PersonalOwnerRoomBlocked
          && error.reason === (change === "disable" ? "room_disabled" : "session_ended")));
    assert.equal(sent, false, change);
    if (change === "disable") {
      await f.storage.updateRoom(owned.room.roomId, { status: "active", disabledAt: null });
      await f.storage.releasePersonalRoomOwnerResponse(owned.proof, (_room, identity) => {
        assert.deepEqual(identity, owned.identity, "temporary disable does not revoke the original RI2 identity");
      });
    }
  }
});

test("PostgreSQL owner-proof release samples expiry after actual parent lock wait with a one-client pool", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const f = await fixture(t, true);
  for (const change of ["allow", "transfer", "epoch", "revoke", "delete", "disable", "expiry"] as const) {
    const owned = await f.owner();
    const holder = await f.observer!.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select room_id from rooms where room_id=$1 for update", [owned.room.roomId]);
      const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
      let sent = false;
      pending = f.storage.releasePersonalRoomOwnerResponse(owned.proof, (_room, identity) => {
        assert.deepEqual(identity, owned.identity);
        const credential = createRoomIdentityCodec(secret).sign(identity, { nowSeconds: Math.floor(f.now() / 1000), lifetimeSeconds: 86_400 });
        assert.ok(createRoomIdentityCodec(secret).verify(credential, owned.scope, Math.floor(f.now() / 1000)));
        sent = true;
      }).then(
        () => ({ ok: true }), error => ({ ok: false, error }));
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked = (await f.observer!.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting;
        if (blocked) break;
        await delay(10);
      }
      assert.equal(blocked, true, change);
      assert.equal(sent, false);
      if (change === "transfer") await holder.query("update room_identity_authority_v2 set owner_identity_id=null, revision=revision+1 where room_id=$1", [owned.room.roomId]);
      if (change === "epoch" || change === "revoke") await holder.query(`update room_identities_v2 set auth_epoch=auth_epoch+1${change === "revoke" ? ", revoked_at=now()" : ""} where room_id=$1`, [owned.room.roomId]);
      if (change === "delete") await holder.query("delete from rooms where room_id=$1", [owned.room.roomId]);
      if (change === "disable") await holder.query("update rooms set status='disabled',disabled_at=now() where room_id=$1", [owned.room.roomId]);
      if (change === "expiry") f.setTime(owned.proof.expiresAtSeconds * 1000);
      await holder.query("commit");
      const result = await pending as { ok: boolean; error?: unknown };
      assert.equal(result.ok, change === "allow", change);
      assert.equal(sent, change === "allow");
      if (!result.ok) assert.ok(result.error instanceof IdentityStorageError);
    } finally {
      await holder.query("rollback").catch(() => undefined); holder.release();
      if (pending) await pending;
    }
  }
});
