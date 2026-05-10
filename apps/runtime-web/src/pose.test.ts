import test from "node:test";
import assert from "node:assert/strict";

import { isStaleSeq, normalizePoseTransform } from "./pose.js";

test("legacy x/y/z transform normalizes to zero orientation", () => {
  assert.deepEqual(normalizePoseTransform({ x: 1, y: 2, z: 3 }), {
    x: 1,
    y: 2,
    z: 3,
    yaw: 0,
    pitch: 0,
    roll: 0
  });
});

test("oriented transform preserves yaw and pitch", () => {
  const normalized = normalizePoseTransform({ x: 1, y: 2, z: 3, yaw: 0.7, pitch: -0.3 });

  assert.equal(normalized.yaw, 0.7);
  assert.equal(normalized.pitch, -0.3);
});

test("sequence helper rejects older updates only", () => {
  assert.equal(isStaleSeq(5, 4), true);
  assert.equal(isStaleSeq(5, 5), false);
  assert.equal(isStaleSeq(5, undefined), false);
});
