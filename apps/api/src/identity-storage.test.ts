import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { MemoryStorage, PostgresStorage, type Storage } from "./storage.js";
import { createRoomIdentityService } from "./identity/service.js";
import { IdentityStorageError, type RoomIdentityScope, type RoomIdentityProof } from "./identity/contracts.js";
import { MAX_ROOM_IDENTITIES } from "./identity/admission-limits.js";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const secret = "test-only-identity-root-secret-32-bytes-minimum";
const admin = { actorType: "admin-token", actorId: "verified-platform-admin", role: "admin" } as const;
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
  // Schema setup takes several seconds on CI; align the injected clock before
  // issuing a short-lived invitation with real HTTP/storage issuance checks.
  time = Math.max(time, Date.now());
  const ids = storage.roomIdentities;
  const service = createRoomIdentityService(ids, secret, now);
  const makeRoom = async (personal = false, legacyId?: string, legacyHost = true) => {
    const roomId = randomUUID();
    const legacy = legacyId ?? `legacy-${randomUUID()}`;
    const room = await storage.createRoom({ roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Identity contracts",
      roomType: personal ? "personal" : "standard", ownerParticipantId: personal ? legacy : null,
      sessionControl: { hostParticipantId: legacyHost ? legacy : null } });
    return { scope: { roomId, tenantId: room.tenantId }, legacy };
  };
  const create = async (scope: RoomIdentityScope, role: "guest" | "member" | "host" = "member") => {
    // Internal fixture seeding only: public issuance uses the locked admit or
    // one-time recovery paths and never accepts caller-supplied provenance.
    const identity = await ids.create({ ...scope, displayName: "Identity fixture", baseRole: role === "guest" ? "guest" : "member",
      provenance: role === "guest" ? { kind: "guest" } : { kind: "invite", inviteId: "server-validated-invite", role } });
    return { identity, credential: createRoomIdentityCodec(secret).sign(identity, { nowSeconds: Math.floor(now() / 1000) }) };
  };
  const issueRecovery = (scope: RoomIdentityScope, participantId: string, role: "host" | "owner" = "host") => service.issueRecovery({
    ...scope, issuer: admin, targetRole: role, targetParticipantId: participantId, expiresAt: new Date(now() + 60_000).toISOString()
  });
  const issueV2Invite = (scope: RoomIdentityScope, role: "guest" | "member" | "presenter" | "host",
    input: { waitingRoomEnabled?: boolean; expiresInMs?: number } = {}) => storage.createRoomInviteV2({
    roomId: scope.roomId, tokenHash: randomBytes(32).toString("base64url"), role,
    waitingRoomEnabled: input.waitingRoomEnabled ?? false,
    expiresAt: new Date(now() + (input.expiresInMs ?? 60_000)).toISOString(), actor: admin
  });
  const mutationProof = (identity: RoomIdentityProof) => ({ ...identity, expiresAtSeconds: Math.floor(now() / 1000) + 900 });
  return { storage, ids, service, pool, now, mutationProof, advance: (ms: number) => { time += ms; }, makeRoom, create, issueRecovery, issueV2Invite };
}

for (const backend of ["memory", "postgres"] as const) {
  test(`${backend}: identity admission budgets serialize concurrent peers and expire without touching credentials`, {
    skip: backend === "postgres" && !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000
  }, async t => {
    const f = await fixture(t, backend);
    const input = { originHash: "a".repeat(64), kind: "room" as const };
    for (let i = 0; i < 175; i++) assert.equal(await f.storage.reserveIdentityAdmission(input), true);
    const contenders = await Promise.all(Array.from({ length: 16 }, () => f.storage.reserveIdentityAdmission(input)));
    assert.equal(contenders.filter(Boolean).length, 5, "two replicas cannot exceed the same origin window");
    assert.equal(await f.storage.reserveIdentityAdmission({ originHash: "b".repeat(64), kind: "room" }), true);
    f.advance(60_000);
    assert.equal(await f.storage.reserveIdentityAdmission(input), true);
    if (f.pool) {
      const otherReplica = new PostgresStorage(f.pool, f.now);
      const result = await otherReplica.reserveIdentityAdmission(input);
      assert.equal(result, true);
      const buckets = (await f.pool.query("select origin_hash,attempts from room_identity_admission_buckets_v2 where origin_hash=$1", [input.originHash])).rows;
      assert.equal(buckets.length, 3, "closed minute, fresh minute and daily bucket are persisted");
      assert.equal(buckets.some((value: { attempts: number }) => value.attempts > 180 && value.attempts < 3000), true);
      assert.equal(buckets.every((value: { origin_hash: string }) => value.origin_hash === input.originHash), true);
    }
    const nextDay = Math.floor(f.now() / 86_400_000) * 86_400_000 + 86_400_000 + 60_000;
    f.advance(nextDay - f.now());
    for (let hour = 0; hour < 5; hour++) {
      for (let i = 0; i < 20; i++) assert.equal(await f.storage.reserveIdentityAdmission({ originHash: input.originHash, kind: "personal" }), true);
      assert.equal(await f.storage.reserveIdentityAdmission({ originHash: input.originHash, kind: "personal" }), false);
      f.advance(3_600_000);
    }
    assert.equal(await f.storage.reserveIdentityAdmission({ originHash: input.originHash, kind: "personal" }), false,
      "a new hourly bucket cannot exceed the daily personal room allowance");
    f.advance(86_400_000 - (f.now() % 86_400_000) + 60_000);
    assert.equal(await f.storage.reserveIdentityAdmission({ originHash: input.originHash, kind: "personal" }), true);
  });

  if (backend === "postgres") test("postgres: room identity lifetime capacity blocks only new admissions", {
    skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000
  }, async t => {
    const f = await fixture(t, "postgres");
    const { scope } = await f.makeRoom(false, undefined, false);
    await f.storage.identityProtocol.raise(2);
    const first = await f.service.admit({ ...scope, displayName: "First" });
    await f.pool!.query(`insert into room_identities_v2
      (tenant_id,room_id,identity_id,participant_id,display_name,base_role,provenance,auth_epoch,created_at)
      select $1,$2,'capacity-id-'||n,'capacity-participant-'||n,'Guest','guest','{"kind":"guest"}'::jsonb,1,now()
      from generate_series(2,$3) as n`, [scope.tenantId, scope.roomId, MAX_ROOM_IDENTITIES]);
    await assert.rejects(f.service.admit({ ...scope, displayName: "Overflow" }), code("identity_capacity_reached"));
    const renewed = await f.service.renewCredential(first.credential, scope);
    assert.equal(renewed.identity.participantId, first.identity.participantId);
  });

  test(`${backend}: protocol floor is global, monotonic and freezes unbound legacy lifecycle`, {
    skip: backend === "postgres" && !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000
  }, async t => {
    const f = await fixture(t, backend);
    const { scope } = await f.makeRoom();
    await f.storage.upsertRoomNote({ roomId: scope.roomId, scope: "shared", content: "Keep room materials" });
    assert.equal(await f.storage.identityProtocol.minimum(), 1);
    assert.equal(await f.storage.identityProtocol.mediaNamespace(), null);
    assert.equal(await f.storage.hasRoomIdentityAuthority(scope.roomId), false);
    if (f.pool) await assert.rejects(f.pool.query("update room_identity_protocol_policy set minimum_protocol=2"), /identity_protocol_boundary_not_installed/);
    assert.equal(await f.storage.identityProtocol.raise(2), 2);
    const mediaNamespace = await f.storage.identityProtocol.mediaNamespace();
    assert.match(mediaNamespace!, /^[a-f0-9]{32}$/);
    assert.equal(await f.storage.identityProtocol.raise(2), 2);
    assert.equal(await f.storage.identityProtocol.mediaNamespace(), mediaNamespace);
    await assert.rejects(f.storage.identityProtocol.raise(1), /identity_protocol_downgrade_forbidden/);
    await assert.rejects(f.storage.updateRoom(scope.roomId, { sessionControl: { hostParticipantId: "spoofed-after-rollback" } }), /room_identity_lifecycle_requires_v2/);
    await assert.rejects(f.storage.createRoom({ roomId: scope.roomId, tenantId: scope.tenantId, templateId: "meeting-room-basic", ownerParticipantId: "replacement" }));
    assert.equal((await f.storage.updateRoom(scope.roomId, { name: "Administrator metadata" }))?.name, "Administrator metadata");
    assert.equal((await f.storage.getRoomNote(scope.roomId, "shared"))?.content, "Keep room materials");
    if (f.pool) {
      await assert.rejects(f.pool.query("update room_identity_protocol_policy set minimum_protocol=1"), /identity_protocol_downgrade_forbidden/);
      await assert.rejects(f.pool.query("delete from room_identity_protocol_policy"), /identity_protocol_downgrade_forbidden/);
      await assert.rejects(f.pool.query("truncate room_identity_protocol_policy"), /identity_protocol_downgrade_forbidden/);
      await assert.rejects(f.pool.query("update room_identity_protocol_policy set media_namespace=$1", ["b".repeat(32)]), /identity_protocol_namespace_immutable/);
      const restarted = new PostgresStorage(f.pool, f.now);
      await restarted.init();
      assert.equal(await restarted.identityProtocol.minimum(), 2);
      assert.equal(await restarted.identityProtocol.mediaNamespace(), mediaNamespace);
    }
  });

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
      await assert.rejects(f.ids.claimHost(f.mutationProof(identity), 0), code("identity_forbidden"));
      assert.deepEqual((await f.ids.get(scope, identity.identityId))?.provenance, { kind: "guest" });
      assert.equal(await f.ids.get({ ...scope, tenantId: "other" }, identity.identityId), null);
      assert.equal(await f.ids.get({ ...scope, roomId: "missing" }, identity.identityId), null);
      assert.equal(await f.ids.authority({ ...scope, roomId: "missing" }), null);
      assert.equal(await f.ids.resolve({ ...identity, participantId: legacy }), null);
      assert.equal(await f.ids.resolve({ ...identity, authEpoch: 2 }), null);
      await assert.rejects(f.ids.create({ ...scope, displayName: "Owner without proof", baseRole: "member", provenance: { kind: "personal-owner" } }), code("identity_forbidden"));
    });

    await t.test("admission ignores public participant IDs and checks invite, role and initial Host atomically", async () => {
      const f = await fixture(t, backend);
      await assert.rejects(f.service.admit({ tenantId: "demo-tenant", roomId: "demo-room", displayName: "Too soon" }), code("identity_forbidden"));
      await f.storage.identityProtocol.raise(2);
      const { scope, legacy } = await f.makeRoom(false, undefined, false);
      await assert.rejects(f.storage.createRoomInvite({ roomId: scope.roomId,
        tokenHash: randomBytes(32).toString("base64url"), role: "host", protocolVersion: 2,
        waitingRoomEnabled: false, expiresAt: new Date(f.now() + 60_000).toISOString() }), code("identity_forbidden"));
      const invited = await f.issueV2Invite(scope, "host");
      const forgedIdentityId = randomUUID();
      const spoofed = { ...scope, displayName: "Untrusted", inviteTokenHash: invited.tokenHash, participantId: legacy,
        identityId: forgedIdentityId, baseRole: "host", provenance: { kind: "personal-owner" } } as Parameters<typeof f.service.admit>[0];
      const [one, two] = await Promise.all([f.service.admit(spoofed), f.service.admit(spoofed)]);
      assert.notEqual(one.identity.participantId, legacy);
      assert.notEqual(one.identity.identityId, forgedIdentityId);
      assert.notEqual(one.identity.participantId, two.identity.participantId);
      assert.deepEqual(one.identity.provenance, { kind: "invite", inviteId: invited.inviteId, role: "host" });
      assert.deepEqual(two.identity.provenance, { kind: "invite", inviteId: invited.inviteId, role: "host" });
      assert.equal((await f.ids.authority(scope))?.revision, 1);
      const authority = await f.ids.authority(scope);
      assert.equal([one, two].filter(item => item.identity.identityId === authority?.hostIdentityId).length, 1);
      const currentHost = [one, two].find(item => item.identity.identityId === authority?.hostIdentityId)!;
      const other = currentHost === one ? two : one;
      assert.equal((await f.service.resolveCredential(currentHost.credential, scope))?.role, "host");
      assert.equal((await f.service.resolveCredential(other.credential, scope))?.role, "member");
      await f.ids.transition(scope, { actorType: "room-session", proof: currentHost.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 }, 1,
        { type: "transfer-host", targetParticipantId: other.identity.participantId });
      assert.equal((await f.service.resolveCredential(other.credential, scope))?.role, "host");
      const late = await f.service.admit(spoofed);
      assert.equal((await f.service.resolveCredential(late.credential, scope))?.role, "member");
      assert.equal((await f.ids.authority(scope))?.revision, 2);
    });

    await t.test("admission fails for foreign, revoked, expired, waiting-room and admin invitations", async () => {
      const f = await fixture(t, backend);
      await assert.rejects(f.service.beginWaiting({ tenantId: "demo-tenant", roomId: "demo-room", inviteTokenHash: "unavailable", displayName: "Too soon",
        expiresAt: new Date(f.now() + 60_000).toISOString() }), code("identity_forbidden"));
      await f.storage.identityProtocol.raise(2);
      const { scope } = await f.makeRoom();
      const other = await f.makeRoom(true);
      const old = await f.storage.createRoomInvite({ roomId: scope.roomId, tokenHash: `legacy-${randomUUID()}`,
        role: "host", waitingRoomEnabled: false, expiresAt: new Date(f.now() + 60_000).toISOString() });
      assert.equal(old.protocolVersion, 1);
      old.protocolVersion = 2;
      old.role = "guest";
      assert.equal((await f.storage.getRoomInvite(old.inviteId))?.protocolVersion, 1);
      await assert.rejects(f.service.admit({ ...scope, displayName: "Old Host invite", inviteTokenHash: old.tokenHash }), code("identity_forbidden"));
      await assert.rejects(f.storage.createRoomInviteV2({ roomId: scope.roomId,
        tokenHash: randomBytes(32).toString("base64url"), role: "admin", waitingRoomEnabled: false,
        expiresAt: new Date(f.now() + 60_000).toISOString(), actor: admin }), code("invalid_identity_input"));
      for (const [role, pending, revoked, expired] of [
        ["guest", false, true, false], ["host", true, false, false], ["member", false, false, true]
      ] as const) {
        const invite = await f.issueV2Invite(scope, role, { waitingRoomEnabled: pending,
          expiresInMs: expired ? 1000 : 60_000 });
        if (revoked) await f.storage.revokeRoomInvite(scope.roomId, invite.inviteId, new Date(f.now()).toISOString());
        if (expired) f.advance(2_000);
        await assert.rejects(f.service.admit({ ...scope, displayName: "No proof", inviteTokenHash: invite.tokenHash }),
          code(pending ? "waiting_room_pending" : "identity_forbidden"));
        await assert.rejects(f.service.admit({ ...other.scope, displayName: "Foreign", inviteTokenHash: invite.tokenHash }), code("identity_forbidden"));
      }
      await assert.rejects(f.service.admit({ ...other.scope, displayName: "Known legacy owner", participantId: other.legacy } as Parameters<typeof f.service.admit>[0]), code("identity_forbidden"));
      const guest = await f.service.admit({ ...scope, displayName: "Public guest", participantId: "legacy-host" } as Parameters<typeof f.service.admit>[0]);
      assert.notEqual(guest.identity.participantId, "legacy-host");
      assert.equal((await f.service.resolveCredential(guest.credential, scope))?.role, "guest");
      assert.equal((await f.ids.authority(scope))?.revision, 0);
      const personalHostInvite = await f.issueV2Invite(other.scope, "host");
      const personalMember = await f.service.admit({ ...other.scope, displayName: "Invited", inviteTokenHash: personalHostInvite.tokenHash });
      assert.equal((await f.service.resolveCredential(personalMember.credential, other.scope))?.role, "member");
      assert.equal((await f.ids.authority(other.scope))?.hostIdentityId, null);
      const presentation = await f.issueV2Invite(scope, "presenter");
      const presenterCandidate = await f.service.admit({ ...scope, displayName: "Presenter candidate", inviteTokenHash: presentation.tokenHash });
      assert.equal((await f.service.resolveCredential(presenterCandidate.credential, scope))?.role, "member", "presenter privileges require an explicit Host transition");
      assert.equal((await f.ids.authority(scope))?.revision, 0);
    });

    await t.test("waiting proof creates only pending admission and exactly one approved redemption", async () => {
      const f = await fixture(t, backend);
      await f.storage.identityProtocol.raise(2);
      const { scope } = await f.makeRoom(false, undefined, false);
      const foreign = await f.makeRoom(false, undefined, false);
      const invite = await f.issueV2Invite(scope, "host", { waitingRoomEnabled: true });
      const pending = await f.service.beginWaiting({ ...scope, inviteTokenHash: invite.tokenHash, displayName: "Waiting Host",
        expiresAt: new Date(f.now() + 60_000).toISOString() });
      assert.equal(await f.service.resolveCredential(pending.credential, scope), null);
      assert.equal(await f.service.resolveSession(pending.credential, scope), null);
      assert.equal((await f.ids.authority(scope))?.revision, 0);
      const request = await f.storage.getWaitingRoomRequest(pending.requestId);
      assert.equal(request?.status, "pending");
      assert.equal(request?.roomId, scope.roomId);
      assert.notEqual(request?.participantId, scope.roomId);
      if (f.pool) await assert.rejects(f.pool.query("delete from room_identity_pending_v2 where pending_id=$1", [pending.credential.split(".")[1]]), /identity_namespace_requires_room_delete/);
      request!.status = "approved";
      await assert.rejects(f.service.redeemWaiting(pending.credential, scope), code("waiting_room_pending"), "a public request object is not approval");
      await assert.rejects(f.service.redeemWaiting(pending.credential, foreign.scope), code("waiting_proof_invalid"));
      await assert.rejects(f.service.redeemWaiting(pending.credential + "x", scope), code("waiting_proof_invalid"));
      const approved = await f.storage.updateWaitingRoomRequest(scope.roomId, pending.requestId,
        { status: "approved", decidedBy: "authorized-host", decidedAt: new Date(f.now()).toISOString() });
      assert.equal(approved?.status, "approved");
      await assert.rejects(f.storage.updateWaitingRoomRequest(scope.roomId, pending.requestId,
        { status: "rejected", decidedBy: "late-actor", decidedAt: new Date(f.now()).toISOString() }), /waiting_decision_finalized/);
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.redeemWaiting(pending.credential, scope)));
      const winners = attempts.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof f.service.redeemWaiting>>> => item.status === "fulfilled");
      assert.equal(winners.length, 1);
      const winner = winners[0].value;
      assert.equal(winner.identity.participantId, request?.participantId);
      assert.deepEqual(winner.identity.provenance, { kind: "waiting-room", inviteId: invite.inviteId, requestId: pending.requestId, role: "host" });
      assert.equal((await f.service.resolveCredential(winner.credential, scope))?.role, "host");
      assert.equal((await f.ids.authority(scope))?.revision, 1);
      await assert.rejects(f.service.redeemWaiting(pending.credential, scope), code("waiting_proof_invalid"));
      assert.equal((await f.ids.get(scope, winner.identity.identityId))?.authEpoch, 1);
      if (f.pool) {
        const record = (await f.pool.query("select activated_at,secret_hash from room_identity_pending_v2 where pending_id=$1", [pending.credential.split(".")[1]])).rows[0];
        assert.ok(record.activated_at);
        assert.notEqual(record.secret_hash, pending.credential);
        await assert.rejects(f.pool.query("update room_identity_pending_v2 set activated_at=null where pending_id=$1", [pending.credential.split(".")[1]]), /immutable_identity_pending/);
        assert.equal((await f.pool.query("delete from room_identity_pending_v2 where pending_id=$1", [pending.credential.split(".")[1]])).rowCount, 1);
        assert.equal((await f.ids.resolve(winner.identity))?.role, "host", "pending cleanup does not revoke the admitted identity");
        await assert.rejects(f.service.redeemWaiting(pending.credential, scope), code("waiting_proof_invalid"));
        const foreignRoom = await f.makeRoom(false, undefined, false);
        await assert.rejects(f.pool.query(`insert into room_identity_pending_v2
          (tenant_id,room_id,pending_id,invite_id,request_id,participant_id,display_name,secret_hash,created_at,expires_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,now(),now()+interval '1 minute')`,
        [foreignRoom.scope.tenantId, foreignRoom.scope.roomId, randomUUID(), invite.inviteId, pending.requestId,
          randomUUID(), "Cross-room", "a".repeat(64)]), /pending_v2_(invite|request)/);
      }
    });

    await t.test("waiting proof is invalidated by expiry, rejection and invite revocation", async () => {
      const f = await fixture(t, backend);
      await f.storage.identityProtocol.raise(2);
      const { scope } = await f.makeRoom(false, undefined, false);
      for (const outcome of ["expired", "rejected", "revoked"] as const) {
        const invite = await f.issueV2Invite(scope, "member", { waitingRoomEnabled: true, expiresInMs: 90_000 });
        const pending = await f.service.beginWaiting({ ...scope, inviteTokenHash: invite.tokenHash, displayName: outcome,
          expiresAt: new Date(f.now() + 30_000).toISOString() });
        await f.storage.updateWaitingRoomRequest(scope.roomId, pending.requestId,
          { status: outcome === "rejected" ? "rejected" : "approved", decidedBy: "authorized-host", decidedAt: new Date(f.now()).toISOString() });
        if (outcome === "expired") f.advance(31_000);
        if (outcome === "revoked") await f.storage.revokeRoomInvite(scope.roomId, invite.inviteId, new Date(f.now()).toISOString());
        await assert.rejects(f.service.redeemWaiting(pending.credential, scope), code(outcome === "rejected" ? "waiting_room_rejected" : "waiting_proof_invalid"));
      }
      assert.equal((await f.ids.authority(scope))?.revision, 0);
    });

    await t.test("two concurrent, conflicting waiting decisions have one final state", async () => {
      const f = await fixture(t, backend);
      await f.storage.identityProtocol.raise(2);
      const { scope } = await f.makeRoom(false, undefined, false);
      const invite = await f.issueV2Invite(scope, "member", { waitingRoomEnabled: true });
      const pending = await f.service.beginWaiting({ ...scope, inviteTokenHash: invite.tokenHash, displayName: "Decision race",
        expiresAt: new Date(f.now() + 60_000).toISOString() });
      const results = await Promise.allSettled(["approved", "rejected"].map(status => f.storage.updateWaitingRoomRequest(scope.roomId,
        pending.requestId, { status: status as "approved" | "rejected", decidedBy: "verified-host", decidedAt: new Date(f.now()).toISOString() })));
      assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
      const state = await f.storage.getWaitingRoomRequest(pending.requestId);
      const winner = results[0].status === "fulfilled" ? "approved" : "rejected";
      assert.equal(state?.status, winner);
      if (winner === "approved") {
        assert.equal((await f.service.redeemWaiting(pending.credential, scope)).identity.participantId, state?.participantId);
      } else await assert.rejects(f.service.redeemWaiting(pending.credential, scope), code("waiting_room_rejected"));
    });

    await t.test("pending waiting admissions are bounded per invite and expired slots can be reused", async () => {
      const f = await fixture(t, backend);
      await f.storage.identityProtocol.raise(2);
      const { scope } = await f.makeRoom(false, undefined, false);
      const invite = await f.issueV2Invite(scope, "member", { waitingRoomEnabled: true, expiresInMs: 90_000 });
      const enter = () => f.service.beginWaiting({ ...scope, inviteTokenHash: invite.tokenHash, displayName: "One of eight",
        expiresAt: new Date(f.now() + 30_000).toISOString() });
      const attempts = await Promise.all(Array.from({ length: 8 }, enter));
      assert.equal(new Set(attempts.map(item => item.requestId)).size, 8);
      await assert.rejects(enter(), code("waiting_room_capacity_reached"));
      assert.equal((await f.storage.listWaitingRoomRequests(scope.roomId)).length, 8);
      f.advance(31_000);
      const later = await enter();
      assert.ok(later.requestId);
      assert.equal((await f.storage.listWaitingRoomRequests(scope.roomId)).length, 9,
        "request metadata remains available for cleanup and audit until a bounded maintenance pass");
    });

    await t.test("fresh personal owner and its Host slot are created in one server-owned operation", async () => {
      const f = await fixture(t, backend);
      const input = { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: `Personal ${randomUUID()}`,
        displayName: "Real Owner", ownerParticipantId: "forged-public-owner", roomType: "standard",
        sessionControl: { hostParticipantId: "forged-host" }, guestAllowed: true, visibility: "public" } as Parameters<Storage["createPersonalOwnedRoom"]>[0];
      await assert.rejects(f.storage.createPersonalOwnedRoom(input), /identity_upgrade_required/);
      assert.equal((await f.storage.listRooms()).filter(room => room.name === input.name).length, 0);
      await f.storage.identityProtocol.raise(2);
      const { room, identity } = await f.storage.createPersonalOwnedRoom(input);
      const scope = { tenantId: room.tenantId, roomId: room.roomId };
      assert.notEqual(room.ownerParticipantId, "forged-public-owner");
      assert.notEqual(room.ownerParticipantId, "forged-host");
      assert.equal(room.ownerParticipantId, identity.participantId);
      assert.equal(room.roomType, "personal");
      assert.equal(room.visibility, "private");
      assert.equal(room.guestAllowed, false);
      assert.equal(room.sessionControl?.hostParticipantId, identity.participantId);
      assert.deepEqual(identity.provenance, { kind: "personal-owner" });
      assert.equal((await f.ids.resolve(identity))?.role, "host");
      assert.equal((await f.ids.resolve(identity))?.isOwner, true);
      const authority = await f.ids.authority(scope);
      assert.equal(authority?.revision, 1);
      assert.equal(authority?.ownerIdentityId, identity.identityId);
      assert.equal(authority?.hostIdentityId, identity.identityId);
      await assert.rejects(f.service.admit({ ...scope, displayName: "Owner ID is public", participantId: identity.participantId } as Parameters<typeof f.service.admit>[0]), code("identity_forbidden"));
      const credential = createRoomIdentityCodec(secret).sign(identity, { nowSeconds: Math.floor(f.now() / 1000) });
      assert.equal((await f.service.issueSession(credential, scope)).role, "host");
      if (f.pool) {
        const restarted = new PostgresStorage(f.pool, f.now);
        await restarted.init();
        assert.equal((await restarted.roomIdentities.resolve(identity))?.isOwner, true);
      }
    });

    if (f.pool) await t.test("personal bootstrap rolls room and owner back together if authority cannot be written", async () => {
      const f = await fixture(t, backend);
      await f.storage.identityProtocol.raise(2);
      const name = `Atomic owner ${randomUUID()}`;
      await f.pool!.query("alter table room_identity_authority_v2 add constraint test_reject_personal_owner check (owner_identity_id is null)");
      try {
        await assert.rejects(f.storage.createPersonalOwnedRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name,
          displayName: "Owner" }), /test_reject_personal_owner/);
        assert.equal((await f.storage.listRooms()).filter(room => room.name === name).length, 0);
        assert.equal((await f.pool!.query("select count(*)::integer as count from room_identities_v2 where provenance->>'kind'='personal-owner'")).rows[0].count, 0);
      } finally { await f.pool!.query("alter table room_identity_authority_v2 drop constraint test_reject_personal_owner"); }
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

    await t.test("v2 sessions resolve current authority and reject legacy laundering, replay and revoked epochs", async () => {
      const { scope } = await f.makeRoom();
      const host = await f.create(scope, "host");
      const next = await f.create(scope);
      await f.ids.claimHost(f.mutationProof(host.identity), 0);
      const first = await f.service.issueSession(host.credential, scope);
      assert.equal(first.role, "host");
      assert.equal((await f.service.resolveSession(first.sessionToken, scope))?.role, "host");
      assert.equal(await f.service.resolveSession(host.credential, scope), null);
      assert.equal(await f.service.resolveCredential(first.sessionToken, scope), null);
      const claims = createRoomSessionV2Codec(secret).verify(first.sessionToken, scope, Math.floor(f.now() / 1000));
      assert.ok(claims);
      assert.equal(Object.hasOwn(claims, "role"), false);
      assert.equal(Object.hasOwn(claims, "permissions"), false);
      assert.equal(await f.service.resolveSession(first.sessionToken, { ...scope, roomId: "other" }), null);
      await f.ids.transferHost(f.mutationProof(host.identity), next.identity.identityId, 1);
      assert.equal((await f.service.resolveSession(first.sessionToken, scope))?.role, "member");
      await assert.rejects(f.service.renewSession(first.sessionToken, next.credential, scope), code("identity_not_active"));
      await assert.rejects(f.service.renewSession(first.sessionToken, first.sessionToken, scope), code("identity_not_active"));
      const renewed = await f.service.renewSession(first.sessionToken, host.credential, scope);
      assert.equal(renewed.role, "member");
      assert.notEqual(renewed.sessionToken, first.sessionToken);
      const renewedClaims = createRoomSessionV2Codec(secret).verify(renewed.sessionToken, scope, Math.floor(f.now() / 1000));
      assert.equal(renewedClaims?.sessionId, claims.sessionId);
      await f.ids.revoke(scope, host.identity.identityId, 1);
      assert.equal(await f.service.resolveSession(first.sessionToken, scope), null);
      await assert.rejects(f.service.renewSession(renewed.sessionToken, host.credential, scope), code("identity_not_active"));
      const timebound = createRoomIdentityService(f.ids, secret, f.now, { identityLifetimeSeconds: 86_400, sessionLifetimeSeconds: 60 });
      const identity = await f.ids.create({ ...scope, displayName: "Guest", baseRole: "guest", provenance: { kind: "guest" } });
      const longLived = { identity, credential: createRoomIdentityCodec(secret).sign(identity,
        { nowSeconds: Math.floor(f.now() / 1000), lifetimeSeconds: 86_400 }) };
      const session = await timebound.issueSession(longLived.credential, scope);
      f.advance(61_000);
      assert.equal(await timebound.resolveSession(session.sessionToken, scope), null);
      assert.ok(await timebound.resolveCredential(longLived.credential, scope));
      assert.ok((await timebound.issueSession(longLived.credential, scope)).sessionToken);
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

    await t.test("lifecycle commands use current authority, preserve continuity and never revive a removed identity", async () => {
      const { scope } = await f.makeRoom();
      const host = await f.create(scope, "host");
      const member = await f.create(scope, "member");
      const guest = await f.create(scope, "guest");
      const hostActor = { actorType: "room-session", proof: host.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 } as const;
      const memberActor = { actorType: "room-session", proof: member.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 } as const;
      await f.ids.claimHost(f.mutationProof(host.identity), 0);
      const locked = await f.ids.transition(scope, hostActor, 1, { type: "lock" });
      assert.ok(locked.lifecycle.lockedAt);
      assert.equal(locked.lifecycle.lockedBy, host.identity.participantId);
      await assert.rejects(f.create(scope, "guest"), code("room_blocked"));
      assert.equal((await f.ids.resolve(member.identity))?.role, "member");
      await assert.rejects(f.ids.transition(scope, hostActor, 1, { type: "unlock" }), code("authority_conflict"));
      await assert.rejects(f.ids.transition(scope, memberActor, 2, { type: "unlock" }), code("identity_forbidden"));
      await f.ids.transition(scope, hostActor, 2, { type: "unlock" });
      assert.equal((await f.ids.authority(scope))?.lifecycle.lockedAt, null);
      await f.ids.transition(scope, hostActor, 3, { type: "grant-presenter", targetParticipantId: guest.identity.participantId });
      assert.equal((await f.service.resolveCredential(guest.credential, scope))?.role, "presenter");
      assert.ok((await f.ids.resolve(guest.identity))?.permissions.includes("document.upload"));
      await f.ids.transition(scope, hostActor, 4, { type: "revoke-presenter", targetParticipantId: guest.identity.participantId });
      assert.equal((await f.service.resolveCredential(guest.credential, scope))?.role, "guest");
      await f.ids.transition(scope, hostActor, 5, { type: "grant-presenter", targetParticipantId: member.identity.participantId });
      const transferred = await f.ids.transition(scope, hostActor, 6, { type: "transfer-host", targetParticipantId: member.identity.participantId });
      assert.equal(transferred.presenterIdentityId, null);
      assert.ok(transferred.lifecycle.presenterRevokedAt);
      await assert.rejects(f.ids.transition(scope, hostActor, 7, { type: "lock" }), code("identity_forbidden"));
      const removed = await f.ids.transition(scope, memberActor, 7, { type: "remove", targetParticipantId: guest.identity.participantId, reason: "  Removed by Host  " });
      assert.equal(removed.lifecycle.removedParticipants[guest.identity.participantId].reason, "Removed by Host");
      assert.equal((await f.ids.get(scope, guest.identity.identityId))?.authEpoch, 2);
      assert.equal(await f.service.resolveCredential(guest.credential, scope), null);
      await assert.rejects(f.ids.transition(scope, memberActor, 8, { type: "grant-presenter", targetParticipantId: guest.identity.participantId }), code("identity_not_active"));
      const ended = await f.ids.transition(scope, memberActor, 8, { type: "end" });
      assert.equal(ended.revision, 9);
      assert.ok(ended.lifecycle.endedAt);
      assert.equal(await f.ids.resolve(member.identity), null);
      await assert.rejects(f.create(scope), code("room_blocked"));
      await assert.rejects(f.ids.transition(scope, admin, 9, { type: "unlock" }), code("room_blocked"));
    });

    await t.test("legacy prototype-named identities recover normally and removal records survive serialization", async () => {
      for (const legacyId of ["constructor", "toString", "__proto__"]) {
        const { scope, legacy } = await f.makeRoom(false, legacyId);
        const recovery = await f.issueRecovery(scope, legacy, "host");
        const host = await f.service.redeemRecovery(recovery.credential, scope);
        assert.equal((await f.ids.resolve(host.identity))?.role, "host");
        const innocent = await f.create(scope);
        await f.ids.transition(scope, admin, 1, { type: "remove", targetParticipantId: legacy });
        const authority = await f.ids.authority(scope);
        assert.ok(Object.hasOwn(authority!.lifecycle.removedParticipants, legacy));
        assert.ok(Object.hasOwn(JSON.parse(JSON.stringify(authority!.lifecycle.removedParticipants)), legacy));
        assert.equal(Object.getPrototypeOf(authority!.lifecycle.removedParticipants), Object.prototype);
        assert.equal(await f.ids.resolve(host.identity), null);
        assert.equal((await f.ids.resolve(innocent.identity))?.role, "member");
      }
    });

    await t.test("administrator handoff cannot bind an unadmitted public owner ID", async () => {
      const handoff = await fixture(t, backend);
      const { scope, legacy } = await handoff.makeRoom(true, undefined, false);
      await handoff.storage.identityProtocol.raise(2);
      const invite = await handoff.issueV2Invite(scope, "member");
      const recipient = await handoff.service.admit({ ...scope, displayName: "Recipient", inviteTokenHash: invite.tokenHash });
      await assert.rejects(handoff.ids.transition(scope, admin, 0,
        { type: "transfer-owner", targetParticipantId: legacy }), code("identity_not_active"));
      const next = await handoff.ids.transition(scope, admin, 0,
        { type: "transfer-owner", targetParticipantId: recipient.identity.participantId });
      assert.equal(next.revision, 1);
      assert.equal(next.hostIdentityId, null, "Host and owner are distinct authority slots");
      assert.equal((await handoff.ids.resolve(recipient.identity))?.isOwner, true);
      assert.equal((await handoff.ids.resolve(recipient.identity))?.role, "member");
      await assert.rejects(handoff.ids.transition(scope, admin, 0,
        { type: "transfer-owner", targetParticipantId: legacy }), code("authority_conflict"));
      await assert.rejects(handoff.issueRecovery(scope, legacy, "owner"), code("identity_forbidden"));
      const revoked = await handoff.create(scope);
      await handoff.ids.revoke(scope, revoked.identity.identityId, 1);
      await assert.rejects(handoff.ids.transition(scope, admin, 1,
        { type: "transfer-owner", targetParticipantId: revoked.identity.participantId }), code("identity_not_active"));
      assert.equal((await handoff.ids.authority(scope))?.ownerIdentityId, recipient.identity.identityId);
      const locked = await handoff.ids.transition(scope, { actorType: "room-session", proof: recipient.identity, expiresAtSeconds: Math.floor(handoff.now() / 1000) + 600 }, 1, { type: "lock" });
      assert.ok(locked.lifecycle.lockedAt, "Member owner can control their personal room without becoming Host");
    });

    await t.test("owner transfer invalidates outstanding recovery and does not overwrite the Host slot", async () => {
      const { scope, legacy } = await f.makeRoom(true);
      const recovery = await f.issueRecovery(scope, legacy, "owner");
      const owner = await f.service.redeemRecovery(recovery.credential, scope);
      const next = await f.create(scope);
      const oldRecovery = await f.issueRecovery(scope, legacy, "owner");
      const updated = await f.ids.transition(scope, { actorType: "room-session", proof: owner.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 }, 1,
        { type: "transfer-owner", targetParticipantId: next.identity.participantId });
      assert.equal(updated.ownerIdentityId, next.identity.identityId);
      assert.equal(updated.hostIdentityId, owner.identity.identityId);
      assert.equal((await f.ids.resolve(owner.identity))?.isOwner, false);
      assert.equal((await f.ids.resolve(next.identity))?.isOwner, true);
      await assert.rejects(f.service.redeemRecovery(oldRecovery.credential, scope), code("recovery_invalid"));
      await assert.rejects(f.issueRecovery(scope, legacy, "owner"), code("identity_forbidden"));
      await assert.rejects(f.ids.transition(scope, { actorType: "room-session", proof: owner.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 }, 2,
        { type: "remove", targetParticipantId: next.identity.participantId }), code("identity_forbidden"));
      await assert.rejects(f.ids.transition(scope, admin, 2,
        { type: "remove", targetParticipantId: next.identity.participantId }), code("identity_forbidden"));
      await assert.rejects(f.ids.transition(scope, { actorType: "room-session", proof: owner.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 }, 2,
        { type: "end" }), code("identity_forbidden"), "the Host cannot permanently end the owner's personal room");
      const endedByOwner = await f.ids.transition(scope, { actorType: "room-session", proof: next.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 }, 2, { type: "end" });
      assert.ok(endedByOwner.lifecycle.endedAt);
    });

    await t.test("lifecycle failures and racing commands preserve the winner and require exact actor scope", async () => {
      const { scope } = await f.makeRoom();
      const host = await f.create(scope, "host");
      const next = await f.create(scope);
      await f.ids.claimHost(f.mutationProof(host.identity), 0);
      const actor = { actorType: "room-session", proof: host.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 } as const;
      await assert.rejects(f.ids.transition(scope, actor, 1, { type: "grant-presenter" } as Parameters<typeof f.ids.transition>[3]), code("invalid_identity_input"));
      await assert.rejects(f.ids.transition(scope, { ...actor, proof: { ...host.identity, tenantId: "foreign" } }, 1, { type: "lock" }), code("identity_not_active"));
      await assert.rejects(f.ids.transition(scope, actor, 1, { type: "remove", targetParticipantId: host.identity.participantId }), code("identity_forbidden"));
      assert.equal((await f.ids.authority(scope))?.revision, 1);
      const results = await Promise.allSettled([
        f.ids.transition(scope, actor, 1, { type: "lock" }),
        f.ids.transition(scope, actor, 1, { type: "transfer-host", targetParticipantId: next.identity.participantId })
      ]);
      assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
      const winner = await f.ids.authority(scope);
      assert.equal(winner?.revision, 2);
      assert.equal(Boolean(winner?.lifecycle.lockedAt), results[0].status === "fulfilled");
      if (f.pool) {
        const restarted = new PostgresStorage(f.pool, f.now);
        await restarted.init();
        assert.deepEqual(await restarted.roomIdentities.authority(scope), winner);
        await assert.rejects(f.pool.query(`update room_identity_authority_v2 set lifecycle=jsonb_set(lifecycle,'{lockedBy}','"tampered"'::jsonb) where room_id=$1`, [scope.roomId]), /nonmonotonic_identity_lifecycle/);
      }
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

    if (f.pool) await t.test("Postgres admission waits for invite revocation and cannot use a stale check", async () => {
      const f = await fixture(t, backend);
      await f.storage.identityProtocol.raise(2);
      const { scope } = await f.makeRoom(false, undefined, false);
      const invite = await f.issueV2Invite(scope, "host");
      const holder = await f.pool!.connect();
      let attempt: Promise<unknown> | undefined;
      const wait = async (predicate: () => Promise<boolean>) => {
        for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(25); }
        assert.fail("expected invite row lock was not observed");
      };
      try {
        await holder.query("begin");
        await holder.query("select 1 from room_invites where invite_id=$1 for update", [invite.inviteId]);
        const holderPid: number = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
        attempt = f.service.admit({ ...scope, displayName: "Too late", inviteTokenHash: invite.tokenHash });
        void attempt.catch(() => undefined);
        await wait(async () => (await f.pool!.query(`select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked`, [holderPid])).rows[0].blocked);
        await holder.query("update room_invites set revoked_at=now() where invite_id=$1", [invite.inviteId]);
        await holder.query("commit");
        await assert.rejects(attempt, code("identity_forbidden"));
        assert.equal((await f.ids.authority(scope))?.revision, 0);
        assert.equal((await f.pool!.query("select count(*)::integer as count from room_identities_v2 where room_id=$1", [scope.roomId])).rows[0].count, 0);
      } finally {
        await holder.query("rollback");
        if (attempt) await Promise.allSettled([attempt]);
        holder.release();
      }
    });

    if (f.pool) await t.test("Postgres waiting redemption reads committed approval after a blocked request", async () => {
      const f = await fixture(t, backend);
      await f.storage.identityProtocol.raise(2);
      const { scope } = await f.makeRoom(false, undefined, false);
      const invite = await f.issueV2Invite(scope, "member", { waitingRoomEnabled: true });
      const pending = await f.service.beginWaiting({ ...scope, inviteTokenHash: invite.tokenHash, displayName: "Blocked member",
        expiresAt: new Date(f.now() + 60_000).toISOString() });
      const holder = await f.pool!.connect();
      let redemption: ReturnType<typeof f.service.redeemWaiting> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select 1 from room_waiting_requests where request_id=$1 for update", [pending.requestId]);
        const holderPid: number = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
        redemption = f.service.redeemWaiting(pending.credential, scope);
        void redemption.catch(() => undefined);
        for (let i = 0; i < 100; i++) {
          const blocked = (await f.pool!.query(`select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked`, [holderPid])).rows[0].blocked;
          if (blocked) break;
          if (i === 99) assert.fail("expected waiting request lock was not observed");
          await delay(25);
        }
        await holder.query("update room_waiting_requests set status='approved', decided_by='authorized-host', decided_at=now() where request_id=$1", [pending.requestId]);
        await holder.query("commit");
        const activated = await redemption;
        assert.equal((await f.ids.resolve(activated.identity))?.role, "member");
        assert.equal((await f.ids.authority(scope))?.revision, 0);
      } finally {
        await holder.query("rollback");
        if (redemption) await Promise.allSettled([redemption]);
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

test("Postgres upgrades pre-lifecycle authority rows without replacing their guards or resetting authority", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000
}, async t => {
  const f = await fixture(t, "postgres");
  const { scope } = await f.makeRoom();
  const lockedAt = new Date(f.now()).toISOString();
  await f.storage.updateRoom(scope.roomId, { sessionControl: { lockedAt, lockedBy: "old-administrator" } });
  const host = await f.create(scope, "host");
  await f.ids.claimHost(f.mutationProof(host.identity), 0);
  // Reconstruct the released S2a authority shape. Its existing guard functions
  // and identity/recovery records remain present throughout this migration.
  await f.pool!.query(`drop trigger vrata_identity_lifecycle_v2_monotonic on room_identity_authority_v2;
    drop function vrata_identity_lifecycle_v2_monotonic();
    alter table room_identity_authority_v2 drop column lifecycle`);
  const guards = async () => (await f.pool!.query(`select p.proname,p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=current_schema() and p.proname like 'vrata_identity_%' and p.proname <> 'vrata_identity_lifecycle_v2_monotonic' order by p.proname`)).rows;
  const before = await guards();
  const upgraded = new PostgresStorage(f.pool!, f.now);
  await upgraded.init();
  assert.deepEqual(await guards(), before);
  const authority = await upgraded.roomIdentities.authority(scope);
  assert.equal(authority?.revision, 1);
  assert.equal(authority?.hostIdentityId, host.identity.identityId);
  assert.equal(authority?.lifecycle.lockedAt, lockedAt);
  assert.equal(authority?.lifecycle.lockedBy, "old-administrator");
  assert.equal(Object.hasOwn(authority!.lifecycle, "hostParticipantId"), false);
  assert.equal((await upgraded.roomIdentities.resolve(host.identity))?.role, "host");
  await f.ids.transition(scope, { actorType: "room-session", proof: host.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 }, 1, { type: "unlock" });
  assert.equal((await f.ids.authority(scope))?.lifecycle.lockedAt, null);
  const raw = await f.pool!.query("select session_control from rooms where room_id=$1", [scope.roomId]);
  assert.equal(raw.rows[0].session_control.lockedAt, lockedAt, "legacy JSON is frozen evidence, not a second authority writer");
  await f.create(scope, "guest");
  await f.ids.transition(scope, { actorType: "room-session", proof: host.identity, expiresAtSeconds: Math.floor(f.now() / 1000) + 600 }, 2, { type: "end" });
  await assert.rejects(f.pool!.query(`update room_identity_authority_v2 set revision=revision+1,lifecycle=jsonb_set(lifecycle,'{endedAt}','null') where room_id=$1`, [scope.roomId]), /nonmonotonic_identity_lifecycle/);
  await upgraded.init();
  assert.ok((await upgraded.roomIdentities.authority(scope))?.lifecycle.endedAt);
});

test("accepted boundary image reopens v2 schema and bound owner after a failed activation rollout", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000
}, async t => {
  const modulePath = process.env.VRATA_BOUNDARY_ROLLBACK_STORAGE_MODULE;
  if (process.env.CI) assert.ok(modulePath, "CI requires the exact accepted B rollback image source");
  if (!modulePath) return;
  const f = await fixture(t, "postgres");
  await f.storage.identityProtocol.raise(2);
  const { room, identity } = await f.storage.createPersonalOwnedRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic",
    name: "Rollback-compatible owner", displayName: "Owner" });
  const { PostgresStorage: BoundaryStorage } = await import(pathToFileURL(modulePath).href);
  const boundary = new BoundaryStorage(f.pool!);
  await boundary.init();
  assert.equal(await boundary.identityProtocol.minimum(), 2);
  assert.equal((await boundary.roomIdentities.resolve(identity))?.role, "host");
  assert.equal((await boundary.roomIdentities.resolve(identity))?.isOwner, true);
  assert.equal((await boundary.updateRoom(room.roomId, { name: "Safe owner metadata during rollback" }))?.name, "Safe owner metadata during rollback");
  await assert.rejects(boundary.updateRoom(room.roomId, { ownerParticipantId: "spoofed" }), /room_identity_lifecycle_requires_v2/);
  assert.equal((await f.storage.getRoom(room.roomId))?.ownerParticipantId, identity.participantId);
  await f.storage.deleteRoom(room.roomId);
  await boundary.init();
  assert.equal(await boundary.identityProtocol.minimum(), 2);
});
