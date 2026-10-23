import assert from "node:assert/strict";
import test from "node:test";
import { decodeRemoteBrowserFrameToken } from "@vrata/shared-types/remote-browser-frame-token";
import { captureFrameCredentialPlan, captureRemoteBrowserFrameBinding, issueRemoteBrowserFrameCredential } from "./remote-browser-frame-credential.js";

const body = { roomId: "room-1", objectId: "object-1", executorSessionId: "remote-browser:object-1",
  executorInstanceId: "remote-browser:object-1:instance:generation-1", frameStreamId: "remote-browser:object-1:frames" };
const secret = "frame-credential-test-secret";
const nowSeconds = 1_800_000_000;
const nowMs = nowSeconds * 1000 + 500;
const plan = (proofExpiresAtSeconds: number, ttlSeconds = 120) => captureFrameCredentialPlan({ binding: captureRemoteBrowserFrameBinding(body)!,
  secret, ttlSeconds, proofExpiresAtSeconds, frameStreamUrl: "wss://browser.example.test/frames" });

test("binding capture copies exactly the five shared-codec fields and refuses malformed bindings", () => {
  const captured = captureRemoteBrowserFrameBinding({ ...body, sessionToken: "secret", extra: 1 });
  assert.deepEqual(captured, body);
  assert.ok(Object.isFrozen(captured));
  for (const malformed of [null, "binding", [], { ...body, executorSessionId: "remote-browser:other" }, { ...body, frameStreamId: "frames" },
    { ...body, executorInstanceId: "remote-browser:object-1:instance:" }, { ...body, roomId: 7 }]) {
    assert.equal(captureRemoteBrowserFrameBinding(malformed), null);
  }
});

test("issued credential is v2, capped by the original proof expiry and reports the exact remainder", () => {
  const full = issueRemoteBrowserFrameCredential(plan(nowSeconds + 900), nowMs)!;
  assert.equal(full.expiresInSeconds, 120);
  assert.deepEqual(decodeRemoteBrowserFrameToken(full.token, secret, { nowSeconds }), { v: 2, ...body, exp: nowSeconds + 120 });
  assert.equal(new URL(full.frameStreamUrl).searchParams.get("token") === full.token, true);
  const short = issueRemoteBrowserFrameCredential(plan(nowSeconds + 7), nowMs)!;
  assert.equal(short.expiresInSeconds, 7);
  assert.equal(decodeRemoteBrowserFrameToken(short.token, secret, { nowSeconds })?.exp, nowSeconds + 7);
  assert.equal(issueRemoteBrowserFrameCredential(plan(nowSeconds), nowMs), null);
  assert.equal(issueRemoteBrowserFrameCredential(plan(nowSeconds - 1), nowMs), null);
});

test("plan capture refuses out-of-range lifetimes and an unfrozen binding", () => {
  for (const ttlSeconds of [0, 601, 1.5]) assert.throws(() => plan(nowSeconds + 900, ttlSeconds), /invalid_frame_credential_plan/);
  assert.throws(() => captureFrameCredentialPlan({ binding: { ...body }, secret, ttlSeconds: 120, proofExpiresAtSeconds: nowSeconds + 900,
    frameStreamUrl: "wss://browser.example.test/frames" }), /invalid_frame_credential_plan/);
});
