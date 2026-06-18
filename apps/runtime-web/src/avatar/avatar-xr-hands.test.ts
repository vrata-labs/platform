import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { collectLocalAvatarHandDebug, createSyntheticLocalAvatarHandFrame, resolveLocalAvatarHandFrame, resolveLocalAvatarHandTargets } from "./avatar-xr-hands.js";

function spatial(x: number, y: number, z: number) {
  const object = new THREE.Object3D();
  object.position.set(x, y, z);
  object.updateMatrixWorld(true);
  return object;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

function assertQuaternionClose(actual: { x: number; y: number; z: number; w: number }, expected: THREE.Quaternion) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
  assert.ok(Math.abs(actual.z - expected.z) < 1e-9);
  assert.ok(Math.abs(actual.w - expected.w) < 1e-9);
}

function frameWithPoses(entries: Array<{
  space: unknown;
  x: number;
  y: number;
  z: number;
  orientation?: { x: number; y: number; z: number; w: number };
}>) {
  return {
    getPose(space: unknown) {
      const found = entries.find((entry) => entry.space === space);
      if (!found) {
        return null;
      }
      return {
        transform: {
          position: { x: found.x, y: found.y, z: found.z },
          ...(found.orientation ? { orientation: found.orientation } : {})
        }
      };
    }
  };
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

test("resolveLocalAvatarHandTargets prefers XRFrame pose spaces over index-mapped grips", () => {
  const leftGripSpace = { id: "left-grip" };
  const rightGripSpace = { id: "right-grip" };
  const result = resolveLocalAvatarHandTargets({
    presenting: true,
    inputSources: [
      { handedness: "left", gripSpace: leftGripSpace },
      { handedness: "right", gripSpace: rightGripSpace }
    ],
    grips: [spatial(10, 10, 10), spatial(-10, 10, 10)],
    controllers: [null, null],
    xrFrame: frameWithPoses([
      { space: leftGripSpace, x: -0.2, y: 1.2, z: 0.3 },
      { space: rightGripSpace, x: 0.2, y: 1.2, z: 0.3 }
    ]),
    referenceSpace: { id: "ref" }
  });

  assert.deepEqual(result.leftHand, { x: -0.2, y: 1.2, z: 0.3 });
  assert.deepEqual(result.rightHand, { x: 0.2, y: 1.2, z: 0.3 });
});

test("resolveLocalAvatarHandTargets survives reordered inputSources when pose spaces are correct", () => {
  const leftGripSpace = { id: "left-grip" };
  const rightGripSpace = { id: "right-grip" };
  const result = resolveLocalAvatarHandTargets({
    presenting: true,
    inputSources: [
      { handedness: "right", gripSpace: rightGripSpace },
      { handedness: "left", gripSpace: leftGripSpace }
    ],
    grips: [spatial(-0.4, 1.2, 0.3), spatial(0.4, 1.2, 0.3)],
    controllers: [null, null],
    xrFrame: frameWithPoses([
      { space: leftGripSpace, x: -0.25, y: 1.2, z: 0.3 },
      { space: rightGripSpace, x: 0.25, y: 1.2, z: 0.3 }
    ]),
    referenceSpace: { id: "ref" }
  });

  assert.deepEqual(result.leftHand, { x: -0.25, y: 1.2, z: 0.3 });
  assert.deepEqual(result.rightHand, { x: 0.25, y: 1.2, z: 0.3 });
});

test("resolveLocalAvatarHandTargets applies player locomotion offset to XR pose-space hands", () => {
  const leftGripSpace = { id: "left-grip" };
  const rightGripSpace = { id: "right-grip" };
  const result = resolveLocalAvatarHandTargets({
    presenting: true,
    inputSources: [
      { handedness: "left", gripSpace: leftGripSpace },
      { handedness: "right", gripSpace: rightGripSpace }
    ],
    grips: [null, null],
    controllers: [null, null],
    xrFrame: frameWithPoses([
      { space: leftGripSpace, x: -0.2, y: 1.2, z: 0.3 },
      { space: rightGripSpace, x: 0.2, y: 1.2, z: 0.3 }
    ]),
    referenceSpace: { id: "ref" },
    playerOffset: { x: 2, y: 0, z: 6 }
  });

  assert.deepEqual(result.leftHand, { x: 1.8, y: 1.2, z: 6.3 });
  assert.deepEqual(result.rightHand, { x: 2.2, y: 1.2, z: 6.3 });
});

test("resolveLocalAvatarHandTargets rotates XR hand poses with player yaw", () => {
  const leftGripSpace = { id: "left-grip" };
  const rightGripSpace = { id: "right-grip" };
  const result = resolveLocalAvatarHandTargets({
    presenting: true,
    inputSources: [
      { handedness: "left", gripSpace: leftGripSpace },
      { handedness: "right", gripSpace: rightGripSpace }
    ],
    grips: [null, null],
    controllers: [null, null],
    xrFrame: frameWithPoses([
      { space: leftGripSpace, x: -0.25, y: 1.2, z: 0.2 },
      { space: rightGripSpace, x: 0.25, y: 1.2, z: 0.2 }
    ]),
    referenceSpace: { id: "ref" },
    playerOffset: { x: 1, y: 0, z: 6 },
    playerYaw: Math.PI / 2
  });

  assert.ok(result.leftHand);
  assert.ok(result.rightHand);
  assert.ok(Math.abs(result.leftHand.x - 1.2) < 1e-9);
  assert.ok(Math.abs(result.leftHand.y - 1.2) < 1e-9);
  assert.ok(Math.abs(result.leftHand.z - 6.25) < 1e-9);
  assert.ok(Math.abs(result.rightHand.x - 1.2) < 1e-9);
  assert.ok(Math.abs(result.rightHand.y - 1.2) < 1e-9);
  assert.ok(Math.abs(result.rightHand.z - 5.75) < 1e-9);
});

test("resolveLocalAvatarHandFrame exposes shared grip pose orientation and source index", () => {
  const leftGripSpace = { id: "left-grip" };
  const rightGripSpace = { id: "right-grip" };
  const rightOrientation = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 4).normalize();
  const result = resolveLocalAvatarHandFrame({
    presenting: true,
    inputSources: [
      { handedness: "left", gripSpace: leftGripSpace },
      { handedness: "right", gripSpace: rightGripSpace }
    ],
    grips: [null, null],
    controllers: [null, null],
    xrFrame: frameWithPoses([
      { space: leftGripSpace, x: -0.2, y: 1.2, z: 0.3 },
      { space: rightGripSpace, x: 0.2, y: 1.2, z: 0.3, orientation: rightOrientation }
    ]),
    referenceSpace: { id: "ref" },
    playerYaw: Math.PI / 2
  });

  assert.equal(result.worldHandPoses.rightHand?.sourceIndex, 1);
  assert.ok(result.worldHandPoses.rightHand);
  assert.ok(Math.abs(result.worldHandPoses.rightHand.position.x - 0.3) < 1e-9);
  assert.ok(Math.abs(result.worldHandPoses.rightHand.position.y - 1.2) < 1e-9);
  assert.ok(Math.abs(result.worldHandPoses.rightHand.position.z + 0.2) < 1e-9);
  assertQuaternionClose(
    result.worldHandPoses.rightHand.orientation,
    new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 2).multiply(rightOrientation).normalize()
  );
});

test("createSyntheticLocalAvatarHandFrame shares the synthetic grip as hand pose", () => {
  const result = createSyntheticLocalAvatarHandFrame({
    rightController: { x: 0, y: 2, z: 0 },
    rightGrip: { x: 0.5, y: 1.5, z: -2 },
    rayDirection: { x: 0, y: 0, z: -1 }
  });

  assert.equal(result.worldHandPoses.rightHand?.sourceIndex, 0);
  assert.deepEqual(result.worldHands.rightHand, { x: 0.5, y: 1.5, z: -2 });
  assert.deepEqual(result.controllerWorldHands.rightHand, { x: 0, y: 2, z: 0 });
});

test("resolveLocalAvatarHandFrame uses one XR pose sample for debug and hand targets", () => {
  const rightGripSpace = { id: "right-grip" };
  const rightTargetRaySpace = { id: "right-target-ray" };
  let poseReadCount = 0;
  const xrFrame = {
    getPose(space: unknown) {
      poseReadCount += 1;
      if (space === rightGripSpace) {
        return { transform: { position: { x: 0.2, y: 1.1, z: 0.3 } } };
      }
      if (space === rightTargetRaySpace) {
        return { transform: { position: { x: 0.4, y: 1.3, z: 0.5 } } };
      }
      return null;
    }
  };

  const result = resolveLocalAvatarHandFrame({
    presenting: true,
    inputSources: [{ handedness: "right", gripSpace: rightGripSpace, targetRaySpace: rightTargetRaySpace }],
    grips: [spatial(10, 10, 10)],
    controllers: [spatial(20, 20, 20)],
    xrFrame,
    referenceSpace: { id: "ref" },
    playerOffset: { x: 1, y: 0, z: 6 }
  });

  assert.equal(poseReadCount, 2);
  assert.deepEqual(result.debug.rightGrip, { x: 0.2, y: 1.1, z: 0.3 });
  assert.deepEqual(result.debug.rightController, { x: 0.4, y: 1.3, z: 0.5 });
  assert.deepEqual(result.worldHands.rightHand, { x: 1.2, y: 1.1, z: 6.3 });
  assert.deepEqual(result.controllerWorldHands.rightHand, { x: 1.4, y: 1.3, z: 6.5 });
  assert.equal(result.worldHandPoses.rightHand?.sourceIndex, 0);
  assert.deepEqual(result.worldHandPoses.rightHand?.position, { x: 1.2, y: 1.1, z: 6.3 });
});
