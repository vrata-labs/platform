import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { observeSeatedAvatar } from "./seat-occupied-observation.ts";

// Execute the actual page.evaluate function with a manual RAF/timer clock.
function makeClock() {
  let raf: FrameRequestCallback | null = null, timer: (() => void) | null = null;
  const remote = { participantId: "remote", hasVisualEntity: true, root: { x: 1, y: -0.4, z: 2 },
    body: { x: 1, y: 0.52, z: 2 }, renderedBody: { x: 5, y: 1.3, z: 5, visible: true } };
  const transport = { participantId: "remote", hasPoseFrame: true, playbackDelayMs: 10 };
  return {
    remote, transport,
    window: { __VRATA_DEBUG__: { remoteParticipants: [remote], remoteAvatarParticipants: [transport] },
      setTimeout: (callback: () => void) => { timer = callback; return 2; },
      clearTimeout: () => { timer = null; } },
    request: (callback: FrameRequestCallback) => { raf = callback; return 1; },
    cancel: () => { raf = null; },
    tick(now: number) { assert.ok(raf, "the observation RAF must be queued"); const callback = raf; raf = null; callback(now); },
    expire() { assert.ok(timer); const callback = timer; timer = null; callback(); },
    active() { return { raf: Boolean(raf), timer: Boolean(timer) }; }
  };
}
async function run(body: (c: ReturnType<typeof makeClock>, observe: typeof observeSeatedAvatar) => Promise<void>) {
  const c = makeClock();
  const observe: typeof observeSeatedAvatar = runInNewContext(`(${observeSeatedAvatar.toString()})`, {
    window: c.window, performance, requestAnimationFrame: c.request, cancelAnimationFrame: c.cancel
  });
  await body(c, observe);
}
const args = { participantId: "remote", seatedRoot: { x: 1, y: -0.4, z: 2 }, timeoutMs: 15000, maxLagFrames: 3, maxLagMs: 50 };

test("seated avatar is accepted only when the drawn body reaches the received seated body", () => run(async (c, observe) => {
  const pending = observe(args);
  c.tick(100); c.tick(110);
  c.remote.renderedBody = { x: 1.03, y: 0.5, z: 2.02, visible: true };
  c.tick(125);
  const { error, evidence } = await pending;
  assert.equal(error, null);
  assert.equal(evidence.drawnAt, 125);
  assert.equal(evidence.last!.receivedSince, 100);
  assert.deepEqual(c.active(), { raf: false, timer: false });
}));

test("an invisible or detached body at the seat is not an occupied chair", () => run(async (c, observe) => {
  const pending = observe(args);
  c.remote.renderedBody = { x: 1, y: 0.52, z: 2, visible: false };
  c.tick(100); c.tick(110);
  c.remote.renderedBody = null as never;
  c.tick(120);
  c.expire();
  const { error, evidence } = await pending;
  assert.equal(error, "seated_avatar_not_drawn_within_budget");
  assert.equal(evidence.drawnAt, null);
}));

test("a received standing pose or missing pose frame never starts the lag clock", () => run(async (c, observe) => {
  c.remote.root = { x: 1.03, y: -0.4, z: 2 };
  const pending = observe(args);
  for (let i = 0; i < 10; i++) c.tick(100 + i * 100);
  c.remote.root = { x: 1, y: -0.4, z: 2 }; c.transport.hasPoseFrame = false;
  for (let i = 0; i < 10; i++) c.tick(1100 + i * 100);
  c.expire();
  const { error, evidence } = await pending;
  assert.equal(error, "seated_avatar_not_drawn_within_budget");
  assert.equal(evidence.last!.receivedSince, null);
  assert.equal(evidence.last!.lagFrames, 0);
}));

test("drawing lag fails only after both the frame and time bounds beyond 2x playback delay", () => run(async (c, observe) => {
  const pending = observe(args);
  c.tick(100);
  // 2x delay = 20 ms of normal playback; then many quick frames stay within 50 ms.
  for (let i = 0; i < 10; i++) c.tick(120 + i * 5);
  assert.equal(c.active().raf, true, "frame count alone must not fail");
  c.tick(171);
  const { error, evidence } = await pending;
  assert.equal(error, "seated_avatar_drawn_late_after_received_pose");
  assert.equal(evidence.last!.lagFrames, 11);
  assert.equal(c.active().timer, false);
}));

test("slow frames alone do not fail before the frame bound", () => run(async (c, observe) => {
  const pending = observe(args);
  c.tick(100); c.tick(1100); c.tick(2100); c.tick(3100);
  assert.equal(c.active().raf, true);
  c.remote.renderedBody = { x: 1, y: 0.52, z: 2, visible: true };
  c.tick(4100);
  assert.equal((await pending).error, null);
}));

test("losing the seated pose resets the lag clock", () => run(async (c, observe) => {
  const pending = observe(args);
  c.tick(100); c.tick(130); c.tick(140);
  c.remote.root = { x: 3, y: 0, z: 3 };
  c.tick(150);
  c.remote.root = { x: 1, y: -0.4, z: 2 };
  c.tick(500);
  c.expire();
  const { evidence } = await pending;
  assert.equal(evidence.trail.find(sample => sample.now === 150)!.receivedSince, null);
  assert.equal(evidence.last!.receivedSince, 500);
  assert.equal(evidence.last!.lagFrames, 0);
}));

test("with a cushion, a body sunk through the seat is not accepted until its bottom rests on the cushion", () => run(async (c, observe) => {
  const pending = observe({ ...args, cushionY: 0.46 });
  // Standing-height capsule lowered with the rig: centre at the target, bottom near the floor.
  c.remote.renderedBody = { x: 1, y: 0.52, z: 2, bottomY: -0.12, visible: true } as never;
  c.tick(100); c.tick(110);
  c.remote.renderedBody = { x: 1, y: 0.52, z: 2, visible: true } as never;
  c.tick(115);
  assert.equal(c.active().raf, true, "a missing bottom must not pass the cushion check");
  c.remote.renderedBody = { x: 1, y: 0.52, z: 2, bottomY: 0.455, visible: true } as never;
  c.tick(120);
  const { error, evidence } = await pending;
  assert.equal(error, null);
  assert.equal(evidence.cushionY, 0.46);
  assert.equal(evidence.drawnAt, 120);
  assert.equal(evidence.trail.find(sample => sample.now === 100)!.renderedBody!.bottomY, -0.12);
}));

test("a sunk body that never reaches the cushion fails on the lag bound", () => run(async (c, observe) => {
  const pending = observe({ ...args, cushionY: 0.46 });
  c.remote.renderedBody = { x: 1, y: 0.52, z: 2, bottomY: 0.3, visible: true } as never;
  c.tick(100);
  for (let i = 0; i < 10; i++) c.tick(120 + i * 5);
  c.tick(171);
  const { error, evidence } = await pending;
  assert.equal(error, "seated_avatar_drawn_late_after_received_pose");
  assert.equal(evidence.drawnAt, null);
}));
