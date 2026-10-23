import assert from "node:assert/strict";
import test from "node:test";
import { createFrameMediaPeerBinding } from "./frame-media-peer.js";

function fakePeers() {
  const closed: string[] = [];
  let issued = 0;
  const binding = createFrameMediaPeerBinding<string>({
    closePeer: (frame, nonce) => { closed.push(`${frame}/${nonce}`); },
    createNonce: () => `nonce-${++issued}`
  });
  return { binding, closed };
}

test("release before completion fences the late answer, which closes only its own peer", () => {
  const { binding, closed } = fakePeers();
  const negotiation = binding.begin()!;
  binding.release();
  assert.equal(negotiation.isCurrent(), false);
  assert.deepEqual(closed, []);
  assert.equal(negotiation.complete("frame-a"), false);
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  binding.release();
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  assert.equal(binding.begin(), null);
});

test("release after completion closes the installed peer exactly once", () => {
  const { binding, closed } = fakePeers();
  assert.equal(binding.begin()!.complete("frame-a"), true);
  assert.deepEqual(closed, []);
  binding.release();
  binding.release();
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
});

test("a second offer closes the previous peer even when it lands in another iframe", () => {
  const { binding, closed } = fakePeers();
  assert.equal(binding.begin()!.complete("frame-a"), true);
  const second = binding.begin()!;
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  assert.equal(second.complete("frame-b"), true);
  binding.release();
  assert.deepEqual(closed, ["frame-a/nonce-1", "frame-b/nonce-2"]);
});

test("a stale completion cannot replace the newer peer and never closes it", () => {
  const { binding, closed } = fakePeers();
  const stale = binding.begin()!;
  const fresh = binding.begin()!;
  assert.equal(stale.isCurrent(), false);
  assert.equal(fresh.complete("frame-a"), true);
  assert.equal(stale.complete("frame-a"), false);
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  binding.release();
  assert.deepEqual(closed, ["frame-a/nonce-1", "frame-a/nonce-2"]);
});

test("a failed negotiation discards its own nonce and cannot install afterwards", () => {
  const { binding, closed } = fakePeers();
  const failed = binding.begin()!;
  failed.discard("frame-a");
  assert.equal(failed.isCurrent(), false);
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  const unanswered = binding.begin()!;
  unanswered.discard();
  assert.equal(unanswered.isCurrent(), false);
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  binding.release();
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
});

test("release closes the pending peer before its answer exists, and the late answer closes nothing more", () => {
  const { binding, closed } = fakePeers();
  const negotiation = binding.begin()!;
  assert.equal(negotiation.attach("frame-a"), true);
  binding.release();
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  assert.equal(negotiation.attach("frame-b"), false);
  assert.equal(negotiation.complete("frame-a"), false);
  negotiation.discard("frame-a");
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
});

test("a newer offer closes the older pending peer, whose late completion cannot install or close the newer nonce", () => {
  const { binding, closed } = fakePeers();
  const older = binding.begin()!;
  assert.equal(older.attach("frame-a"), true);
  const newer = binding.begin()!;
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  assert.equal(older.attach("frame-b"), false);
  assert.equal(newer.attach("frame-a"), true);
  assert.equal(older.complete("frame-a"), false);
  older.discard("frame-a");
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  assert.equal(newer.complete("frame-a"), true);
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  binding.release();
  assert.deepEqual(closed, ["frame-a/nonce-1", "frame-a/nonce-2"]);
});

test("moving to the next iframe closes the previous frame's claim, and discard closes the attached frame", () => {
  const { binding, closed } = fakePeers();
  const negotiation = binding.begin()!;
  assert.equal(negotiation.attach("frame-a"), true);
  assert.equal(negotiation.attach("frame-b"), true);
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
  negotiation.discard();
  assert.deepEqual(closed, ["frame-a/nonce-1", "frame-b/nonce-1"]);
  binding.release();
  assert.deepEqual(closed, ["frame-a/nonce-1", "frame-b/nonce-1"]);
});

test("completion transfers the pending record without closing the answered peer", () => {
  const { binding, closed } = fakePeers();
  const negotiation = binding.begin()!;
  assert.equal(negotiation.attach("frame-a"), true);
  assert.equal(negotiation.complete("frame-a"), true);
  assert.deepEqual(closed, []);
  binding.release();
  assert.deepEqual(closed, ["frame-a/nonce-1"]);
});

test("cleanup failures from detached frames and closed contexts are contained", async () => {
  const binding = createFrameMediaPeerBinding<string>({
    closePeer: (frame) => {
      if (frame === "detached") throw new Error("detached");
      return Promise.reject(new Error("closed"));
    }
  });
  const first = binding.begin()!;
  assert.equal(first.complete("detached"), true);
  const second = binding.begin()!;
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(second.complete("closed-context"), true);
  assert.doesNotThrow(() => binding.release());
  // An unhandled rejection here would fail the test run.
  await new Promise((resolve) => setImmediate(resolve));
});
