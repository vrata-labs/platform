import test from "node:test";
import assert from "node:assert/strict";

import { projectMovementToWorld } from "./movement.js";

test("projectMovementToWorld keeps forward aligned with default camera forward", () => {
  const projected = projectMovementToWorld({ x: 0, z: -1 }, { x: 0, z: -1 });
  assert.deepEqual(projected, { x: 0, z: -1 });
});

test("projectMovementToWorld maps forward to camera facing right", () => {
  const projected = projectMovementToWorld({ x: 0, z: -1 }, { x: 1, z: 0 });
  assert.deepEqual(projected, { x: 1, z: 0 });
});

test("projectMovementToWorld maps strafe right using current camera basis", () => {
  const projected = projectMovementToWorld({ x: 1, z: 0 }, { x: 0, z: -1 });
  assert.deepEqual(projected, { x: 1, z: 0 });
});
