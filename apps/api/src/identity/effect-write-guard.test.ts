import assert from "node:assert/strict";
import test from "node:test";
import { IdentityStorageError, type RoomIdentityProof } from "./contracts.js";
import { assertCurrentEffect, type RoomEffectGuard } from "./effect-write-guard.js";
import { MemoryStorage } from "../storage.js";
import { createRoomIdentityService } from "./service.js";

const guard: RoomEffectGuard = { tenantId: "tenant", roomId: "room", identityId: "identity", participantId: "participant",
  authEpoch: 1, expiresAtSeconds: 100, permission: "notes.edit" };
const roleChanged = (error: unknown) => error instanceof IdentityStorageError && error.code === "identity_role_changed";
const invalidInput = (error: unknown) => error instanceof IdentityStorageError && error.code === "invalid_identity_input";

test("one authority snapshot must satisfy every requested publication permission", () => {
  const combined: RoomEffectGuard = { ...guard, permission: "audio.join", alsoRequired: ["screen-share.start"] };
  const actor = { ...current(), permissions: ["audio.join", "screen-share.start"] as const };
  assert.doesNotThrow(() => assertCurrentEffect(combined, { ...actor, permissions: [...actor.permissions] }, 99_000));
  for (const permissions of [["audio.join"], ["screen-share.start"]]) {
    assert.throws(() => assertCurrentEffect(combined, { ...current(), permissions } as ReturnType<typeof current>, 99_000),
      (error: unknown) => error instanceof IdentityStorageError && error.code === "identity_forbidden");
  }
  for (const alsoRequired of [null, "screen-share.start", ["unknown"], Array(17).fill("audio.join")]) {
    assert.throws(() => assertCurrentEffect({ ...guard, alsoRequired } as RoomEffectGuard, current(), 99_000), invalidInput);
  }
});

function current(input: { epoch?: number; permission?: boolean; owner?: boolean; role?: "host" | "member" | "presenter" } = {}): NonNullable<Parameters<typeof assertCurrentEffect>[1]> {
  return { identity: { ...guard, authEpoch: input.epoch ?? 1 },
    permissions: input.permission === false ? ["notes.view"] : ["notes.view", "notes.edit"],
    isOwner: input.owner ?? false, role: input.role ?? "presenter"
  } as NonNullable<Parameters<typeof assertCurrentEffect>[1]>;
}

test("effect guard rejects revoked epochs, demotion, wrong scope and expired sessions", () => {
  assert.doesNotThrow(() => assertCurrentEffect(guard, current(), 99_000));
  for (const candidate of [null, current({ epoch: 2 }),
    { ...current(), identity: { ...guard, roomId: "another-room" } }]) {
    assert.throws(() => assertCurrentEffect(guard, candidate, 99_000), (error: unknown) =>
      error instanceof IdentityStorageError && error.code === "identity_not_active");
  }
  assert.throws(() => assertCurrentEffect(guard, current({ permission: false }), 99_000), (error: unknown) =>
    error instanceof IdentityStorageError && error.code === "identity_forbidden");
  assert.throws(() => assertCurrentEffect(guard, current(), 100_000), (error: unknown) =>
    error instanceof IdentityStorageError && error.code === "identity_session_expired");
  assert.throws(() => assertCurrentEffect({ ...guard, ownerOnly: true }, current(), 99_000), (error: unknown) =>
    error instanceof IdentityStorageError && error.code === "identity_forbidden");
  assert.doesNotThrow(() => assertCurrentEffect({ ...guard, ownerOnly: true }, current({ owner: true }), 99_000));
});

test("Host-or-Owner fence accepts a Member owner while rejecting an ordinary Member or Presenter", () => {
  const controls = { ...guard, permission: "room.join" as const, hostOrOwner: true };
  const actor = (role: "host" | "member" | "presenter", isOwner = false) => ({ ...current({ role, owner: isOwner }),
    permissions: ["room.join" as const] });
  assert.equal(assertCurrentEffect(controls, actor("member", true), 99_000).isOwner, true);
  assert.equal(assertCurrentEffect(controls, actor("host"), 99_000).role, "host");
  for (const role of ["member", "presenter"] as const) {
    assert.throws(() => assertCurrentEffect(controls, actor(role), 99_000), (error: unknown) =>
      error instanceof IdentityStorageError && error.code === "identity_forbidden");
  }
});

test("optional role and ownership pins refuse exact drift, validate at runtime and leave unpinned guards unchanged", () => {
  for (const role of ["host", "member", "presenter"] as const) for (const owner of [true, false]) {
    assert.equal(assertCurrentEffect(guard, current({ role, owner }), 99_000).role, role);
  }
  const pinned: RoomEffectGuard = { ...guard, expectedRole: "presenter", expectedIsOwner: false };
  assert.doesNotThrow(() => assertCurrentEffect(pinned, current(), 99_000));
  for (const candidate of [current({ role: "member" }), current({ owner: true }), current({ role: "host", owner: true }),
    current({ role: "member", permission: false })]) {
    assert.throws(() => assertCurrentEffect(pinned, candidate, 99_000), roleChanged);
  }
  // false is a pin, not an unset value.
  assert.throws(() => assertCurrentEffect({ ...guard, expectedIsOwner: false }, current({ owner: true }), 99_000), roleChanged);
  assert.doesNotThrow(() => assertCurrentEffect({ ...guard, expectedIsOwner: true }, current({ owner: true }), 99_000));
  assert.doesNotThrow(() => assertCurrentEffect({ ...guard, expectedRole: "member" }, current({ role: "member", owner: true }), 99_000));
  for (const malformed of [{ expectedRole: "owner" }, { expectedRole: null }, { expectedIsOwner: 0 }, { expectedIsOwner: "false" },
    { expectedIsOwner: null }]) {
    for (const candidate of [current(), null]) {
      assert.throws(() => assertCurrentEffect({ ...guard, ...malformed } as unknown as RoomEffectGuard, candidate, 99_000),
        invalidInput);
    }
  }
  // Epoch and deadline refusals keep precedence over pin drift.
  assert.throws(() => assertCurrentEffect(pinned, current({ epoch: 2, role: "member" }), 99_000), (error: unknown) =>
    error instanceof IdentityStorageError && error.code === "identity_not_active");
  assert.throws(() => assertCurrentEffect(pinned, current({ role: "member" }), 100_000), (error: unknown) =>
    error instanceof IdentityStorageError && error.code === "identity_session_expired");
});

test("in-memory guarded note writes never execute after a committed revocation", async () => {
  const storage = new MemoryStorage();
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Guarded notes",
    sessionControl: { hostParticipantId: "legacy-host" } });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  await storage.identityProtocol.raise(2);
  const service = createRoomIdentityService(storage.roomIdentities, "identity-effect-memory-test-secret-32-bytes");
  const recovery = await service.issueRecovery({ ...scope, targetParticipantId: "legacy-host", targetRole: "host",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    issuer: { actorType: "admin-token", actorId: "test-admin", role: "admin" } });
  const host = await service.redeemRecovery(recovery.credential, scope);
  const protectedWrite = { ...host.identity, expiresAtSeconds: Math.floor(Date.now() / 1000) + 120,
    permission: "notes.edit" as const };
  const note = await storage.withRoomIdentityEffect(protectedWrite, scoped => scoped.upsertRoomNote({
    roomId: scope.roomId, scope: "shared", content: "before revoke"
  }));
  assert.equal(note.content, "before revoke");
  await storage.roomIdentities.revoke(scope, host.identity.identityId, 1);
  await assert.rejects(storage.withRoomIdentityEffect(protectedWrite, scoped => scoped.upsertRoomNote({
    roomId: scope.roomId, scope: "shared", content: "after revoke"
  })), (error: unknown) => error instanceof IdentityStorageError && error.code === "identity_not_active");
  assert.equal((await storage.getRoomNote(scope.roomId, "shared"))?.content, "before revoke");
});

test("in-memory role and ownership pins refuse drift before the callback or release", async () => {
  const storage = new MemoryStorage();
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Pinned effect",
    sessionControl: { hostParticipantId: "legacy-host" } });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  await storage.identityProtocol.raise(2);
  const service = createRoomIdentityService(storage.roomIdentities, "identity-pinned-memory-test-secret-32-bytes");
  const recovery = await service.issueRecovery({ ...scope, targetParticipantId: "legacy-host", targetRole: "host",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    issuer: { actorType: "admin-token", actorId: "test-admin", role: "admin" } });
  const host = await service.redeemRecovery(recovery.credential, scope);
  const base = { ...host.identity, expiresAtSeconds: Math.floor(Date.now() / 1000) + 120, permission: "room.join" as const };
  const observed = await storage.withRoomIdentityEffect(base, async (_scoped, current) => current);
  assert.equal(observed.role, "host");
  let sent = 0;
  const release = (pins: Partial<RoomEffectGuard>) => storage.withRoomIdentityEffect({ ...base, ...pins },
    async scoped => { scoped.releaseResponse(() => { sent += 1; }); });
  await release({ expectedRole: "host", expectedIsOwner: observed.isOwner });
  assert.equal(sent, 1);
  for (const pins of [{ expectedRole: "member" as const }, { expectedIsOwner: !observed.isOwner }]) {
    await assert.rejects(release(pins), roleChanged);
  }
  assert.equal(sent, 1);
  await assert.rejects(release({ expectedRole: "owner" } as unknown as Partial<RoomEffectGuard>), invalidInput);
  assert.equal(sent, 1);
});

/** A personal room with its recovered Owner (initially Host) and one admitted Member, built through the real authority APIs. */
async function heldRoom(secret: string) {
  const storage = new MemoryStorage();
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Held pinned release",
    roomType: "personal", ownerParticipantId: "owner", visibility: "private", sessionControl: { hostParticipantId: "owner" } });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  await storage.identityProtocol.raise(2);
  const admin = { actorType: "admin-token" as const, actorId: "test-admin", role: "admin" as const };
  const service = createRoomIdentityService(storage.roomIdentities, secret);
  const recovery = await service.issueRecovery({ ...scope, targetParticipantId: "owner", targetRole: "owner",
    expiresAt: new Date(Date.now() + 120_000).toISOString(), issuer: admin });
  const owner = (await service.redeemRecovery(recovery.credential, scope)).identity;
  const invite = await storage.createRoomInviteV2({ roomId: room.roomId, tokenHash: "p".repeat(43), role: "member",
    waitingRoomEnabled: false, expiresAt: new Date(Date.now() + 120_000).toISOString(), actor: admin });
  const member = (await service.admit({ ...scope, displayName: "Admitted Member", inviteTokenHash: invite.tokenHash })).identity;
  const transfer = async (type: "transfer-host" | "transfer-owner", target: RoomIdentityProof) => storage.roomIdentities.transition(scope, admin,
    (await storage.roomIdentities.authority(scope))!.revision, { type, targetParticipantId: target.participantId });
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 120;
  const pinned = (identity: RoomIdentityProof, pins: Pick<RoomEffectGuard, "expectedRole" | "expectedIsOwner"> = {}): RoomEffectGuard =>
    ({ ...identity, expiresAtSeconds, permission: "surface.view", ...pins });
  /** The fresh actor under an unpinned surface.view guard. */
  const actor = (identity: RoomIdentityProof) => storage.withRoomIdentityEffect(pinned(identity), async (_scoped, current) =>
    [current.role, current.isOwner]);
  let sent = 0;
  /** Every guard passes its entry check and parks in its callback; change commits; each then releases under its original pins. */
  async function held(guards: RoomEffectGuard[], change: () => Promise<unknown>) {
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const entered: Array<Promise<void>> = [];
    const outcomes = guards.map(value => {
      let reach!: () => void;
      entered.push(new Promise<void>(resolve => { reach = resolve; }));
      return storage.withRoomIdentityEffect(value, async scoped => { reach(); await gate; scoped.releaseResponse(() => { sent += 1; }); })
        .then(() => "released", (error: unknown) => error instanceof IdentityStorageError ? error.code : "untyped");
    });
    try {
      const first = await Promise.race([Promise.all(entered).then(() => null), Promise.race(outcomes).then(early => ({ early }))]);
      assert.equal(first, null, "every pinned entry check passed before the change");
      await change();
    } finally {
      // Parked callbacks are released even if the entry check or the change fails, so the test cannot hang.
      open();
    }
    return Promise.all(outcomes);
  }
  return { owner, member, transfer, pinned, actor, held, sent: () => sent };
}

test("in-memory pins observe an admin Host transfer committed during the held callback and refuse the release", async () => {
  const f = await heldRoom("identity-held-host-memory-secret-32-bytes");
  const asHost = f.pinned(f.owner, { expectedRole: "host", expectedIsOwner: true });
  assert.deepEqual(await f.actor(f.owner), ["host", true], "the recovered Owner starts as Host");
  assert.deepEqual(await f.held([asHost], async () => undefined), ["released"], "an unchanged pin releases across the await");
  assert.equal(f.sent(), 1);
  assert.deepEqual(await f.held([asHost], () => f.transfer("transfer-host", f.member)), ["identity_role_changed"]);
  assert.equal(f.sent(), 1, "the refused release sent nothing");
  // Drift, not a lost permission: the demoted Owner still holds surface.view.
  assert.deepEqual(await f.actor(f.owner), ["member", true]);
});

test("in-memory ownership pins observe an admin Owner handoff during the held callback with both roles unchanged", async () => {
  const f = await heldRoom("identity-held-owner-memory-secret-32-bytes");
  assert.deepEqual([await f.actor(f.owner), await f.actor(f.member)], [["host", true], ["member", false]]);
  assert.deepEqual(await f.held([f.pinned(f.member, { expectedRole: "member", expectedIsOwner: false }),
    f.pinned(f.owner, { expectedRole: "host", expectedIsOwner: true })], () => f.transfer("transfer-owner", f.member)),
  ["identity_role_changed", "identity_role_changed"], "false is enforced for the heir and true for the former Owner");
  assert.equal(f.sent(), 0);
  assert.deepEqual([await f.actor(f.owner), await f.actor(f.member)], [["host", false], ["member", true]], "only ownership moved");
});

test("in-memory Member owner binds a scene narrowly and invitation revoke preserves the first actor", async () => {
  const storage = new MemoryStorage();
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owner scene binding",
    roomType: "personal", ownerParticipantId: "owner", visibility: "private", sessionControl: { hostParticipantId: "owner" } });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  await storage.identityProtocol.raise(2);
  const admin = { actorType: "admin-token" as const, actorId: "test-admin", role: "admin" as const };
  const service = createRoomIdentityService(storage.roomIdentities, "memory-metadata-proof-test-secret-32-bytes");
  const recovery = await service.issueRecovery({ ...scope, targetParticipantId: "owner", targetRole: "owner",
    expiresAt: new Date(Date.now() + 120_000).toISOString(), issuer: admin });
  const owner = await service.redeemRecovery(recovery.credential, scope);
  const invite = await storage.createRoomInviteV2({ roomId: room.roomId, tokenHash: "m".repeat(43), role: "member",
    waitingRoomEnabled: false, expiresAt: new Date(Date.now() + 120_000).toISOString(), actor: admin });
  const nextHost = await service.admit({ ...scope, displayName: "New Host", inviteTokenHash: invite.tokenHash });
  await storage.roomIdentities.transition(scope, admin, (await storage.roomIdentities.authority(scope))!.revision,
    { type: "transfer-host", targetParticipantId: nextHost.identity.participantId });
  const guarded = { ...owner.identity, permission: "room.join" as const, hostOrOwner: true,
    roomWrite: true, expiresAtSeconds: Math.floor(Date.now() / 1000) + 120 };
  const bound = await storage.withRoomIdentityEffect(guarded, (scoped, current) => {
    assert.equal(current.role, "member");
    assert.equal(current.isOwner, true);
    return scoped.setRoomSceneBundleUrl(scope.tenantId, scope.roomId, "https://example.test/new/scene.json");
  });
  assert.equal(bound!.visibility, "private");
  assert.equal(bound!.name, room.name);
  assert.deepEqual(bound!.templateSnapshot, { ...room.templateSnapshot,
    roomConfig: { ...room.templateSnapshot.roomConfig, sceneBundleUrl: "https://example.test/new/scene.json" } });
  assert.deepEqual(await storage.getTemplateVersion(room.templateId, room.templateVersion),
    Object.fromEntries(Object.entries(room.templateSnapshot).filter(([key]) => key !== "roomConfig")));
  const first = await storage.revokeRoomInvite(scope.roomId, invite.inviteId, "2026-10-02T00:00:00.000Z", "first-actor");
  assert.deepEqual(await storage.revokeRoomInvite(scope.roomId, invite.inviteId, "2026-10-03T00:00:00.000Z", "second-actor"), first);
  await storage.transitionReferenceTemplateCatalog("active");
  const reference = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Reference" });
  await assert.rejects(storage.setRoomSceneBundleUrl(reference.tenantId, reference.roomId, "https://example.test/scene.json"), /reference_scene_override_not_allowed/);
  assert.deepEqual(await storage.getRoom(reference.roomId), reference);
});
