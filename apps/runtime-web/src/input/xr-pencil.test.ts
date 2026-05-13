import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { resolveSyntheticXrPencilPose, resolveXrPencilPose } from "./xr-pencil.js";

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

test("resolveXrPencilPose anchors the pencil to grip pose instead of target ray pose", () => {
  const gripSpace = { id: "right-grip" };
  const targetRaySpace = { id: "right-target-ray" };
  const pose = resolveXrPencilPose({
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
    playerYaw: 0,
    tipLocalZ: -0.32
  });

  assert.ok(pose);
  assert.equal(pose.sourceIndex, 0);
  assert.deepEqual(pose.anchorWorld.toArray(), [1.4, 1.2, 5.4]);
  assert.deepEqual(pose.tipWorld.toArray(), [1.4, 1.2, 5.08]);
});

test("resolveXrPencilPose applies player yaw to grip position and tip direction", () => {
  const gripSpace = { id: "right-grip" };
  const pose = resolveXrPencilPose({
    presenting: true,
    inputSources: [{ handedness: "right", gripSpace }],
    grips: [null],
    controllers: [null],
    xrFrame: frameWithPoses([{ space: gripSpace, x: 0.2, y: 1.1, z: 0.3 }]),
    referenceSpace: { id: "ref" },
    playerOffset: { x: 1, y: 0, z: 6 },
    playerYaw: Math.PI / 2,
    tipLocalZ: -0.32
  });

  assert.ok(pose);
  assert.ok(Math.abs(pose.anchorWorld.x - 1.3) < 1e-9);
  assert.ok(Math.abs(pose.anchorWorld.y - 1.1) < 1e-9);
  assert.ok(Math.abs(pose.anchorWorld.z - 5.8) < 1e-9);
  assert.ok(Math.abs(pose.tipWorld.x - 0.98) < 1e-9);
  assert.ok(Math.abs(pose.tipWorld.y - 1.1) < 1e-9);
  assert.ok(Math.abs(pose.tipWorld.z - 5.8) < 1e-9);
});

test("resolveSyntheticXrPencilPose uses the supplied hand anchor and ray direction", () => {
  const pose = resolveSyntheticXrPencilPose({
    anchor: { x: 0.5, y: 1.5, z: -2 },
    direction: { x: 0, y: 0, z: -1 },
    tipLocalZ: -0.32
  });

  assert.ok(pose);
  assert.deepEqual(pose.anchorWorld.toArray(), [0.5, 1.5, -2]);
  assert.deepEqual(pose.tipWorld.toArray(), [0.5, 1.5, -2.32]);
});
