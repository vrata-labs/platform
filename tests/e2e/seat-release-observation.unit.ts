import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { finishReleasedAvatar, observeReleasedAvatar, type ReleaseEvidence } from "./seat-release-observation.ts";

// Execute the actual page.evaluate function with a finite manual RAF/timer clock.
// No browser, real timers, extra samples or duplicate readiness implementation.
async function clock(run: (c: ReturnType<typeof makeClock>) => Promise<void>) {
  const keys = ["window", "requestAnimationFrame", "cancelAnimationFrame"] as const;
  const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const c = makeClock();
  Object.assign(globalThis, { window: c.window, requestAnimationFrame: c.request, cancelAnimationFrame: c.cancel });
  try { await run(c); }
  finally {
    keys.forEach((key, i) => {
      if (saved[i]) Object.defineProperty(globalThis, key, saved[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}
function makeClock() {
  let raf: FrameRequestCallback | null = null, timer: (() => void) | null = null, timeoutMs = 0;
  const remote = { participantId: "private-id", hasVisualEntity: true,
    root: { x: 1, y: 2, z: 3, secret: "raw-scene" }, url: "https://private.invalid" };
  const transport = { participantId: "private-id", hasPoseFrame: true, lastPoseSeq: 8, playbackDelayMs: 10,
    token: "private-token" };
  return {
    remote, transport,
    window: { __VRATA_DEBUG__: { remoteParticipants: [remote], remoteAvatarParticipants: [transport] },
      setTimeout: (callback: () => void, ms: number) => { timer = callback; timeoutMs = ms; return 2; },
      clearTimeout: () => { timer = null; } },
    request: (callback: FrameRequestCallback) => { raf = callback; return 1; },
    cancel: () => { raf = null; },
    tick(now: number) { assert.ok(raf, "exactly the existing RAF must be queued"); const callback = raf; raf = null; callback(now); },
    expire() { assert.ok(timer); const callback = timer; timer = null; callback(); },
    active() { return { raf: Boolean(raf), timer: Boolean(timer), timeoutMs }; }
  };
}
const args = { participantId: "private-id", parkedRoot: { x: 1, y: 2, z: 3 }, previousPoseSeq: 7, timeoutMs: 15000 };

test("release success waits twice the playback delay and all 16 settling frames; saves before returning", async () => clock(async c => {
  const pending = observeReleasedAvatar(args);
  c.tick(100); c.tick(119);
  for (let i = 0; i < 15; i++) c.tick(120 + i);
  assert.equal(c.active().raf, true);
  c.tick(135);
  const result = await pending;
  let saved: ReleaseEvidence | undefined;
  const pose = await finishReleasedAvatar(result, async evidence => { saved = structuredClone(evidence); });
  assert.equal(saved!.last!.settlingFrames, 16);
  assert.equal(saved!.last!.rafCount, 18);
  assert.equal(saved!.last!.readySince, 100);
  assert.deepEqual(pose, { receivedRoot: args.parkedRoot, lastPoseSeq: 8, playbackDelayMs: 10, settlingFrames: 16, stableMs: 35 });
  assert.deepEqual(c.active(), { raf: false, timer: false, timeoutMs: 15000 });
}));

for (const reason of ["staleSeq", "wrongRoot", "exact02m", "nonfiniteDelay", "noVisual", "noPose"] as const) {
  test(`release ${reason} never settles and timeout retains original last fields`, async () => clock(async c => {
    if (reason === "staleSeq") c.transport.lastPoseSeq = 7;
    if (reason === "wrongRoot") c.remote.root.z += 0.03;
    const input = reason === "exact02m" ? { ...args, parkedRoot: { ...args.parkedRoot, x: 0 } } : args;
    if (reason === "exact02m") c.remote.root.x = 0.02;
    if (reason === "nonfiniteDelay") c.transport.playbackDelayMs = NaN;
    if (reason === "noVisual") c.remote.hasVisualEntity = false;
    if (reason === "noPose") c.transport.hasPoseFrame = false;
    const pending = observeReleasedAvatar(input);
    for (let i = 0; i < 40; i++) c.tick(100 + i * 10);
    c.expire();
    const result = await pending;
    assert.equal(result.evidence.last!.settlingFrames, 0);
    assert.equal(result.evidence.last!.lastPoseSeq, c.transport.lastPoseSeq);
    assert.deepEqual(result.evidence.last!.receivedRoot, { x: c.remote.root.x, y: 2, z: c.remote.root.z });
    assert.equal(result.evidence.last!.playbackDelayMs, reason === "nonfiniteDelay" ? null : 10);
    assert.deepEqual(result.evidence.parkedRoot, input.parkedRoot);
    assert.equal(result.evidence.previousPoseSeq, 7);
    assert.equal(result.evidence.timeoutMs, 15000);
    assert.equal(result.evidence.trail.length, 32);
    assert.equal(result.evidence.trail[0]!.rafCount, 9);
    assert.equal(result.evidence.last!.rafCount, 40);
    assert.equal(result.evidence.last!.now, 490);
    assert.doesNotMatch(JSON.stringify(result), /private|token|url|secret|raw-scene|participantId/);
    let saved: ReleaseEvidence | undefined;
    await assert.rejects(finishReleasedAvatar(result, async evidence => {
      saved = structuredClone(evidence);
    }), /released_avatar_pose_not_settled_within_release_budget/);
    assert.deepEqual(saved, result.evidence, "original evidence is actually saved before rethrow");
    await assert.rejects(finishReleasedAvatar(result, async () => { throw new Error("attachment_failed"); }),
      /released_avatar_pose_not_settled_within_release_budget/);
    assert.deepEqual(c.active(), { raf: false, timer: false, timeoutMs: 15000 });
  }));
}

test("release reset clears both stable time and frame count; 15 frames cannot pass", async () => clock(async c => {
  const pending = observeReleasedAvatar(args);
  c.tick(100);
  for (let i = 0; i < 15; i++) c.tick(120 + i);
  c.transport.lastPoseSeq = 7; c.tick(200);
  c.transport.lastPoseSeq = 9; c.tick(300);
  for (let i = 0; i < 15; i++) c.tick(320 + i);
  c.expire();
  const { evidence, error } = await pending;
  assert.equal(error, "released_avatar_pose_not_settled_within_release_budget");
  assert.equal(evidence.last!.settlingFrames, 15);
  assert.equal(evidence.last!.readySince, 300);
  assert.equal(evidence.trail.find(sample => sample.now === 200)!.settlingFrames, 0);
  assert.equal(evidence.trail.find(sample => sample.now === 200)!.readySince, null);
}));

test("release timeout before first RAF saves null last and an empty trail", async () => clock(async c => {
  const pending = observeReleasedAvatar(args);
  c.expire();
  const result = await pending;
  assert.equal(result.evidence.last, null);
  assert.deepEqual(result.evidence.trail, []);
  assert.ok(Number.isFinite(result.evidence.startedAt));
  assert.ok(result.evidence.finishedAt >= result.evidence.startedAt);
}));

test("release trail copies root numbers, not mutable remote objects", async () => clock(async c => {
  const pending = observeReleasedAvatar(args);
  c.tick(100);
  c.remote.root.x = 99; c.transport.lastPoseSeq = 9;
  c.tick(120); c.expire();
  const { evidence } = await pending;
  assert.deepEqual(evidence.trail[0]!.receivedRoot, args.parkedRoot);
  assert.equal(evidence.trail[0]!.lastPoseSeq, 8);
  assert.equal(evidence.last!.receivedRoot!.x, 99);
  assert.equal(evidence.last!.lastPoseSeq, 9);
}));

test("release function survives page.evaluate-style serialization without module captures", async () => {
  const c = makeClock();
  const evaluate: typeof observeReleasedAvatar = runInNewContext(`(${observeReleasedAvatar.toString()})`, {
    window: c.window, performance, requestAnimationFrame: c.request, cancelAnimationFrame: c.cancel
  });
  const pending = evaluate(args);
  c.tick(100); c.expire();
  const result = await pending;
  assert.equal(result.evidence.last!.rafCount, 1);
  assert.equal(result.error, "released_avatar_pose_not_settled_within_release_budget");
});
