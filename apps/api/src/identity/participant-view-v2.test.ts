import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "../storage.js";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { createRoomIdentityService } from "./service.js";
import { resolveRoomRequestV2 } from "./http-authority.js";
import { IdentityBoundaryError } from "./legacy-boundary.js";
import type { RoomIdentityProof } from "./contracts.js";
import { assertParticipantViewDeadline, readParticipantSessionViewV2 } from "./participant-view-v2.js";

async function fixture() {
  let at = Date.now(); const now = () => at;
  const storage = new MemoryStorage(now);
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned participant view", sessionControl: { hostParticipantId: null } });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  await storage.identityProtocol.raise(2);
  const create = (name: string) => storage.roomIdentities.create({ ...scope, displayName: name, baseRole: "member",
    provenance: { kind: "invite", inviteId: `owned-${name}-invite`, role: "member" } });
  const host = await create("Host"), member = await create("Member");
  const admin = { actorType: "admin-token", actorId: "owned-admin", role: "admin" } as const;
  await storage.roomIdentities.transition(scope, admin, 0, { type: "transfer-host", targetParticipantId: host.participantId });
  const secret = "owned-participant-view-signing-secret-32-bytes";
  const credential = createRoomIdentityCodec(secret).sign(member, { nowSeconds: Math.floor(now() / 1000) });
  const issued = await createRoomIdentityService(storage.roomIdentities, secret, now).issueSession(credential, scope);
  const verified = (await resolveRoomRequestV2({ storage, secret, token: issued.sessionToken, expectedRoomId: room.roomId, now }))!;
  return { storage, room, scope, host, member, admin, verified, now, setTime: (next: number) => { at = next; } };
}

test("v2 GET projection reads fresh coherent rights instead of its entry-time cached role and mints no credential", async () => {
  const f = await fixture(); assert.equal(f.verified.role, "member");
  await f.storage.roomIdentities.transition(f.scope, f.admin, 1, { type: "grant-presenter", targetParticipantId: f.member.participantId });
  const payload = await readParticipantSessionViewV2(f.storage, f.verified, f.now);
  assert.equal(payload.authorityRevision, 2); assert.equal(payload.participant.role, "presenter");
  assert.equal(payload.participant.access.canStartScreenShare, true);
  assert.equal(payload.state.presenterParticipantId, f.member.participantId);
  assert.equal(payload.slots.presenter?.displayName, "Member");
  assert.equal(payload.slots.host?.participantId, f.host.participantId);
  for (const field of ["token", "identityCredential", "sessionId", "identityId", "authEpoch"]) assert.equal(field in payload, false);
  assert.deepEqual(Object.keys(payload.state).sort(), ["endedAt", "hostParticipantId", "lockedAt", "presenterParticipantId"]);
  assert.ok(!JSON.stringify(payload).includes(f.member.identityId));
});

test("v2 view pins the original MAC deadline across an awaited lookup", async t => {
  const f = await fixture(), original = f.storage.roomIdentities.resolveView;
  const deadline = Math.floor(f.now() / 1000) + 1; f.verified.expiresAtSeconds = deadline;
  t.mock.method(f.storage.roomIdentities, "resolveView", async (proof: RoomIdentityProof) => {
    const view = await original(proof);
    f.verified.expiresAtSeconds += 1000; f.setTime(deadline * 1000); return view;
  });
  await assert.rejects(readParticipantSessionViewV2(f.storage, f.verified, f.now), error => error instanceof IdentityBoundaryError
    && error.status === 401 && error.reason === "identity_session_expired");
});

test("v2 view rejects a revoked subject and does not publish partial slot data", async () => {
  const f = await fixture(); await f.storage.roomIdentities.revoke(f.scope, f.member.identityId, f.member.authEpoch);
  await assert.rejects(readParticipantSessionViewV2(f.storage, f.verified, f.now), error => error instanceof IdentityBoundaryError
    && error.status === 409 && error.reason === "identity_recovery_required");
});

test("view storage failures and invalid clocks become a fixed unavailable boundary", async t => {
  const f = await fixture();
  t.mock.method(f.storage.roomIdentities, "resolveView", async () => { throw new Error("private-database-address"); });
  await assert.rejects(readParticipantSessionViewV2(f.storage, f.verified, f.now), error => error instanceof IdentityBoundaryError
    && error.status === 503 && error.reason === "identity_authority_unavailable");
  assert.throws(() => assertParticipantViewDeadline(100, () => NaN), error => error instanceof IdentityBoundaryError && error.status === 503);
});
