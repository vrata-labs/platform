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
