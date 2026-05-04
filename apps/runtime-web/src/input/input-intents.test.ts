import test from "node:test";
import assert from "node:assert/strict";

import { resolveDesktopTouchInputIntents, resolveTouchMoveVector, resolveXrInputIntents } from "./input-intents.js";

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

test("desktop input intents convert keyboard state into move intent", () => {
  const intents = resolveDesktopTouchInputIntents({
    keys: { KeyW: true, KeyD: true },
    touchActive: false,
    touchVector: { x: 0, z: 0 }
  });

  assert.equal(intents.source, "desktop");
  assert.deepEqual(intents.move, { x: 1, z: -1 });
  assert.equal(intents.aimRay, false);
  assert.equal(intents.confirmInteraction, false);
});

test("touch input intents combine touch vector with keyboard state", () => {
  const intents = resolveDesktopTouchInputIntents({
    keys: { ArrowLeft: true },
    touchActive: true,
    touchVector: { x: 0.25, z: 0.5 }
  });

  assert.equal(intents.source, "touch");
  assert.deepEqual(intents.move, { x: -0.75, z: 0.5 });
});

test("touch move vector normalizes viewport position and clamps edges", () => {
  assert.deepEqual(resolveTouchMoveVector({
    clientX: 75,
    clientY: 25,
    viewportWidth: 100,
    viewportHeight: 100
  }), { x: 0.5, z: -0.5 });

  assert.deepEqual(resolveTouchMoveVector({
    clientX: 500,
    clientY: -200,
    viewportWidth: 100,
    viewportHeight: 100
  }), { x: 1, z: -1 });
});
