import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { collectLocalAvatarHandDebug, resolveLocalAvatarHandTargets } from "./avatar-xr-hands.js";

function spatial(x: number, y: number, z: number) {
  const object = new THREE.Object3D();
  object.position.set(x, y, z);
  object.updateMatrixWorld(true);
  return object;
}

test("resolveLocalAvatarHandTargets prefers grip positions over controller rays", () => {
  const result = resolveLocalAvatarHandTargets({
    presenting: true,
    inputSources: [{ handedness: "left" }, { handedness: "right" }],
    grips: [spatial(-0.2, 1.2, 0.3), spatial(0.2, 1.2, 0.3)],
    controllers: [spatial(-1, 5, 9), spatial(1, 5, 9)]
  });

  assert.deepEqual(result.leftHand, { x: -0.2, y: 1.2, z: 0.3 });
  assert.deepEqual(result.rightHand, { x: 0.2, y: 1.2, z: 0.3 });
});

test("resolveLocalAvatarHandTargets falls back to controller when grip missing", () => {
  const result = resolveLocalAvatarHandTargets({
    presenting: true,
    inputSources: [{ handedness: "left" }],
    grips: [null],
    controllers: [spatial(-0.25, 1.1, 0.15)]
  });

  assert.deepEqual(result.leftHand, { x: -0.25, y: 1.1, z: 0.15 });
  assert.equal(result.rightHand, null);
});

test("resolveLocalAvatarHandTargets keeps lateral spread after strafe-like world shift", () => {
  const leftGrip = spatial(-0.35, 1.2, 0.25);
  const rightGrip = spatial(0.35, 1.2, 0.25);
  leftGrip.position.x += 2;
  rightGrip.position.x += 2;
  leftGrip.updateMatrixWorld(true);
  rightGrip.updateMatrixWorld(true);

  const result = resolveLocalAvatarHandTargets({
    presenting: true,
    inputSources: [{ handedness: "left" }, { handedness: "right" }],
    grips: [leftGrip, rightGrip],
    controllers: [null, null]
  });

  assert.equal(result.leftHand !== null && result.rightHand !== null, true);
  assert.equal((result.rightHand!.x - result.leftHand!.x) > 0.6, true);
});

test("collectLocalAvatarHandDebug exposes raw grip and controller positions", () => {
  const debug = collectLocalAvatarHandDebug({
    inputSources: [{ handedness: "left" }, { handedness: "right" }],
    grips: [spatial(-0.2, 1.2, 0.3), spatial(0.2, 1.2, 0.3)],
    controllers: [spatial(-0.4, 1.4, 0.6), spatial(0.4, 1.4, 0.6)]
  });

  assert.deepEqual(debug.leftGrip, { x: -0.2, y: 1.2, z: 0.3 });
  assert.deepEqual(debug.leftController, { x: -0.4, y: 1.4, z: 0.6 });
  assert.deepEqual(debug.leftResolved, { x: -0.2, y: 1.2, z: 0.3 });
});
