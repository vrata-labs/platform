import assert from "node:assert/strict";
import test from "node:test";
import { IdentityStorageError } from "./contracts.js";
import { assertCurrentEffect, type RoomEffectGuard } from "./effect-write-guard.js";
import { MemoryStorage } from "../storage.js";
import { createRoomIdentityService } from "./service.js";

const guard: RoomEffectGuard = { tenantId: "tenant", roomId: "room", identityId: "identity", participantId: "participant",
  authEpoch: 1, expiresAtSeconds: 100, permission: "notes.edit" };

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
