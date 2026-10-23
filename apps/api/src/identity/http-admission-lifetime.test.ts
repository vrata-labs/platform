import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { MemoryStorage } from "../storage.js";
import { createRoomIdentityService } from "./service.js";
import { admitV2RoomSession, type V2AdmissionRequest } from "./http-admission.js";

const secret = "owned-http-admission-lifetime-test-secret-32-bytes";
const admin = { actorType: "admin-token", actorId: "owned-lifetime-fixture", role: "admin" } as const;
const hashInvite = (token: string) => createHash("sha256").update(token).digest("base64url");

for (const fractionMs of [0, 999]) test(`v2 admission TTL matches signed session lifetime at millisecond ${fractionMs}`, async () => {
  const at = Math.floor(Date.now() / 1000) * 1000 + fractionMs, now = () => at;
  const storage = new MemoryStorage(now); await storage.identityProtocol.raise(2);
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned lifetime fixture", visibility: "private" });
  const scope = { roomId: room.roomId, tenantId: room.tenantId };
  const service = createRoomIdentityService(storage.roomIdentities, secret, now);
  const admit = async (payload: Partial<V2AdmissionRequest>, target = room) => {
    const result = await admitV2RoomSession({ storage, room: target, payload: { identityProtocolVersion: 2, roomId: target.roomId, ...payload }, secret, hashInvite, now });
    assert.equal(result.status, 200);
    const claims = createRoomSessionV2Codec(secret).verify(result.body.token, { tenantId: target.tenantId, roomId: target.roomId }, Math.floor(at / 1000));
    assert.ok(claims);
    const ttl = result.body.expiresInSeconds; assert.ok(typeof ttl === "number" && Number.isSafeInteger(ttl));
    assert.equal(ttl, claims.expiresAtSeconds - claims.issuedAtSeconds);
    assert.ok(claims.expiresAtSeconds * 1000 >= at + (ttl - 1) * 1000 + 1,
      "native request-start bound must expire before the signed server cutoff");
    return result.body;
  };
  const inviteToken = randomUUID().replaceAll("-", "") + "owned";
  await storage.createRoomInviteV2({ roomId: room.roomId, tokenHash: hashInvite(inviteToken), role: "member", waitingRoomEnabled: false,
    expiresAt: new Date(at + 60_000).toISOString(), actor: admin });
  const first = await admit({ inviteToken, displayName: "Owned invited participant" });
  await admit({ identityCredential: first.identityCredential });

  const waitingToken = randomUUID().replaceAll("-", "") + "waiting";
  const invitation = await storage.createRoomInviteV2({ roomId: room.roomId, tokenHash: hashInvite(waitingToken), role: "member", waitingRoomEnabled: true,
    expiresAt: new Date(at + 60_000).toISOString(), actor: admin });
  const pending = await service.beginWaiting({ ...scope, inviteTokenHash: invitation.tokenHash, displayName: "Owned waiting participant", expiresAt: new Date(at + 60_000).toISOString() });
  await storage.updateWaitingRoomRequest(room.roomId, pending.requestId, { status: "approved", decidedBy: admin.actorId, decidedAt: new Date(at).toISOString() });
  await admit({ waitingCredential: pending.credential });

  const legacyId = `owned-legacy-${randomUUID()}`;
  const recoveryRoom = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned recovery lifetime",
    sessionControl: { hostParticipantId: legacyId } });
  const recovery = await service.issueRecovery({ tenantId: recoveryRoom.tenantId, roomId: recoveryRoom.roomId, issuer: admin,
    targetRole: "host", targetParticipantId: legacyId, expiresAt: new Date(at + 60_000).toISOString() });
  await admit({ recoveryCredential: recovery.credential }, recoveryRoom);
});
