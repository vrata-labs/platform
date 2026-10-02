import assert from "node:assert/strict";
import test from "node:test";
import { IdentityStorageError } from "./contracts.js";
import { assertCurrentEffect, type RoomEffectGuard } from "./effect-write-guard.js";
import { MemoryStorage } from "../storage.js";
import { createRoomIdentityService } from "./service.js";

const guard: RoomEffectGuard = { tenantId: "tenant", roomId: "room", identityId: "identity", participantId: "participant",
  authEpoch: 1, expiresAtSeconds: 100, permission: "notes.edit" };

function current(input: { epoch?: number; permission?: boolean; owner?: boolean } = {}): NonNullable<Parameters<typeof assertCurrentEffect>[1]> {
  return { identity: { ...guard, authEpoch: input.epoch ?? 1 },
    permissions: input.permission === false ? ["notes.view"] : ["notes.view", "notes.edit"],
    isOwner: input.owner ?? false
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
    error instanceof IdentityStorageError && error.code === "identity_not_active");
  assert.throws(() => assertCurrentEffect({ ...guard, ownerOnly: true }, current(), 99_000), (error: unknown) =>
    error instanceof IdentityStorageError && error.code === "identity_forbidden");
  assert.doesNotThrow(() => assertCurrentEffect({ ...guard, ownerOnly: true }, current({ owner: true }), 99_000));
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
