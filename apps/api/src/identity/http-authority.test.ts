import assert from "node:assert/strict";
import test from "node:test";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { MemoryStorage } from "../storage.js";
import { createRoomIdentityService } from "./service.js";
import { resolveRoomRequestV2, untrustedSessionRoom } from "./http-authority.js";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { IdentityBoundaryError } from "./legacy-boundary.js";
import { verifyExpiredSession } from "./session-expiry.js";

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

test("expired RS2 is classified only after MAC, scope, participant and current epoch checks; it never authenticates", async () => {
  const secret = "expired-http-session-classification-key-32-bytes";
  let at = Date.now();
  const now = () => at;
  const storage = new MemoryStorage(now);
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Expired entry" });
  await storage.identityProtocol.raise(2);
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  const identity = await storage.roomIdentities.admit({ ...scope, displayName: "Guest" });
  const seconds = Math.floor(at / 1000);
  const token = createRoomSessionV2Codec(secret).sign(identity, { nowSeconds: seconds, lifetimeSeconds: 60 });
  const read = (overrides: Partial<Parameters<typeof resolveRoomRequestV2>[0]> = {}) =>
    resolveRoomRequestV2({ storage, secret, token, now, expectedRoomId: room.roomId, ...overrides });
  at = (seconds + 60) * 1000 - 1;
  assert.ok(await read());
  at++;
  const expired = (error: unknown) => error instanceof IdentityBoundaryError && error.status === 401
    && error.reason === "identity_session_expired";
  await assert.rejects(read(), expired);
  assert.equal(await read({ participantId: "wrong-participant" }), null);
  assert.equal(await read({ expectedRoomId: "wrong-room" }), null);
  assert.equal(await read({ secret: `${secret}-wrong` }), null);
  assert.equal(await read({ token: `${token}x` }), null);
  assert.equal(await read({ token: createRoomSessionV2Codec(secret).sign({ ...identity, authEpoch: 2 },
    { nowSeconds: seconds, lifetimeSeconds: 60 }) }), null, "expired active-identity epoch mismatch is recovery refusal");
  const parts = token.split(".");
  const forged = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  forged.expiresAtSeconds--;
  assert.equal(await read({ token: `rs2.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${parts[2]}` }), null);
  const service = createRoomIdentityService(storage.roomIdentities, secret, now);
  const credential = createRoomIdentityCodec(secret).sign(identity, { nowSeconds: seconds, lifetimeSeconds: 86_400 });
  assert.equal((await service.issueSession(credential, scope)).identity.identityId, identity.identityId);
  const resolve = storage.roomIdentities.resolve;
  storage.roomIdentities.resolve = async proof => { const current = await resolve(proof); at = (seconds + 60) * 1000; return current; };
  at = (seconds + 60) * 1000 - 1;
  await assert.rejects(read(), expired, "expiry during authority lookup must not leak an authenticated expired context");
  storage.roomIdentities.resolve = resolve;
  await storage.roomIdentities.revoke(scope, identity.identityId, 1);
  assert.equal(await read(), null, "an expired revoked epoch is recovery refusal, not renewable expiry");
});

test("expired classification rejects future-issued claims and invalid signed schemas without using decoded payload as proof", async t => {
  const secret = "expired-session-schema-test-key-32-bytes";
  const scope = { tenantId: "tenant", roomId: "room" };
  const now = 100_000;
  const proof = { ...scope, identityId: randomUUID(), participantId: "participant", authEpoch: 1 };
  const codec = createRoomSessionV2Codec(secret);
  const token = codec.sign(proof, { nowSeconds: now - 60, lifetimeSeconds: 60 });
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  const signClaims = (payload: Record<string, unknown>) => {
    const body = `rs2.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const key = Buffer.from(hkdfSync("sha256", secret, "vrata.identity.v2", "room-session", 32));
    return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
  };
  for (const [name, candidate] of [
    ["future-issued valid schema", codec.sign(proof, { nowSeconds: now + 31, lifetimeSeconds: 60 })],
    ["future issuance forged into expired lifetime", signClaims({ ...claims, issuedAtSeconds: now + 31 })],
    ["extra role with valid MAC", signClaims({ ...claims, role: "host" })],
    ["wrong purpose with valid MAC", signClaims({ ...claims, purpose: "room-identity" })],
    ["excessive lifetime with valid MAC", signClaims({ ...claims, issuedAtSeconds: 0, expiresAtSeconds: 86_401 })],
    ["expired foreign room with valid MAC", codec.sign({ ...proof, roomId: "foreign" }, { nowSeconds: now - 60, lifetimeSeconds: 60 })],
    ["expired foreign tenant with valid MAC", codec.sign({ ...proof, tenantId: "foreign" }, { nowSeconds: now - 60, lifetimeSeconds: 60 })]
  ] as const) await t.test(name, () => {
    assert.equal(verifyExpiredSession(candidate, secret, scope, now), null);
    assert.equal(codec.verify(candidate, scope, now), null);
  });
  assert.ok(verifyExpiredSession(token, secret, scope, now), "only signed, structurally valid actual expiry is classified");
  assert.equal(codec.verify(token, scope, now), null, "classification does not make the expired token authenticatable");
});
