import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { createRoomIdentityCodec } from "./identity-credential.js";
import { signRoomSessionToken, verifyRoomSessionToken } from "./session-token.js";

const secret = "test-only-identity-root-secret-32-bytes-minimum";
const scope = { tenantId: "tenant", roomId: "room" };
const proof = { ...scope, identityId: randomUUID(), participantId: "server-id", authEpoch: 1 };
const nowSeconds = 1_800_000_000;

test("v2 identity tokens bind room/tenant/epoch with no embedded role and renew with a new nonce", () => {
  const codec = createRoomIdentityCodec(secret);
  const a = codec.sign(proof, { nowSeconds });
  const b = codec.sign(proof, { nowSeconds });
  assert.notEqual(a, b);
  const decoded = codec.verify(a, scope, nowSeconds)!;
  assert.equal(decoded.identityId, proof.identityId);
  assert.equal(decoded.authEpoch, 1);
  assert.equal(Object.hasOwn(decoded, "role"), false);
  assert.equal(Object.hasOwn(decoded, "permissions"), false);
  assert.equal(codec.verify(a, { ...scope, roomId: "other" }, nowSeconds), null);
  assert.equal(codec.verify(a, { ...scope, tenantId: "other" }, nowSeconds), null);
  assert.equal(codec.verify(a, scope, nowSeconds + 900), null);
  assert.equal(codec.verify(a, scope, nowSeconds - 31), null);
  assert.equal(createRoomIdentityCodec(secret + "other").verify(a, scope, nowSeconds), null);
});

test("legacy privileged tokens and v2 credentials cannot be substituted for each other", () => {
  const legacy = signRoomSessionToken({ ...scope, participantId: "legacy-host", displayName: "Host", role: "host", roleSource: "trusted",
    permissions: [], sessionId: "old-session", jti: randomUUID(), iat: nowSeconds, exp: nowSeconds + 900 }, secret);
  const codec = createRoomIdentityCodec(secret);
  assert.equal(codec.verify(legacy, scope, nowSeconds), null);
  assert.equal(verifyRoomSessionToken(codec.sign(proof, { nowSeconds }), secret, { nowSeconds }).ok, false);
  const [, body] = codec.sign(proof, { nowSeconds }).split(".");
  const signedWithRawRoot = `ri2.${body}.${createHmac("sha256", secret).update(`ri2.${body}`).digest("base64url")}`;
  assert.equal(codec.verify(signedWithRawRoot, scope, nowSeconds), null);
});

test("signed but malformed identity claims cannot acquire authority", () => {
  const codec = createRoomIdentityCodec(secret);
  const valid = codec.verify(codec.sign(proof, { nowSeconds }), scope, nowSeconds)!;
  const key = Buffer.from(hkdfSync("sha256", secret, "vrata.identity.v2", "room-identity", 32));
  for (const patch of [{ purpose: "room-admin" }, { version: 1 }, { role: "host" }, { authEpoch: 0 }, { authEpoch: 1.5 },
    { identityId: "public-participant-id" }, { expiresAtSeconds: nowSeconds + 86_401 }, { nonce: "" }, { roomId: "" }]) {
    const body = `ri2.${Buffer.from(JSON.stringify({ ...valid, ...patch })).toString("base64url")}`;
    assert.equal(codec.verify(`${body}.${createHmac("sha256", key).update(body).digest("base64url")}`, scope, nowSeconds), null);
  }
  for (const bad of [undefined, "", "x".repeat(4097), "ri2.bad.bad", codec.sign(proof, { nowSeconds }) + "="]) {
    assert.equal(codec.verify(bad, scope, nowSeconds), null);
  }
  assert.throws(() => createRoomIdentityCodec("short"), /identity_secret_too_short/);
  assert.throws(() => codec.sign(proof, { lifetimeSeconds: 86_401 }), /invalid_identity_credential/);
});

test("recovery secrets use a different key domain and cannot cross room or token type", () => {
  const codec = createRoomIdentityCodec(secret);
  const recovery = codec.createRecovery(scope);
  assert.deepEqual(codec.parseRecovery(recovery.credential, scope), { recoveryId: recovery.recoveryId, secretHash: recovery.secretHash });
  assert.notEqual(codec.parseRecovery(recovery.credential, { ...scope, roomId: "other" })?.secretHash, recovery.secretHash);
  assert.notEqual(recovery.secretHash, createHmac("sha256", secret).update(recovery.credential).digest("hex"));
  assert.equal(codec.parseRecovery(codec.sign(proof), scope), null);
  assert.equal(codec.verify(recovery.credential, scope), null);
  assert.equal(codec.parseRecovery(recovery.credential + "=", scope), null);
});

test("waiting proof is an opaque room-bound possession secret, not admission or recovery", () => {
  const codec = createRoomIdentityCodec(secret);
  const waiting = codec.createWaiting(scope);
  const second = codec.createWaiting(scope);
  assert.notEqual(waiting.credential, second.credential);
  assert.deepEqual(codec.parseWaiting(waiting.credential, scope), { pendingId: waiting.pendingId, secretHash: waiting.secretHash });
  assert.notEqual(codec.parseWaiting(waiting.credential, { ...scope, tenantId: "other" })?.secretHash, waiting.secretHash);
  assert.notEqual(codec.parseWaiting(waiting.credential, { ...scope, roomId: "other" })?.secretHash, waiting.secretHash);
  assert.equal(codec.verify(waiting.credential, scope), null);
  assert.equal(codec.parseRecovery(waiting.credential, scope), null);
  assert.equal(codec.parseWaiting(codec.createRecovery(scope).credential, scope), null);
  assert.equal(codec.parseWaiting(waiting.credential + "=", scope), null);
  assert.equal(codec.parseWaiting(`rw2.${waiting.pendingId}.${"A".repeat(43)}`, scope)?.secretHash === waiting.secretHash, false);
});
