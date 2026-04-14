import test from "node:test";
import assert from "node:assert/strict";

import { resolvePrimaryRightInputSourceIndex, resolveXrInteractionRay } from "./avatar-xr-ray.js";

test("resolvePrimaryRightInputSourceIndex prefers right handed source", () => {
  assert.equal(resolvePrimaryRightInputSourceIndex([
    { handedness: "left", targetRayMode: "tracked-pointer" },
    { handedness: "right", targetRayMode: "tracked-pointer" }
  ]), 1);
});

test("resolvePrimaryRightInputSourceIndex falls back to first tracked pointer", () => {
  assert.equal(resolvePrimaryRightInputSourceIndex([
    { handedness: "", targetRayMode: "gaze" },
    { handedness: "", targetRayMode: "tracked-pointer" }
  ]), 1);
});

test("resolveXrInteractionRay converts targetRay pose into room space", () => {
  const ray = resolveXrInteractionRay({
    inputSources: [{ handedness: "right", targetRayMode: "tracked-pointer", targetRaySpace: "right-ray" }],
    xrFrame: {
      getPose(space: unknown) {
        assert.equal(space, "right-ray");
        return {
          transform: {
            position: { x: 1, y: 2, z: 3 },
            orientation: { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }
          }
        };
      }
    },
    referenceSpace: {},
    playerOffset: { x: 10, y: 1, z: -5 },
    playerYaw: Math.PI / 2
  });

  assert.ok(ray);
  assert.equal(Number(ray!.origin.x.toFixed(3)), 7);
  assert.equal(Number(ray!.origin.y.toFixed(3)), 3);
  assert.equal(Number(ray!.origin.z.toFixed(3)), -4);
  assert.equal(Number(ray!.direction.x.toFixed(3)), -0);
  assert.equal(Number(ray!.direction.y.toFixed(3)), 0);
  assert.equal(Number(ray!.direction.z.toFixed(3)), 1);
});
