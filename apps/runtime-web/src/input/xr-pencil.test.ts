import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createSyntheticLocalAvatarHandFrame, resolveLocalAvatarHandFrame } from "../avatar/avatar-xr-hands.js";
import { resolveXrPencilPose } from "./xr-pencil.js";

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
          orientation: found.orientation ?? { x: 0, y: 0, z: 0, w: 1 }
        }
      };
    }
  };
}

test("resolveXrPencilPose consumes the shared hand frame grip pose", () => {
  const gripSpace = { id: "right-grip" };
  const targetRaySpace = { id: "right-target-ray" };
  const handFrame = resolveLocalAvatarHandFrame({
    presenting: true,
    inputSources: [{ handedness: "right", gripSpace, targetRaySpace }],
    grips: [null],
    controllers: [null],
    xrFrame: frameWithPoses([
      { space: gripSpace, x: 0.4, y: 1.2, z: -0.6 },
      { space: targetRaySpace, x: 0, y: 2, z: 0 }
    ]),
    referenceSpace: { id: "ref" },
    playerOffset: { x: 1, y: 0, z: 6 },
    playerYaw: 0
  });
  const pencilPose = resolveXrPencilPose({ handPose: handFrame.worldHandPoses.rightHand, tipLocalZ: -0.32 });

  assert.ok(pencilPose);
  assert.equal(pencilPose.sourceIndex, 0);
  assert.deepEqual(pencilPose.anchorWorld.toArray(), [1.4, 1.2, 5.4]);
  assert.deepEqual(pencilPose.tipWorld.toArray(), [1.4, 1.2, 5.08]);
});

test("resolveXrPencilPose uses player yaw already applied by the shared hand frame", () => {
  const gripSpace = { id: "right-grip" };
  const handFrame = resolveLocalAvatarHandFrame({
    presenting: true,
    inputSources: [{ handedness: "right", gripSpace }],
    grips: [null],
    controllers: [null],
    xrFrame: frameWithPoses([{ space: gripSpace, x: 0.2, y: 1.1, z: 0.3 }]),
    referenceSpace: { id: "ref" },
    playerOffset: { x: 1, y: 0, z: 6 },
    playerYaw: Math.PI / 2
  });
  const pencilPose = resolveXrPencilPose({ handPose: handFrame.worldHandPoses.rightHand, tipLocalZ: -0.32 });

  assert.ok(pencilPose);
  assert.ok(Math.abs(pencilPose.anchorWorld.x - 1.3) < 1e-9);
  assert.ok(Math.abs(pencilPose.anchorWorld.y - 1.1) < 1e-9);
  assert.ok(Math.abs(pencilPose.anchorWorld.z - 5.8) < 1e-9);
  assert.ok(Math.abs(pencilPose.tipWorld.x - 0.98) < 1e-9);
  assert.ok(Math.abs(pencilPose.tipWorld.y - 1.1) < 1e-9);
  assert.ok(Math.abs(pencilPose.tipWorld.z - 5.8) < 1e-9);
});

test("resolveXrPencilPose uses the shared synthetic hand frame", () => {
  const handFrame = createSyntheticLocalAvatarHandFrame({
    rightController: { x: 0, y: 2, z: 0 },
    rightGrip: { x: 0.5, y: 1.5, z: -2 },
    rayDirection: { x: 0, y: 0, z: -1 }
  });
  const pencilPose = resolveXrPencilPose({ handPose: handFrame.worldHandPoses.rightHand, tipLocalZ: -0.32 });

  assert.ok(pencilPose);
  assert.deepEqual(pencilPose.anchorWorld.toArray(), [0.5, 1.5, -2]);
  assert.deepEqual(pencilPose.tipWorld.toArray(), [0.5, 1.5, -2.32]);
});

test("resolveXrPencilPose applies a local pencil grip rotation without changing hand source", () => {
  const handFrame = createSyntheticLocalAvatarHandFrame({
    rightController: { x: 0, y: 2, z: 0 },
    rightGrip: { x: 0.5, y: 1.5, z: -2 },
    rayDirection: { x: 0, y: 0, z: -1 }
  });
  const orientationOffset = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 8, 0, 0, "XYZ"));
  const pencilPose = resolveXrPencilPose({
    handPose: handFrame.worldHandPoses.rightHand,
    tipLocalZ: -0.32,
    orientationOffset
  });
  const expectedTip = new THREE.Vector3(0, 0, -0.32)
    .applyQuaternion(orientationOffset)
    .add(new THREE.Vector3(0.5, 1.5, -2));

  assert.ok(pencilPose);
  assert.equal(pencilPose.sourceIndex, 0);
  assert.deepEqual(pencilPose.anchorWorld.toArray(), [0.5, 1.5, -2]);
  assert.ok(pencilPose.tipWorld.distanceTo(expectedTip) < 1e-9);
});
