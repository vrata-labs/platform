import test from "node:test";
import assert from "node:assert/strict";

import { resolveXrInputIntents } from "./input-intents.js";

test("xr ray intent suppresses diagonal snap-turn", () => {
  const resolved = resolveXrInputIntents({
    axes: { moveX: 0, moveY: 0, turnX: -0.8, turnY: -0.6 },
    triggerPressed: false,
    rayVisibleLatched: true
  });

  assert.equal(resolved.intents.aimRay, true);
  assert.equal(resolved.intents.snapTurn.axis, 0);
});

test("xr horizontal stick remains snap-turn when ray intent is inactive", () => {
  const resolved = resolveXrInputIntents({
    axes: { moveX: 0, moveY: 0, turnX: -0.8, turnY: -0.1 },
    triggerPressed: false,
    rayVisibleLatched: false
  });

  assert.equal(resolved.intents.aimRay, false);
  assert.equal(resolved.intents.snapTurn.axis, -0.8);
});

test("xr trigger becomes confirm interaction intent without side effects", () => {
  const resolved = resolveXrInputIntents({
    axes: { moveX: 0, moveY: 0, turnX: 0, turnY: 0 },
    triggerPressed: true,
    rayVisibleLatched: false
  });

  assert.equal(resolved.intents.confirmInteraction, true);
  assert.deepEqual(resolved.intents.move, { x: 0, z: 0 });
});
