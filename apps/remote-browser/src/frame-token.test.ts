import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  FRAME_TOKEN_MAX_TTL_SECONDS,
  admitRemoteBrowserFrameSocket,
  decodeRemoteBrowserFrameToken,
  encodeRemoteBrowserFrameToken,
  type RemoteBrowserFrameSessionView,
  type RemoteBrowserFrameTokenPayload
} from "./frame-token.js";
import { resolveRemoteBrowserFrameStreamId } from "./service-policy.js";

const secret = "test-only-frame-token-secret";
const nowSeconds = 1_800_000_000;
const nowMs = nowSeconds * 1000 + 250;
const sessionId = "remote-browser:object-1";
const claims: RemoteBrowserFrameTokenPayload = { v: 2, roomId: "room-1", objectId: "object-1", executorSessionId: sessionId,
  executorInstanceId: `${sessionId}:instance:generation-1`, frameStreamId: `${sessionId}:frames`, exp: nowSeconds + 300 };
const session: RemoteBrowserFrameSessionView = { sessionId, executorInstanceId: claims.executorInstanceId, frameStreamId: claims.frameStreamId,
  roomId: claims.roomId, objectId: claims.objectId, expiresAtMs: nowMs + 900_000 };
const token = (overrides: Partial<RemoteBrowserFrameTokenPayload> = {}) => encodeRemoteBrowserFrameToken({ ...claims, ...overrides }, secret);

function admit(value: string | null, current: RemoteBrowserFrameSessionView = session, at = nowMs) {
  return admitRemoteBrowserFrameSocket({ token: value, secret, nowMs: at, findSession: () => current });
}

test("consumer re-exports the shared v2 codec and has no legacy HMAC(body) fallback", () => {
  const decoded = decodeRemoteBrowserFrameToken(token(), secret, { nowSeconds });
  assert.equal(decoded?.v === 2 && decoded.executorInstanceId === claims.executorInstanceId, true);
  assert.equal(decodeRemoteBrowserFrameToken(token(), "test-only-other-secret", { nowSeconds }), null);
  const legacyBody = Buffer.from(JSON.stringify({ roomId: claims.roomId, objectId: claims.objectId, executorSessionId: sessionId,
    frameStreamId: claims.frameStreamId, exp: claims.exp }), "utf8").toString("base64url");
  const legacyToken = `${legacyBody}.${createHmac("sha256", secret).update(legacyBody).digest("base64url")}`;
  assert.equal(decodeRemoteBrowserFrameToken(legacyToken, secret, { nowSeconds }), null);
  assert.equal(admit(legacyToken), null);
});

test("upgrade admission binds the exact executor session, instance, room, object and frame stream", () => {
  const admission = admit(token());
  assert.equal(admission?.session === session, true);
  assert.equal(admission?.executorInstanceId === claims.executorInstanceId, true);
  assert.equal(admit(token({ executorInstanceId: `${sessionId}:instance:generation-2` })), null);
  for (const drift of [
    { executorInstanceId: `${sessionId}:instance:generation-2` },
    { sessionId: "remote-browser:object-2" },
    { roomId: "room-2" },
    { objectId: "object-2" },
    { frameStreamId: undefined },
    { frameStreamId: "remote-browser:object-2:frames" }
  ]) {
    assert.equal(admit(token(), { ...session, ...drift }), null);
  }
  assert.equal(admitRemoteBrowserFrameSocket({ token: token(), secret, nowMs, findSession: () => undefined }), null);
  for (const bad of [null, "", "not-a-token", `${token()}x`]) {
    assert.equal(admit(bad), null);
  }
});

test("a session created without a frame stream admits the canonical token and no other stream", () => {
  const created: RemoteBrowserFrameSessionView = { ...session, frameStreamId: resolveRemoteBrowserFrameStreamId({ sessionId }) };
  assert.equal(admit(token(), created)?.session === created, true);
  // The shared codec never signs another stream, and a session holding any other stream is refused.
  assert.throws(() => token({ frameStreamId: `${sessionId}:frame` }));
  for (const frameStreamId of ["", `${sessionId}:frame`, "remote-browser:object-2:frames"]) {
    assert.equal(admit(token(), { ...created, frameStreamId }), null);
  }
});

test("upgrade admission rejects an executor past its deadline even before session GC runs", () => {
  assert.equal(admit(token(), { ...session, expiresAtMs: nowMs }), null);
  assert.equal(admit(token(), { ...session, expiresAtMs: nowMs - 1 }), null);
  // Inside the executor's final second the floored lease is already over: fail closed.
  assert.equal(admit(token(), { ...session, expiresAtMs: nowSeconds * 1000 + 999 }), null);
});

test("socket lease is the earliest of token expiry, the 600 second cap and the executor deadline", () => {
  assert.equal(FRAME_TOKEN_MAX_TTL_SECONDS, 600);
  assert.equal(admit(token())?.leaseExpiresAtSeconds, nowSeconds + 300);
  // The decoder tolerates 30s of issuer skew; the lease still never extends past the cap.
  assert.equal(admit(token({ exp: nowSeconds + 630 }))?.leaseExpiresAtSeconds, nowSeconds + 600);
  assert.equal(admit(token({ exp: nowSeconds + 631 })), null);
  assert.equal(admit(token(), { ...session, expiresAtMs: nowSeconds * 1000 + 120_999 })?.leaseExpiresAtSeconds, nowSeconds + 120);
  assert.equal(admit(token({ exp: nowSeconds })), null);
});

test("one upgrade clock reading drives the decoder, the liveness check and the lease", () => {
  // nowSeconds is far from the wall clock, so these pass only if the injected reading reaches the decoder.
  const exp = nowSeconds + 1;
  assert.equal(admit(token({ exp }), session, exp * 1000 - 1)?.leaseExpiresAtSeconds, exp);
  assert.equal(admit(token({ exp }), session, exp * 1000), null);
});
