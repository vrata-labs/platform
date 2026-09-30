import assert from "node:assert/strict";
import test from "node:test";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { randomUUID } from "node:crypto";
import { MemoryStorage } from "../storage.js";
import { createRoomIdentityService } from "./service.js";
import { resolveRoomRequestV2, untrustedSessionRoom } from "./http-authority.js";

test("HTTP v2 resolution ignores public IDs and discarded JWT roles, checking authority on every call", async () => {
  const secret = "test-http-v2-authority-secret-longer-than-32-bytes";
  const storage = new MemoryStorage();
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Proof context" });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  await storage.identityProtocol.raise(2);
  const identity = await storage.roomIdentities.admit({ ...scope, displayName: "Guest" });
  const credential = createRoomIdentityCodec(secret).sign(identity);
  const service = createRoomIdentityService(storage.roomIdentities, secret);
  const session = (await service.issueSession(credential, scope)).sessionToken;
  const read = () => resolveRoomRequestV2({ storage, secret, token: session, expectedRoomId: scope.roomId,
    participantId: identity.participantId });
  assert.equal(untrustedSessionRoom(session), scope.roomId);
  assert.equal((await read())?.role, "guest");
  assert.equal(await resolveRoomRequestV2({ storage, secret, token: session, participantId: "public-id-spoof" }), null);
  assert.equal(await resolveRoomRequestV2({ storage, secret, token: session, expectedRoomId: "other-room" }), null);
  const now = Math.floor(Date.now() / 1000);
  const legacy = signRoomSessionToken({ ...scope, participantId: identity.participantId,
    displayName: "Fake Host", role: "host", permissions: [], sessionId: randomUUID(), jti: randomUUID(), iat: now, exp: now + 900 }, secret);
  assert.equal(untrustedSessionRoom(legacy), null);
  assert.equal(await resolveRoomRequestV2({ storage, secret, token: legacy }), null);
  assert.equal(await resolveRoomRequestV2({ storage, secret, token: `${session}x` }), null);
  await storage.roomIdentities.revoke(scope, identity.identityId, 1);
  assert.equal(await read(), null);
});
