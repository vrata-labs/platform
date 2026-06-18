import test from "node:test";
import assert from "node:assert/strict";

import { getRoomPermissions } from "./access.js";
import { signRoomSessionToken, verifyRoomSessionToken, type RoomSessionTokenPayload } from "./session-token.js";

const payload: RoomSessionTokenPayload = {
  tenantId: "tenant-a",
  roomId: "room-a",
  participantId: "participant-a",
  displayName: "Participant A",
  role: "host",
  permissions: getRoomPermissions("host"),
  sessionId: "session-a",
  iat: 100,
  exp: 200,
  jti: "token-a"
};

test("room session token verifies signed payload and normalizes permissions", () => {
  const token = signRoomSessionToken(payload, "test-secret");
  const result = verifyRoomSessionToken(token, "test-secret", {
    nowSeconds: 150,
    tenantId: "tenant-a",
    roomId: "room-a",
    participantId: "participant-a"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.payload.permissions : [], getRoomPermissions("host"));
  assert.equal(result.ok ? result.payload.roleSource : null, "default");
});

test("room session token preserves trusted role source", () => {
  const token = signRoomSessionToken({ ...payload, roleSource: "trusted" }, "test-secret");
  const result = verifyRoomSessionToken(token, "test-secret", { nowSeconds: 150 });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.payload.roleSource : null, "trusted");
});

test("room session token rejects expired, tampered, and wrong-scope tokens", () => {
  const token = signRoomSessionToken(payload, "test-secret");

  assert.deepEqual(verifyRoomSessionToken(token, "test-secret", { nowSeconds: 201 }), {
    ok: false,
    code: "expired_token"
  });
  assert.deepEqual(verifyRoomSessionToken(`${token.slice(0, -1)}x`, "test-secret", { nowSeconds: 150 }), {
    ok: false,
    code: "invalid_signature"
  });
  assert.deepEqual(verifyRoomSessionToken(token, "test-secret", { nowSeconds: 150, roomId: "room-b" }), {
    ok: false,
    code: "room_mismatch"
  });
  assert.deepEqual(verifyRoomSessionToken(token, "test-secret", { nowSeconds: 150, tenantId: "tenant-b" }), {
    ok: false,
    code: "tenant_mismatch"
  });
});
