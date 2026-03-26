import test from "node:test";
import assert from "node:assert/strict";

import { applySnapTurn, computeKeyboardDirection, sanitizeXrAxes, stepFlatMovement } from "./movement.js";

test("computeKeyboardDirection supports arrows and WASD", () => {
  assert.deepEqual(computeKeyboardDirection({ KeyW: true, KeyD: true }), { x: 1, z: -1 });
  assert.deepEqual(computeKeyboardDirection({ ArrowLeft: true }), { x: -1, z: 0 });
});

test("stepFlatMovement normalizes diagonal movement", () => {
  const next = stepFlatMovement({ x: 0, z: 0 }, { x: 1, z: 1 }, 2, 1);
  assert.equal(Math.round(next.x * 1000) / 1000, 1.414);
  assert.equal(Math.round(next.z * 1000) / 1000, 1.414);
});

test("applySnapTurn rotates in fixed increments with cooldown", () => {
  const turned = applySnapTurn({ angle: 0, cooldownSeconds: 0 }, 0.8, 0.016);
  assert.equal(Math.round(turned.angle * 1000) / 1000, Math.round((-Math.PI / 6) * 1000) / 1000);

  const cooling = applySnapTurn(turned, 0.8, 0.016);
  assert.equal(cooling.angle, turned.angle);
  assert.ok(cooling.cooldownSeconds > 0);
});

test("sanitizeXrAxes applies deadzone", () => {
  assert.deepEqual(sanitizeXrAxes({ moveX: 0.1, moveY: 0.4, turnX: -0.1 }), {
    moveX: 0,
    moveY: 0.4,
    turnX: 0
  });
});
