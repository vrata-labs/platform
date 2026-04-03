import test from "node:test";
import assert from "node:assert/strict";

import { createAvatarPoseBuffer, pushAvatarPoseFrame, sampleAvatarPoseBuffer } from "./avatar-pose-buffer.js";

function createFrame(seq: number, sentAtMs: number) {
  return {
    seq,
    sentAtMs,
    flags: 0,
    root: { x: seq, y: 0, z: seq, yaw: 0, vx: 0, vz: 0 },
    head: { x: seq, y: 1.6, z: seq, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: seq, y: 1.2, z: seq, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: seq, y: 1.2, z: seq, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  };
}

test("pushAvatarPoseFrame rejects stale and reordered frames", () => {
  const buffer = createAvatarPoseBuffer();
  assert.equal(pushAvatarPoseFrame(buffer, createFrame(2, 200), 200).accepted, true);
  assert.equal(pushAvatarPoseFrame(buffer, createFrame(1, 100), 200).reason, "reorder");
  assert.equal(pushAvatarPoseFrame(buffer, createFrame(2, 200), 200).reason, "stale");
  assert.equal(buffer.droppedReorderCount, 1);
  assert.equal(buffer.droppedStaleCount, 1);
});

test("sampleAvatarPoseBuffer returns surrounding frames for interpolation", () => {
  const buffer = createAvatarPoseBuffer();
  pushAvatarPoseFrame(buffer, createFrame(1, 100), 100);
  pushAvatarPoseFrame(buffer, createFrame(2, 200), 200);
  pushAvatarPoseFrame(buffer, createFrame(3, 300), 300);

  const sample = sampleAvatarPoseBuffer(buffer, 250);
  assert.equal(sample.previous?.seq, 2);
  assert.equal(sample.next?.seq, 3);
  assert.equal(sample.latest?.seq, 3);
});
