import test from "node:test";
import assert from "node:assert/strict";

import { selectAvatarAnimationClip } from "./avatar-animation.js";

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
