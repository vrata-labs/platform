import test from "node:test";
import assert from "node:assert/strict";

import { isCompactPoseFrame, parseCompactPoseFrame } from "./avatar-pose-frame.js";

test("parseCompactPoseFrame accepts valid payload", () => {
  const frame = parseCompactPoseFrame({
    seq: 1,
    sentAtMs: 100,
    flags: 0,
    root: { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    head: { x: 0, y: 1.6, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    rightHand: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  });

  assert.equal(frame.seq, 1);
});

test("isCompactPoseFrame rejects invalid payload", () => {
  assert.equal(isCompactPoseFrame({ seq: 1 }), false);
});
