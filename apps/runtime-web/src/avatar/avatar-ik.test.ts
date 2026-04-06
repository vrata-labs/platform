import test from "node:test";
import assert from "node:assert/strict";

import { resolveAvatarBodyRefinement, solveUpperBodyPose } from "./avatar-ik.js";

test("solveUpperBodyPose clamps head and hand positions", () => {
  const result = solveUpperBodyPose({
    root: { x: 0, y: 0, z: 0 },
    head: { x: 2, y: 3, z: -2 },
    leftHand: { x: -2, y: 5, z: -2 },
    rightHand: { x: 2, y: -1, z: 2 },
    inputMode: "vr-controller"
  });

  assert.deepEqual(result.headLocal, { x: 0.25, y: 1.9, z: -0.25 });
  assert.deepEqual(result.leftHandLocal, { x: -0.75, y: 1.75, z: -0.6 });
  assert.deepEqual(result.rightHandLocal, { x: 0.75, y: 0.65, z: 0.45 });
  assert.equal(result.solveState, "active");
});

test("solveUpperBodyPose uses fallback hands when controllers missing", () => {
  const result = solveUpperBodyPose({
    root: { x: 0, y: 0, z: 0 },
    head: { x: 0, y: 1.6, z: 0 },
    inputMode: "desktop"
  });

  assert.equal(result.solveState, "fallback");
  assert.equal(result.leftHandLocal.x < 0, true);
  assert.equal(result.rightHandLocal.x > 0, true);
});

test("solveUpperBodyPose respects mobile pose profile fallback", () => {
  const result = solveUpperBodyPose({
    root: { x: 0, y: 0, z: 0 },
    head: { x: 0, y: 1.5, z: 0 },
    inputMode: "mobile",
    poseProfile: {
      headHeight: 1.5,
      handHeight: 1.02,
      handForward: 0.04,
      handSpread: 0.22
    }
  });

  assert.equal(result.leftHandLocal.x, -0.22);
  assert.equal(result.rightHandLocal.x, 0.22);
  assert.equal(result.leftHandLocal.z, 0.04);
});

test("solveUpperBodyPose rotates world hand positions into local avatar yaw space", () => {
  const result = solveUpperBodyPose({
    root: { x: 0, y: 0, z: 0 },
    head: { x: 0, y: 1.6, z: 0 },
    leftHand: { x: 0.2, y: 1.2, z: 0 },
    rightHand: { x: -0.2, y: 1.2, z: 0 },
    inputMode: "vr-controller",
    rootYaw: Math.PI / 2
  });

  assert.equal(Math.round(result.leftHandLocal.z * 100) / 100, -0.2);
  assert.equal(Math.round(result.rightHandLocal.z * 100) / 100, 0.2);
});

test("resolveAvatarBodyRefinement adds forward lean for walk and turn bias for turn", () => {
  const walk = resolveAvatarBodyRefinement({
    locomotionState: "walk",
    speed: 1,
    turnRate: 0,
    inputMode: "desktop"
  });
  const turn = resolveAvatarBodyRefinement({
    locomotionState: "turn",
    speed: 0,
    turnRate: 1,
    inputMode: "desktop"
  });

  assert.equal(walk.torsoPitch > 0, true);
  assert.equal(walk.pelvisOffsetY > 0, true);
  assert.equal(turn.torsoRoll > 0, true);
  assert.equal(turn.headTiltBias > 0, true);
});

test("resolveAvatarBodyRefinement reduces upper-body influence for tracked vr", () => {
  const desktop = resolveAvatarBodyRefinement({
    locomotionState: "walk",
    speed: 1,
    turnRate: 0,
    inputMode: "desktop",
    xrPresenting: false
  });
  const vrTracked = resolveAvatarBodyRefinement({
    locomotionState: "walk",
    speed: 1,
    turnRate: 0,
    inputMode: "vr-controller",
    xrPresenting: true
  });

  assert.equal(Math.abs(vrTracked.torsoPitch) < Math.abs(desktop.torsoPitch), true);
  assert.equal(Math.abs(vrTracked.headTiltBias) < Math.abs(desktop.headTiltBias), true);
});

test("resolveAvatarBodyRefinement keeps strafe torso roll neutral", () => {
  const strafe = resolveAvatarBodyRefinement({
    locomotionState: "strafe",
    speed: 1,
    turnRate: 0,
    inputMode: "desktop"
  });

  assert.equal(strafe.torsoRoll, 0);
  assert.equal(strafe.lowerBodyRoll, 0);
  assert.equal(strafe.headTiltBias, 0);
});
