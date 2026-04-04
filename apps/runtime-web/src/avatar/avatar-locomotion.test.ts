import test from "node:test";
import assert from "node:assert/strict";

import {
  mapAvatarLocomotionModeToState,
  resolveAvatarFootPlanting,
  mapAvatarLocomotionStateToMode,
  resolveAvatarFootingCorrection,
  resolveAvatarQualityMode,
  resolveAvatarLocomotion
} from "./avatar-locomotion.js";

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

test("resolveAvatarLocomotion keeps walk during low-speed deceleration hysteresis", () => {
  assert.equal(resolveAvatarLocomotion({ moveX: 0, moveZ: 0.09, turnRate: 0, previousState: "walk" }).state, "walk");
});

test("resolveAvatarLocomotion keeps turn during turn-rate hysteresis", () => {
  assert.equal(resolveAvatarLocomotion({ moveX: 0, moveZ: 0, turnRate: 0.6, previousState: "turn" }).state, "turn");
});

test("resolveAvatarLocomotion keeps strafe when lateral movement remains dominant enough", () => {
  assert.equal(resolveAvatarLocomotion({ moveX: 0.45, moveZ: 0.5, turnRate: 0, previousState: "strafe" }).state, "strafe");
});

test("avatar locomotion mode maps are symmetric", () => {
  assert.equal(mapAvatarLocomotionStateToMode("idle"), 0);
  assert.equal(mapAvatarLocomotionStateToMode("walk"), 1);
  assert.equal(mapAvatarLocomotionStateToMode("strafe"), 2);
  assert.equal(mapAvatarLocomotionStateToMode("backpedal"), 3);
  assert.equal(mapAvatarLocomotionStateToMode("turn"), 4);
  assert.equal(mapAvatarLocomotionModeToState(4), "turn");
  assert.equal(mapAvatarLocomotionModeToState(99), "idle");
});

test("resolveAvatarFootingCorrection activates during low-speed walk transitions", () => {
  const correction = resolveAvatarFootingCorrection({
    locomotionState: "walk",
    speed: 0.1,
    turnRate: 0,
    transitioned: true
  });

  assert.equal(correction.correctionActive, true);
  assert.equal(correction.skatingMetric > 0.18, true);
  assert.equal(correction.lowerBodyBobScale < 1, true);
});

test("resolveAvatarFootingCorrection stays relaxed during stable walk", () => {
  const correction = resolveAvatarFootingCorrection({
    locomotionState: "walk",
    speed: 1,
    turnRate: 0,
    transitioned: false
  });

  assert.equal(correction.correctionActive, false);
  assert.equal(correction.footLockStrength, 0);
  assert.equal(correction.lowerBodyBobScale, 1);
});

test("resolveAvatarQualityMode picks near for close observer and far for distant observer", () => {
  assert.equal(resolveAvatarQualityMode({ distanceToObserver: 2, qualityProfile: "desktop-standard" }), "near");
  assert.equal(resolveAvatarQualityMode({ distanceToObserver: 8, qualityProfile: "desktop-standard" }), "far");
});

test("resolveAvatarFootPlanting activates only for near moving avatars", () => {
  const near = resolveAvatarFootPlanting({
    locomotionState: "walk",
    elapsedSeconds: 0.2,
    speed: 1,
    footLockStrength: 0.2,
    qualityMode: "near"
  });
  const far = resolveAvatarFootPlanting({
    locomotionState: "walk",
    elapsedSeconds: 0.2,
    speed: 1,
    footLockStrength: 0.2,
    qualityMode: "far"
  });

  assert.equal(near.plantingActive, true);
  assert.equal(Math.abs(near.stanceOffsetX) > 0, true);
  assert.equal(far.plantingActive, false);
  assert.equal(far.stanceOffsetX, 0);
});
