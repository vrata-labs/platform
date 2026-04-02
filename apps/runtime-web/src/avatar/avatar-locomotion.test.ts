import test from "node:test";
import assert from "node:assert/strict";

import { resolveAvatarLocomotion } from "./avatar-locomotion.js";

test("resolveAvatarLocomotion returns idle for tiny movement", () => {
  assert.equal(resolveAvatarLocomotion({ moveX: 0.01, moveZ: 0.01, turnRate: 0 }).state, "idle");
});

test("resolveAvatarLocomotion returns walk for forward motion", () => {
  assert.equal(resolveAvatarLocomotion({ moveX: 0, moveZ: 1, turnRate: 0 }).state, "walk");
});

test("resolveAvatarLocomotion returns strafe for lateral motion", () => {
  assert.equal(resolveAvatarLocomotion({ moveX: 1, moveZ: 0.2, turnRate: 0 }).state, "strafe");
});

test("resolveAvatarLocomotion returns backpedal for backward motion", () => {
  assert.equal(resolveAvatarLocomotion({ moveX: 0.1, moveZ: -1, turnRate: 0 }).state, "backpedal");
});

test("resolveAvatarLocomotion returns turn for stationary snap turn", () => {
  assert.equal(resolveAvatarLocomotion({ moveX: 0, moveZ: 0, turnRate: 1 }).state, "turn");
});
