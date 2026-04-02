import test from "node:test";
import assert from "node:assert/strict";

import { solveUpperBodyPose } from "./avatar-ik.js";

test("solveUpperBodyPose clamps head and hand positions", () => {
  const result = solveUpperBodyPose({
    root: { x: 0, y: 0, z: 0 },
    head: { x: 2, y: 3, z: -2 },
    leftHand: { x: -2, y: 5, z: -2 },
    rightHand: { x: 2, y: -1, z: 2 },
    inputMode: "vr-controller"
  });

  assert.deepEqual(result.headLocal, { x: 0.25, y: 1.9, z: -0.25 });
  assert.deepEqual(result.leftHandLocal, { x: -0.75, y: 1.75, z: -0.6 });
  assert.deepEqual(result.rightHandLocal, { x: 0.75, y: 0.65, z: 0.45 });
  assert.equal(result.solveState, "active");
});

test("solveUpperBodyPose uses fallback hands when controllers missing", () => {
  const result = solveUpperBodyPose({
    root: { x: 0, y: 0, z: 0 },
    head: { x: 0, y: 1.6, z: 0 },
    inputMode: "desktop"
  });

  assert.equal(result.solveState, "fallback");
  assert.equal(result.leftHandLocal.x < 0, true);
  assert.equal(result.rightHandLocal.x > 0, true);
});
