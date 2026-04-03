import test from "node:test";
import assert from "node:assert/strict";

import { serializeCompactPoseFrame, serializeReliableAvatarState } from "./avatar-snapshot-codec.js";
import type { LocalAvatarSnapshotV1 } from "./avatar-types.js";

function createSnapshot(): LocalAvatarSnapshotV1 {
  return {
    schemaVersion: 1,
    avatarId: "preset-01",
    inputMode: "desktop",
    visibilityState: "full-body",
    controllerProfile: "desktop_no_controllers",
    locomotionState: "walk",
    animationState: "idle",
    fallbackReason: null,
    root: { x: 1, y: 0, z: 2, yaw: 0.5 },
    head: { x: 0, y: 1.58, z: 0 },
    leftHand: { x: -0.2, y: 1.1, z: 0.1, visible: true },
    rightHand: { x: 0.2, y: 1.1, z: 0.1, visible: true },
    updatedAt: new Date(0).toISOString()
  };
}

test("serializeReliableAvatarState maps snapshot into reliable avatar state", () => {
  const reliable = serializeReliableAvatarState({
    participantId: "p-1",
    snapshot: createSnapshot(),
    muted: true,
    audioActive: false
  });

  assert.equal(reliable.participantId, "p-1");
  assert.equal(reliable.avatarId, "preset-01");
  assert.equal(reliable.inputMode, "desktop");
  assert.equal(reliable.muted, true);
});

test("serializeCompactPoseFrame maps snapshot into transport-ready pose frame", () => {
  const frame = serializeCompactPoseFrame({
    seq: 7,
    sentAtMs: 1234,
    snapshot: createSnapshot()
  });

  assert.equal(frame.seq, 7);
  assert.equal(frame.root.x, 1);
  assert.equal(frame.root.vz, 1);
  assert.equal(frame.locomotion.mode, 1);
  assert.equal(frame.leftHand.gesture, 1);
  assert.equal(frame.rightHand.gesture, 1);
  assert.equal(Number(frame.head.x.toFixed(3)), Number((1 + Math.sin(0.5) * 0).toFixed(3)));
  assert.equal(Number(frame.head.z.toFixed(3)), Number((2 + Math.cos(0.5) * 0).toFixed(3)));
});

test("serializeCompactPoseFrame converts local avatar points into world space", () => {
  const snapshot = createSnapshot();
  snapshot.root = { x: 3, y: 0, z: 4, yaw: Math.PI / 2 };
  snapshot.head = { x: 0.2, y: 1.58, z: 0 };
  snapshot.leftHand = { x: -0.3, y: 1.1, z: 0.15, visible: true };

  const frame = serializeCompactPoseFrame({
    seq: 9,
    sentAtMs: 100,
    snapshot
  });

  assert.equal(Number(frame.head.x.toFixed(2)), 3);
  assert.equal(Number(frame.head.z.toFixed(2)), 4.2);
  assert.equal(Number(frame.leftHand.x.toFixed(2)), 2.85);
  assert.equal(Number(frame.leftHand.z.toFixed(2)), 3.7);
});

test("serializeCompactPoseFrame encodes fallback and hidden hands into flags", () => {
  const snapshot = createSnapshot();
  snapshot.visibilityState = "hands-only";
  snapshot.fallbackReason = "xr_input_partial_fallback:left_only";
  snapshot.rightHand.visible = false;

  const frame = serializeCompactPoseFrame({
    seq: 8,
    sentAtMs: 4321,
    snapshot
  });

  assert.equal((frame.flags & 1) === 1, true);
  assert.equal((frame.flags & 2) === 0, true);
  assert.equal((frame.flags & 4) === 4, true);
  assert.equal((frame.flags & 8) === 8, true);
});
