import test from "node:test";
import assert from "node:assert/strict";

import { resolveAvatarXrInput } from "./avatar-xr-input.js";

test("resolveAvatarXrInput uses left for move and right for turn", () => {
  const result = resolveAvatarXrInput([
    { handedness: "left", gamepad: { axes: [0.1, 0.2, 0.3, 0.4] } },
    { handedness: "right", gamepad: { axes: [0.5, 0.6, 0.7, 0.8] } }
  ]);

  assert.deepEqual(result.axes, { moveX: 0.3, moveY: 0.4, turnX: 0.7, turnY: 0.8 });
  assert.equal(result.profile, "dual");
});

test("resolveAvatarXrInput reports left-only profile", () => {
  const result = resolveAvatarXrInput([
    { handedness: "left", gamepad: { axes: [0.1, 0.2, 0.3, 0.4] } }
  ]);

  assert.equal(result.profile, "left-only");
  assert.equal(result.axes.moveX, 0.3);
  assert.equal(result.axes.turnX, 0);
  assert.equal(result.axes.turnY, 0);
});

test("resolveAvatarXrInput prefers the active stick pair when axes 0/1 carry movement", () => {
  const result = resolveAvatarXrInput([
    { handedness: "left", gamepad: { axes: [0.6, -0.8, 0, 0] } },
    { handedness: "right", gamepad: { axes: [0.4, 0, 0, 0] } }
  ]);

  assert.deepEqual(result.axes, { moveX: 0.6, moveY: -0.8, turnX: 0.4, turnY: 0 });
});

test("resolveAvatarXrInput reports none when controllers missing", () => {
  const result = resolveAvatarXrInput([]);
  assert.equal(result.profile, "none");
  assert.deepEqual(result.axes, { moveX: 0, moveY: 0, turnX: 0, turnY: 0 });
});
