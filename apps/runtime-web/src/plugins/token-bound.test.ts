import test from "node:test";
import assert from "node:assert/strict";
import { roomPluginTokenDeadline, RoomPluginTokenBound } from "./token-bound.js";

test("plugin token deadline starts before authentication work and never at a delayed response", () => {
  assert.equal(roomPluginTokenDeadline(12.5, 900), 899012.5);
  assert.equal(roomPluginTokenDeadline(50, 1), 50);
  let now = 0;
  const proof = new RoomPluginTokenBound(() => now);
  const started = proof.begin(); now = 240_000;
  proof.admit(started, "first-proof", 900);
  assert.equal(proof.capture()?.deadlineMs, 899_000, "health/token/manifest delays cannot extend the signed lifetime");
  now = 899_000; assert.equal(proof.capture(), null);
});
test("invalid TTLs and native clock inputs do not manufacture plugin authority", () => {
  for (const ttl of [0, -1, NaN, Infinity, -Infinity, 1.5, "900", 86_401, Number.MAX_SAFE_INTEGER, undefined]) {
    assert.equal(roomPluginTokenDeadline(0, ttl), null);
  }
  for (const start of [-1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(roomPluginTokenDeadline(start, 900), null);
  }
  const proof = new RoomPluginTokenBound(() => 0); proof.admit(proof.begin(), "short", 1); assert.equal(proof.capture(), null);
});
test("token/deadline pair is captured atomically and unknown swaps cannot inherit a previous proof", () => {
  let now = 0;
  const proof = new RoomPluginTokenBound(() => now);
  proof.admit(proof.begin(), "first-proof", 900); const sent = proof.capture()!;
  proof.observeToken("first-proof"); assert.equal(proof.capture()?.deadlineMs, sent.deadlineMs);
  now = 150; const renewal = proof.begin(); now = 200;
  proof.admit(renewal, "second-proof", 900);
  assert.deepEqual(sent, { token: "first-proof", deadlineMs: 899_000 }, "renewal cannot stretch an in-flight request's captured bound");
  assert.equal(proof.capture()?.deadlineMs, 899_150);
  proof.observeToken("unexpected-proof"); assert.equal(proof.capture(), null);
  proof.admit(proof.begin(), "unexpected-proof", "900"); assert.equal(proof.capture(), null);
  proof.admit(proof.begin(), "valid-proof", 900); assert.ok(proof.capture()); proof.clear(); assert.equal(proof.capture(), null);
});
test("only single-use same-clock tickets can establish token bounds and older admits never overwrite newer proofs", () => {
  let now = 0; const proof = new RoomPluginTokenBound(() => now);
  const old = proof.begin()!; now = 100; const newer = proof.begin()!;
  assert.equal(proof.admit({ ...newer, startedAtMs: Date.now() }, "forged", 900), false);
  assert.ok(proof.admit(newer, "newer-proof", 900));
  assert.equal(proof.admit(old, "older-proof", 900), false);
  assert.equal(proof.capture()?.token, "newer-proof");
  assert.equal(proof.admit(newer, "replayed", 900), false);
  const pending = proof.begin(); proof.clear(); assert.equal(proof.admit(pending, "after-block", 900), false);
});
