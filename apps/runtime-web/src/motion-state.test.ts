import test from "node:test";
import assert from "node:assert/strict";

import { createMotionTrack, pushMotionSample, sampleMotion } from "./motion-state.js";

test("sampleMotion interpolates between buffered samples", () => {
  let track = createMotionTrack();
  track = pushMotionSample(track, { x: 0, z: 0, capturedAtMs: 1000 });
  track = pushMotionSample(track, { x: 10, z: 20, capturedAtMs: 2000 });

  assert.deepEqual(sampleMotion(track, 1500), {
    x: 5,
    z: 10,
    capturedAtMs: 1500
  });
});

test("sampleMotion clamps to newest sample after buffer end", () => {
  let track = createMotionTrack();
  track = pushMotionSample(track, { x: 3, z: 4, capturedAtMs: 1000 });
  track = pushMotionSample(track, { x: 7, z: 8, capturedAtMs: 1400 });

  assert.deepEqual(sampleMotion(track, 2000), {
    x: 7,
    z: 8,
    capturedAtMs: 1400
  });
});

test("pushMotionSample replaces matching timestamps instead of duplicating them", () => {
  let track = createMotionTrack();
  track = pushMotionSample(track, { x: 1, z: 2, capturedAtMs: 1000 });
  track = pushMotionSample(track, { x: 5, z: 6, capturedAtMs: 1000 });

  assert.equal(track.samples.length, 1);
  assert.deepEqual(track.samples[0], { x: 5, z: 6, capturedAtMs: 1000 });
});
