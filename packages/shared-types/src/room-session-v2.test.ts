import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRoomIdentityCodec } from "./identity-credential.js";
import { createRoomSessionV2Codec } from "./room-session-v2.js";
import { signRoomSessionToken, verifyRoomSessionToken } from "./session-token.js";

const secret = "room-session-v2-test-secret-at-least-32-bytes";
const proof = { tenantId: "tenant", roomId: "room", identityId: randomUUID(), participantId: randomUUID(), authEpoch: 1 };
const nowSeconds = 1_700_000_000;

test("v2 sessions retain identity and session while rolling nonce, but never embed authority", () => {
  const codec = createRoomSessionV2Codec(secret);
  const sessionId = randomUUID();
  const first = codec.sign(proof, { nowSeconds, sessionId });
  const second = codec.sign(proof, { nowSeconds: nowSeconds + 1, sessionId });
  assert.notEqual(first, second);
  const value = codec.verify(first, proof, nowSeconds + 2)!;
  assert.deepEqual({ tenantId: value.tenantId, roomId: value.roomId, identityId: value.identityId,
    participantId: value.participantId, authEpoch: value.authEpoch, sessionId: value.sessionId }, { ...proof, sessionId });
  assert.equal(JSON.stringify(value).includes("role"), false);
  assert.equal(JSON.stringify(value).includes("permissions"), false);
  assert.equal(JSON.stringify(value).includes("owner"), false);
  assert.equal(codec.verify(second, proof, nowSeconds + 2)?.sessionId, sessionId);
});

test("v2 signing is domain separated from v1 JWT and room identity credentials", () => {
  const codec = createRoomSessionV2Codec(secret);
  const session = codec.sign(proof, { nowSeconds });
  const identity = createRoomIdentityCodec(secret).sign(proof, { nowSeconds });
  const legacy = signRoomSessionToken({ ...proof, displayName: "Legacy", role: "host", permissions: [],
    sessionId: randomUUID(), iat: nowSeconds, exp: nowSeconds + 900, jti: randomUUID() }, secret);
  assert.equal(codec.verify(identity, proof, nowSeconds), null);
  assert.equal(codec.verify(legacy, proof, nowSeconds), null);
  assert.equal(createRoomIdentityCodec(secret).verify(session, proof, nowSeconds), null);
  assert.equal(verifyRoomSessionToken(session, secret, { nowSeconds }).ok, false);
});

test("v2 credentials reject cross-room, cross-tenant, expiration, future and tampering", () => {
  const codec = createRoomSessionV2Codec(secret);
  const token = codec.sign(proof, { nowSeconds, lifetimeSeconds: 10 });
  assert.equal(codec.verify(token, { ...proof, roomId: "other" }, nowSeconds), null);
  assert.equal(codec.verify(token, { ...proof, tenantId: "other" }, nowSeconds), null);
  assert.equal(codec.verify(token, proof, nowSeconds + 10), null);
  assert.equal(codec.verify(token, proof, nowSeconds - 31), null);
  assert.equal(codec.verify(`${token}extra`, proof, nowSeconds), null);
  assert.equal(createRoomSessionV2Codec("different-room-session-root-secret-32-bytes").verify(token, proof, nowSeconds), null);
  const [prefix, encoded, signature] = token.split(".");
  const untrusted = JSON.parse(Buffer.from(encoded!, "base64url").toString()) as Record<string, unknown>;
  untrusted.role = "host";
  assert.equal(codec.verify(`${prefix}.${Buffer.from(JSON.stringify(untrusted)).toString("base64url")}.${signature}`, proof, nowSeconds), null);
  assert.throws(() => codec.sign(proof, { nowSeconds, lifetimeSeconds: 86_401 }), /invalid_room_session_v2/);
  assert.throws(() => createRoomSessionV2Codec("short"), /identity_secret_too_short/);
});
