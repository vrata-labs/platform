import test from "node:test";
import assert from "node:assert/strict";

import { applySnapTurn, projectMovementToWorld, resolveXrSnapTurnAxis } from "./movement.js";

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

test("applySnapTurn fires when xr turn axis exceeds runtime threshold", () => {
  const next = applySnapTurn({ angle: 0, cooldownSeconds: 0 }, -0.6, 0.016);
  assert.notEqual(next.angle, 0);
  assert.equal(next.cooldownSeconds > 0, true);
});

test("applySnapTurn maps right-stick positive X to a right turn", () => {
  const next = applySnapTurn({ angle: 0, cooldownSeconds: 0 }, 0.6, 0.016);
  assert.equal(Number(next.angle.toFixed(3)), Number((-Math.PI / 6).toFixed(3)));
});

test("applySnapTurn maps right-stick negative X to a left turn", () => {
  const next = applySnapTurn({ angle: 0, cooldownSeconds: 0 }, -0.6, 0.016);
  assert.equal(Number(next.angle.toFixed(3)), Number((Math.PI / 6).toFixed(3)));
});

test("applySnapTurn ignores horizontal jitter under runtime threshold", () => {
  const next = applySnapTurn({ angle: 0, cooldownSeconds: 0 }, -0.5, 0.016);
  assert.equal(next.angle, 0);
  assert.equal(next.cooldownSeconds, 0);
});

test("applySnapTurn respects cooldown even when xr turn axis stays high", () => {
  const next = applySnapTurn({ angle: 0, cooldownSeconds: 0.2 }, -1, 0.016);
  assert.equal(next.angle, 0);
  assert.equal(next.cooldownSeconds < 0.2, true);
});

test("resolveXrSnapTurnAxis suppresses horizontal turn when forward ray intent dominates", () => {
  assert.equal(resolveXrSnapTurnAxis(-0.19, -0.98), 0);
});

test("resolveXrSnapTurnAxis suppresses horizontal turn whenever ray intent is active", () => {
  assert.equal(resolveXrSnapTurnAxis(-0.8, -0.6), 0);
});

test("resolveXrSnapTurnAxis keeps horizontal turn when horizontal input dominates", () => {
  assert.equal(resolveXrSnapTurnAxis(-0.8, -0.1), -0.8);
});
