import test from "node:test";
import assert from "node:assert/strict";

import { computeAvatarAnimationPose, selectAvatarAnimationClip } from "./avatar-animation.js";

test("selectAvatarAnimationClip returns matching locomotion clip when available", () => {
  assert.deepEqual(
    selectAvatarAnimationClip({
      locomotionState: "walk",
      availableClips: ["idle", "walk", "turn"]
    }),
    { clip: "walk", fallback: false }
  );
});

test("selectAvatarAnimationClip falls back to idle when locomotion clip missing", () => {
  assert.deepEqual(
    selectAvatarAnimationClip({
      locomotionState: "strafe",
      availableClips: ["idle", "walk"]
    }),
    { clip: "idle", fallback: true }
  );
});

test("selectAvatarAnimationClip falls back to first available clip when idle missing", () => {
  assert.deepEqual(
    selectAvatarAnimationClip({
      locomotionState: "turn",
      availableClips: ["gesture-wave"]
    }),
    { clip: "gesture-wave", fallback: true }
  );
});

test("computeAvatarAnimationPose returns stronger bob for walk than idle", () => {
  const idlePose = computeAvatarAnimationPose({ clip: "idle", elapsedSeconds: 0.25, speed: 0.1, turnRate: 0 });
  const walkPose = computeAvatarAnimationPose({ clip: "walk", elapsedSeconds: 0.25, speed: 1, turnRate: 0 });

  assert.equal(walkPose.bodyBob > idlePose.bodyBob, true);
  assert.equal(Math.abs(walkPose.leftHandForward) > Math.abs(idlePose.leftHandForward), true);
});

test("computeAvatarAnimationPose gives lateral lean for strafe", () => {
  const pose = computeAvatarAnimationPose({ clip: "strafe", elapsedSeconds: 0.4, speed: 1, turnRate: 0 });
  assert.equal(Math.abs(pose.bodyRoll) > 0.01, true);
  assert.equal(pose.leftHandForward, 0.06);
  assert.equal(pose.rightHandForward, 0.06);
});

test("computeAvatarAnimationPose uses turn influence for turn clip", () => {
  const pose = computeAvatarAnimationPose({ clip: "turn", elapsedSeconds: 0.2, speed: 0, turnRate: 1 });
  assert.equal(pose.bodyRoll > 0, true);
  assert.equal(pose.headTilt > 0, true);
});
