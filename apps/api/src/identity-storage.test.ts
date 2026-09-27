import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { MemoryStorage, PostgresStorage, type Storage } from "./storage.js";
import { createRoomIdentityService } from "./identity/service.js";
import { IdentityStorageError, type RoomIdentityScope } from "./identity/contracts.js";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const secret = "test-only-identity-root-secret-32-bytes-minimum";
const admin = { actorType: "admin-token", actorId: "verified-platform-admin", role: "admin" };
const code = (expected: string) => (error: unknown) => error instanceof IdentityStorageError && error.code === expected;

async function fixture(t: TestContext, backend: "memory" | "postgres") {
  let time = Date.now();
  const now = () => time;
  let storage: Storage;
  let pool: Pool | undefined;
  if (backend === "postgres") {
    assert.ok(process.env.VRATA_TEST_POSTGRES_URL, "CI identity contracts require real PostgreSQL");
    const schema = `identity_${randomUUID().replaceAll("-", "")}`;
    const adminPool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
    await adminPool.query(`create schema "${schema}"`);
    pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, max: 12, options: `-c search_path=${schema},public` });
    t.after(async () => { await pool!.end(); await adminPool.query(`drop schema "${schema}" cascade`); await adminPool.end(); });
    const postgres = new PostgresStorage(pool, now);
    await postgres.init();
    storage = postgres;
  } else storage = new MemoryStorage(now);
  const ids = storage.roomIdentities;
  const service = createRoomIdentityService(ids, secret, now);
  const makeRoom = async (personal = false) => {
    const roomId = randomUUID();
    const legacy = `legacy-${randomUUID()}`;
    const room = await storage.createRoom({ roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Identity contracts",
      roomType: personal ? "personal" : "standard", ownerParticipantId: personal ? legacy : null,
      sessionControl: { hostParticipantId: legacy } });
    return { scope: { roomId, tenantId: room.tenantId }, legacy };
  };
  const create = (scope: RoomIdentityScope, role: "guest" | "member" | "host" = "member") => service.admitFromVerifiedAccess({
    ...scope, displayName: "Identity fixture", baseRole: role === "guest" ? "guest" : "member",
    provenance: role === "guest" ? { kind: "guest" } : { kind: "invite", inviteId: "server-validated-invite", role }
  });
  const issueRecovery = (scope: RoomIdentityScope, participantId: string, role: "host" | "owner" = "host") => service.issueRecovery({
    ...scope, issuer: admin, targetRole: role, targetParticipantId: participantId, expiresAt: new Date(now() + 60_000).toISOString()
  });
  return { storage, ids, service, pool, now, advance: (ms: number) => { time += ms; }, makeRoom, create, issueRecovery };
}

for (const backend of ["memory", "postgres"] as const) {
  test(`${backend}: identity, authority and one-time recovery contract`, {
    skip: backend === "postgres" && !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI,
    timeout: 180_000
  }, async t => {
    const f = await fixture(t, backend);

    await t.test("IDs are server-assigned, provenance is immutable and scope never falls back", async () => {
      const { scope, legacy } = await f.makeRoom();
      const identity = await f.ids.create({ ...scope, displayName: "Guest", baseRole: "guest", provenance: { kind: "guest" },
        participantId: legacy } as Parameters<typeof f.ids.create>[0]);
      assert.notEqual(identity.participantId, legacy);
      assert.equal((await f.ids.resolve(identity))?.role, "guest");
      const read = await f.ids.get(scope, identity.identityId);
      read!.provenance = { kind: "invite", role: "host", inviteId: "forged" };
      await assert.rejects(f.ids.claimHost(identity, 0), code("identity_forbidden"));
      assert.deepEqual((await f.ids.get(scope, identity.identityId))?.provenance, { kind: "guest" });
      assert.equal(await f.ids.get({ ...scope, tenantId: "other" }, identity.identityId), null);
      assert.equal(await f.ids.get({ ...scope, roomId: "missing" }, identity.identityId), null);
      assert.equal(await f.ids.authority({ ...scope, roomId: "missing" }), null);
      assert.equal(await f.ids.resolve({ ...identity, participantId: legacy }), null);
      assert.equal(await f.ids.resolve({ ...identity, authEpoch: 2 }), null);
      await assert.rejects(f.ids.create({ ...scope, displayName: "Owner without proof", baseRole: "member", provenance: { kind: "personal-owner" } }), code("identity_forbidden"));
    });

    await t.test("legacy trusted host JWT cannot renew, recover or mutate v2 authority", async () => {
      const { scope, legacy } = await f.makeRoom();
      const n = Math.floor(f.now() / 1000);
      const token = signRoomSessionToken({ ...scope, participantId: legacy, displayName: "Legacy host", role: "host", roleSource: "trusted",
        permissions: [], sessionId: "legacy", jti: randomUUID(), iat: n, exp: n + 900 }, secret);
      assert.equal(await f.service.resolveCredential(token, scope), null);
      await assert.rejects(f.service.renewCredential(token, scope), code("identity_not_active"));
      await assert.rejects(f.service.claimHost(token, scope, 0), code("identity_not_active"));
      await assert.rejects(f.service.redeemRecovery(token, scope), code("recovery_invalid"));
      await assert.rejects(f.service.issueRecovery({ ...scope, targetRole: "host", targetParticipantId: legacy,
        expiresAt: new Date(f.now() + 60_000).toISOString(), issuer: { actorType: "room-session", role: "admin", actorId: legacy } }), code("identity_forbidden"));
      assert.equal((await f.ids.authority(scope))?.hostIdentityId, null);
    });

    await t.test("concurrent host claims and transfers are CAS; role is not cached in credentials", async () => {
      const { scope } = await f.makeRoom();
      const [a, b] = await Promise.all([f.create(scope, "host"), f.create(scope, "host")]);
      const claims = await Promise.allSettled([f.service.claimHost(a.credential, scope, 0), f.service.claimHost(b.credential, scope, 0)]);
      assert.equal(claims.filter(item => item.status === "fulfilled").length, 1);
      const host = claims[0].status === "fulfilled" ? a : b;
      const [x, y] = await Promise.all([f.create(scope), f.create(scope)]);
      const transfers = await Promise.allSettled([f.service.transferHost(host.credential, scope, x.identity.identityId, 1),
        f.service.transferHost(host.credential, scope, y.identity.identityId, 1)]);
      assert.equal(transfers.filter(item => item.status === "fulfilled").length, 1);
      const next = transfers[0].status === "fulfilled" ? x : y;
      assert.equal((await f.service.resolveCredential(host.credential, scope))?.role, "member");
      assert.equal((await f.service.resolveCredential(next.credential, scope))?.role, "host");
      const renewed = await f.service.renewCredential(next.credential, scope);
      assert.equal(renewed.identity.identityId, next.identity.identityId);
      assert.notEqual(renewed.credential, next.credential);
      const foreign = await f.makeRoom();
      const outsider = await f.create(foreign.scope);
      await assert.rejects(f.service.transferHost(next.credential, scope, outsider.identity.identityId, 2), code("identity_not_active"));
    });

    await t.test("administrator recovery preserves legacy private-note identity and is single-use", async () => {
      const { scope, legacy } = await f.makeRoom(true);
      await f.storage.upsertRoomNote({ roomId: scope.roomId, scope: "private", ownerParticipantId: legacy, content: "Owner's existing note" });
      const recovery = await f.issueRecovery(scope, legacy, "owner");
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.redeemRecovery(recovery.credential, scope)));
      const winners = attempts.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof f.service.redeemRecovery>>> => item.status === "fulfilled");
      assert.equal(winners.length, 1);
      const recovered = winners[0].value;
      assert.equal(recovered.identity.participantId, legacy);
      assert.equal((await f.service.resolveCredential(recovered.credential, scope))?.isOwner, true);
      assert.equal((await f.service.resolveCredential(recovered.credential, scope))?.role, "host");
      assert.equal((await f.storage.getRoomNote(scope.roomId, "private", recovered.identity.participantId))?.content, "Owner's existing note");
      const epoch = recovered.identity.authEpoch;
      await assert.rejects(f.service.redeemRecovery(recovery.credential, scope), code("recovery_invalid"));
      assert.equal((await f.ids.get(scope, recovered.identity.identityId))?.authEpoch, epoch);
      assert.ok(await f.service.resolveCredential(recovered.credential, scope));
      if (f.pool) {
        const rows = await f.pool.query(`select secret_hash,consumed_at from room_identity_recoveries_v2 where room_id=$1`, [scope.roomId]);
        assert.match(rows.rows[0].secret_hash, /^[a-f0-9]{64}$/);
        assert.ok(rows.rows[0].consumed_at);
        assert.ok(!JSON.stringify(rows.rows).includes(recovery.credential));
      }
    });

    await t.test("recovery checks expiry, scope, credential hash and current legacy binding before any mutation", async () => {
      const { scope, legacy } = await f.makeRoom();
      const recovery = await f.issueRecovery(scope, legacy);
      const other = await f.makeRoom();
      await assert.rejects(f.service.redeemRecovery(recovery.credential, other.scope), code("recovery_invalid"));
      await assert.rejects(f.service.redeemRecovery(recovery.credential, { ...scope, tenantId: "other" }), code("room_not_found"));
      const altered = recovery.credential.slice(0, -2) + (recovery.credential.at(-2) === "A" ? "B" : "A") + recovery.credential.at(-1);
      await assert.rejects(f.service.redeemRecovery(altered, scope), code("recovery_invalid"));
      await assert.rejects(f.storage.updateRoom(scope.roomId, { sessionControl: { hostParticipantId: "replacement-host" } }), /room_identity_lifecycle_requires_v2/);
      f.advance(60_000);
      await assert.rejects(f.service.redeemRecovery(recovery.credential, scope), code("recovery_invalid"));
      assert.equal((await f.ids.authority(scope))?.revision, 0);
      assert.equal((await f.ids.authority(scope))?.hostIdentityId, null);
    });

    await t.test("renewed recovery invalidates old proofs; reuse cannot revoke the winner", async () => {
      const { scope } = await f.makeRoom();
      const host = await f.create(scope, "host");
      await f.service.claimHost(host.credential, scope, 0);
      const a = await f.issueRecovery(scope, host.identity.participantId);
      const b = await f.issueRecovery(scope, host.identity.participantId);
      const fresh = await f.service.redeemRecovery(a.credential, scope);
      assert.equal(fresh.identity.identityId, host.identity.identityId);
      assert.equal(fresh.identity.authEpoch, host.identity.authEpoch + 1);
      assert.equal(await f.service.resolveCredential(host.credential, scope), null);
      await assert.rejects(f.service.renewCredential(host.credential, scope), code("identity_not_active"));
      await assert.rejects(f.service.redeemRecovery(b.credential, scope), code("recovery_invalid"));
      await assert.rejects(f.service.redeemRecovery(a.credential, scope), code("recovery_invalid"));
      assert.equal((await f.ids.authority(scope))?.revision, 2);
      assert.equal((await f.service.resolveCredential(fresh.credential, scope))?.role, "host");
    });

    await t.test("role transfer and recovery cannot resurrect a former host", async () => {
      const { scope } = await f.makeRoom();
      const host = await f.create(scope, "host"), next = await f.create(scope);
      await f.service.claimHost(host.credential, scope, 0);
      const recovery = await f.issueRecovery(scope, host.identity.participantId);
      const results = await Promise.allSettled([f.service.transferHost(host.credential, scope, next.identity.identityId, 1), f.service.redeemRecovery(recovery.credential, scope)]);
      assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
      const authority = await f.ids.authority(scope);
      assert.equal(authority?.revision, 2);
      assert.equal(authority?.hostIdentityId, results[0].status === "fulfilled" ? next.identity.identityId : host.identity.identityId);
    });

    await t.test("a concurrent revoke never leaves a revoked identity as host", async () => {
      const { scope } = await f.makeRoom();
      const host = await f.create(scope, "host"), target = await f.create(scope);
      await f.service.claimHost(host.credential, scope, 0);
      await Promise.allSettled([f.service.transferHost(host.credential, scope, target.identity.identityId, 1), f.ids.revoke(scope, target.identity.identityId, 1)]);
      const authority = await f.ids.authority(scope);
      assert.notEqual(authority?.hostIdentityId, target.identity.identityId);
      assert.equal(await f.service.resolveCredential(target.credential, scope), null);
    });

    await t.test("legacy lifecycle edits cannot resurrect authority; metadata and temporary disable stay available", async () => {
      const { scope, legacy } = await f.makeRoom();
      const host = await f.create(scope, "host");
      await f.service.claimHost(host.credential, scope, 0);
      await f.storage.updateRoom(scope.roomId, { status: "disabled" });
      assert.equal(await f.service.resolveCredential(host.credential, scope), null);
      await f.storage.updateRoom(scope.roomId, { status: "active", name: "Renamed", features: { voice: false, spatialAudio: false, screenShare: false } });
      assert.equal((await f.service.resolveCredential(host.credential, scope))?.role, "host");
      for (const patch of [{ sessionControl: { endedAt: new Date(f.now()).toISOString() } },
        { sessionControl: { removedParticipants: { [host.identity.participantId]: { removedAt: new Date(f.now()).toISOString() } } } },
        { ownerParticipantId: "replacement-owner" }, { roomType: "personal" as const, ownerParticipantId: legacy }]) {
        await assert.rejects(f.storage.updateRoom(scope.roomId, patch), /room_identity_lifecycle_requires_v2/);
      }
      await f.issueRecovery(scope, host.identity.participantId);
      await f.storage.createTenant({ tenantId: "other-tenant", name: "Other" });
      await assert.rejects(f.storage.updateRoom(scope.roomId, { tenantId: "other-tenant" }));
      await assert.rejects(f.storage.createRoom({ roomId: scope.roomId, tenantId: "other-tenant", templateId: "meeting-room-basic", name: "Duplicate ID must not replace the parent" }));
      assert.equal(await f.ids.get({ ...scope, tenantId: "other-tenant" }, host.identity.identityId), null);
      assert.equal(await f.storage.deleteRoom(scope.roomId), true);
      assert.equal(await f.ids.get(scope, host.identity.identityId), null);
      assert.equal(await f.ids.authority(scope), null);
      if (f.pool) for (const table of ["room_identities_v2", "room_identity_authority_v2", "room_identity_recoveries_v2"]) {
        assert.equal((await f.pool.query(`select 1 from ${table} where room_id=$1`, [scope.roomId])).rowCount, 0);
      }
    });

    await t.test("an ended room is not admitted and historical host invites cannot reclaim after transfer/revoke", async () => {
      const ended = await f.makeRoom();
      await f.storage.updateRoom(ended.scope.roomId, { sessionControl: { endedAt: new Date(f.now()).toISOString() } });
      await assert.rejects(f.create(ended.scope, "host"), code("room_blocked"));
      const { scope, legacy } = await f.makeRoom();
      const guest = await f.create(scope, "guest"), host = await f.create(scope, "host"), target = await f.create(scope);
      await f.ids.revoke(scope, guest.identity.identityId, 1);
      assert.equal((await f.ids.authority(scope))?.revision, 0);
      await f.service.claimHost(host.credential, scope, 0);
      await f.service.transferHost(host.credential, scope, target.identity.identityId, 1);
      await f.ids.revoke(scope, target.identity.identityId, 1);
      await assert.rejects(f.service.claimHost(host.credential, scope, 3), code("authority_conflict"));
      await assert.rejects(f.issueRecovery(scope, legacy), code("identity_forbidden"));
      assert.equal((await f.ids.authority(scope))?.hostIdentityId, null);
    });

    await t.test("explicit revocation remains terminal even for a formerly recovered owner", async () => {
      const { scope, legacy } = await f.makeRoom(true);
      const recovery = await f.issueRecovery(scope, legacy, "owner");
      const owner = await f.service.redeemRecovery(recovery.credential, scope);
      await f.ids.revoke(scope, owner.identity.identityId, owner.identity.authEpoch);
      assert.equal(await f.service.resolveCredential(owner.credential, scope), null);
      await assert.rejects(f.service.redeemRecovery(recovery.credential, scope), code("recovery_invalid"));
      await assert.rejects(f.issueRecovery(scope, legacy, "owner"), code("identity_forbidden"));
      assert.equal((await f.ids.authority(scope))?.ownerIdentityId, null);
    });

    if (f.pool) await t.test("Postgres restart, immutable bindings, FK and rollback on consumption failure", async () => {
      const { scope } = await f.makeRoom();
      const host = await f.create(scope, "host");
      await f.service.claimHost(host.credential, scope, 0);
      const recovery = await f.issueRecovery(scope, host.identity.participantId);
      const restarted = new PostgresStorage(f.pool!, f.now);
      await restarted.init();
      assert.deepEqual(await restarted.roomIdentities.get(scope, host.identity.identityId), host.identity);
      await assert.rejects(f.pool!.query(`update room_identities_v2 set participant_id='other' where room_id=$1`, [scope.roomId]), /immutable_room_identity/);
      await assert.rejects(f.pool!.query(`update room_identities_v2 set provenance='{"kind":"personal-owner"}' where room_id=$1`, [scope.roomId]), /immutable_room_identity/);
      await assert.rejects(f.pool!.query(`update room_identity_authority_v2 set host_identity_id='nonexistent' where room_id=$1`, [scope.roomId]));
      await f.pool!.query(`alter table room_identity_recoveries_v2 add constraint test_reject_redeem check (room_id <> '${scope.roomId}' or consumed_at is null)`);
      await assert.rejects(f.service.redeemRecovery(recovery.credential, scope));
      assert.equal((await f.ids.get(scope, host.identity.identityId))?.authEpoch, 1);
      assert.equal((await f.ids.authority(scope))?.revision, 1);
      await f.pool!.query(`alter table room_identity_recoveries_v2 drop constraint test_reject_redeem`);
      const restored = await f.service.redeemRecovery(recovery.credential, scope);
      assert.equal(restored.identity.authEpoch, 2);
      await assert.rejects(f.pool!.query(`update room_identity_recoveries_v2 set consumed_at=null where room_id=$1`, [scope.roomId]), /immutable_identity_recovery/);
      await assert.rejects(f.pool!.query(`update room_identity_authority_v2 set revision=0 where room_id=$1`, [scope.roomId]), /nonmonotonic_identity_authority/);
      await assert.rejects(f.pool!.query(`delete from room_identity_authority_v2 where room_id=$1`, [scope.roomId]), /identity_namespace_requires_room_delete/);
      await assert.rejects(f.pool!.query(`delete from room_identities_v2 where room_id=$1`, [scope.roomId]), /identity_namespace_requires_room_delete/);
      const codec = createRoomIdentityCodec(secret);
      assert.ok(codec.verify(restored.credential, scope, Math.floor(f.now() / 1000)));
    });

    if (f.pool) await t.test("Postgres legacy writes queued behind first v2 admission cannot cross its boundary", async () => {
      const { scope } = await f.makeRoom();
      // Exercise canonicalisation of a genuinely old, sparse lifecycle JSON.
      await f.pool!.query(`update rooms set session_control='{}'::jsonb where room_id=$1`, [scope.roomId]);
      const holder = await f.pool!.connect();
      let creation: ReturnType<typeof f.create> | undefined;
      let staleWrite: Promise<unknown> | undefined;
      const wait = async (predicate: () => Promise<boolean>) => {
        for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(25); }
        assert.fail("expected database lock was not observed");
      };
      try {
        await holder.query("begin");
        await holder.query("lock table room_identity_authority_v2 in access exclusive mode");
        creation = f.create(scope);
        void creation.catch(() => undefined);
        let admissionPid: number | undefined;
        await wait(async () => {
          const rows = (await f.pool!.query(`select pid from pg_locks where relation='room_identity_authority_v2'::regclass and not granted and mode='AccessShareLock'`)).rows;
          admissionPid = rows[0]?.pid;
          return Boolean(admissionPid);
        });
        staleWrite = f.storage.updateRoom(scope.roomId, { ownerParticipantId: "stale-owner" }).then(() => null, error => error);
        await wait(async () => (await f.pool!.query(`select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked`, [admissionPid])).rows[0].blocked);
        await holder.query("commit");
        await creation;
        const failure = await staleWrite;
        assert.ok(failure instanceof Error && failure.message === "room_identity_lifecycle_requires_v2");
        assert.equal((await f.storage.updateRoom(scope.roomId, { name: "Safe metadata patch" }))?.name, "Safe metadata patch");
      } finally {
        await holder.query("rollback");
        await Promise.allSettled([creation, staleWrite].filter(Boolean));
        holder.release();
      }
    });

    if (f.pool) await t.test("Postgres init rejects weakened constraints and function metadata instead of repairing silently", async () => {
      const restart = new PostgresStorage(f.pool!, f.now);
      await f.pool!.query("alter table room_identity_recoveries_v2 drop constraint recovery_v2_lifetime");
      await assert.rejects(restart.init(), /room_identity_schema_mismatch/);
      await f.pool!.query(`alter table room_identity_recoveries_v2 add constraint recovery_v2_lifetime check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')`);
      await f.pool!.query("alter function vrata_identity_v2_immutable() security definer");
      await assert.rejects(restart.init(), /room_identity_guard_mismatch/);
      await f.pool!.query("alter function vrata_identity_v2_immutable() security invoker");
      await f.pool!.query("alter table room_identities_v2 alter column auth_epoch drop not null");
      await assert.rejects(restart.init(), /room_identity_schema_mismatch/);
      await f.pool!.query("alter table room_identities_v2 alter column auth_epoch set not null");
      await restart.init();
    });

    if (f.pool) await t.test("the pinned legacy rollback can read/rename a bound room but cannot mutate its authority", {
      skip: !process.env.VRATA_TEMPLATE_ROLLBACK_STORAGE_MODULE && !process.env.CI
    }, async () => {
      const modulePath = process.env.VRATA_TEMPLATE_ROLLBACK_STORAGE_MODULE;
      assert.ok(modulePath, "CI requires the pinned rollback build");
      const legacyModule = await import(pathToFileURL(modulePath).href);
      const legacy = new legacyModule.PostgresStorage(f.pool!);
      const { scope } = await f.makeRoom();
      const identity = await f.create(scope, "host");
      await f.service.claimHost(identity.credential, scope, 0);
      await legacy.init();
      assert.equal((await legacy.updateRoom(scope.roomId, { name: "Legacy rename" })).name, "Legacy rename");
      await assert.rejects(legacy.updateRoom(scope.roomId, { sessionControl: { hostParticipantId: "forged-legacy-host" } }), /room_identity_lifecycle_requires_v2/);
      assert.equal((await f.service.resolveCredential(identity.credential, scope))?.role, "host");
      assert.equal((await f.ids.authority(scope))?.revision, 1);
    });
  });
}
