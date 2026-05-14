import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import { resolveInteractionRay } from "./interaction-ray.js";

type ResolveInteractionRayInput = Parameters<typeof resolveInteractionRay>[0];

function frameContext(input: { source?: "desktop" | "xr"; aimRay?: boolean; xr?: RuntimeFrameContext["xr"] } = {}): RuntimeFrameContext {
  const source = input.source ?? "desktop";
  return {
    deltaSeconds: 0.016,
    nowMs: 1,
    source,
    intents: {
      move: { x: 0, z: 0 },
      snapTurn: { axis: 0 },
      aimRay: input.aimRay ?? false,
      confirmInteraction: false,
      source
    },
    xr: input.xr
  };
}

function makeInput(overrides: Partial<ResolveInteractionRayInput> = {}): ResolveInteractionRayInput {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld(true);
  return {
    frameContext: frameContext(),
    forcedRay: null,
    avatarVrMockEnabled: false,
    syntheticXrState: null,
    xrPresenting: false,
    xrControllerGrips: [],
    xrControllers: [],
    playerPosition: { x: 0, y: 0, z: 0 },
    playerYaw: 0,
    pointerHoveringScene: false,
    pointerNdc: new THREE.Vector2(0, 0),
    camera,
    pointerRaycaster: new THREE.Raycaster(),
    ...overrides
  };
}

test("resolveInteractionRay returns a cloned forced ray without debug side effects", () => {
  const forcedRay = new THREE.Ray(new THREE.Vector3(1, 2, 3), new THREE.Vector3(0, 0, -1));

  const resolved = resolveInteractionRay(makeInput({ forcedRay }));

  assert.ok(resolved);
  assert.notEqual(resolved!.ray, forcedRay);
  assert.deepEqual(resolved!.ray.origin, forcedRay.origin);
  assert.equal(resolved!.debug, null);
});

test("resolveInteractionRay resolves synthetic XR ray and debug sample", () => {
  const resolved = resolveInteractionRay(makeInput({
    frameContext: frameContext({ source: "xr", aimRay: false }),
    avatarVrMockEnabled: true,
    syntheticXrState: {
      rightController: { x: 1.234, y: 1.567, z: -2.345 },
      rayDirection: { x: 0, y: 0, z: -4 },
      rayVisible: true
    }
  }));

  assert.ok(resolved);
  assert.deepEqual(resolved!.ray.origin, new THREE.Vector3(1.234, 1.567, -2.345));
  assert.deepEqual(resolved!.ray.direction, new THREE.Vector3(0, 0, -1));
  assert.deepEqual(resolved!.debug, {
    origin: { x: 1.23, y: 1.57, z: -2.35 },
    direction: { x: 0, y: 0, z: -1 },
    source: { index: 0, handedness: "right" }
  });
});

test("resolveInteractionRay suppresses hidden synthetic XR ray without aim intent", () => {
  const resolved = resolveInteractionRay(makeInput({
    frameContext: frameContext({ source: "xr", aimRay: false }),
    avatarVrMockEnabled: true,
    syntheticXrState: {
      rightController: { x: 0, y: 1, z: 0 },
      rayDirection: { x: 0, y: 0, z: -1 },
      rayVisible: false
    }
  }));

  assert.equal(resolved, null);
});

test("resolveInteractionRay uses sampled XR frame context and right hand origin", () => {
  const rightGripSpace = { id: "right-grip" };
  const rightTargetRaySpace = { id: "right-target-ray" };
  const xrFrame = {
    getPose(space: unknown) {
      if (space === rightGripSpace) {
        return { transform: { position: { x: 0.3, y: 1.1, z: 0.2 } } };
      }
      if (space === rightTargetRaySpace) {
        return {
          transform: {
            position: { x: 0.1, y: 1.2, z: 0.4 },
            orientation: { x: 0, y: 0, z: 0, w: 1 }
          }
        };
      }
      return null;
    }
  } as unknown as XRFrame;
  const inputSources = [{
    handedness: "right",
    targetRayMode: "tracked-pointer",
    gripSpace: rightGripSpace,
    targetRaySpace: rightTargetRaySpace
  }] as unknown as XRInputSource[];

  const resolved = resolveInteractionRay(makeInput({
    frameContext: frameContext({
      source: "xr",
      aimRay: true,
      xr: {
        frame: xrFrame,
        session: undefined,
        referenceSpace: {} as XRReferenceSpace,
        inputSources,
        profile: "right-only",
        sanitizedAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: -1 },
        rawAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: -1 },
        triggerPressed: false,
        rayVisibleLatched: true
      }
    }),
    xrPresenting: true,
    playerPosition: { x: 10, y: 0, z: 5 },
    playerYaw: 0,
    xrControllerGrips: [null],
    xrControllers: [null]
  }));

  assert.ok(resolved);
  assert.deepEqual(resolved!.ray.origin, new THREE.Vector3(10.3, 1.1, 5.2));
  assert.deepEqual(resolved!.ray.direction, new THREE.Vector3(0, 0, -1));
  assert.deepEqual(resolved!.debug, {
    origin: { x: 10.3, y: 1.1, z: 5.2 },
    direction: { x: 0, y: 0, z: -1 },
    source: { index: 0, handedness: "right" }
  });
});

test("resolveInteractionRay can force an XR ray without stick aim intent", () => {
  const rightTargetRaySpace = { id: "right-target-ray" };
  const xrFrame = {
    getPose(space: unknown) {
      if (space === rightTargetRaySpace) {
        return {
          transform: {
            position: { x: 0, y: 1.2, z: 0 },
            orientation: { x: 0, y: 0, z: 0, w: 1 }
          }
        };
      }
      return null;
    }
  } as unknown as XRFrame;
  const inputSources = [{
    handedness: "right",
    targetRayMode: "tracked-pointer",
    targetRaySpace: rightTargetRaySpace
  }] as unknown as XRInputSource[];

  const resolved = resolveInteractionRay(makeInput({
    frameContext: frameContext({
      source: "xr",
      aimRay: false,
      xr: {
        frame: xrFrame,
        session: undefined,
        referenceSpace: {} as XRReferenceSpace,
        inputSources,
        profile: "right-only",
        sanitizedAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: 0 },
        rawAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: 0 },
        triggerPressed: false,
        rayVisibleLatched: false
      }
    }),
    forceXrAimRay: true,
    xrPresenting: true
  }));

  assert.ok(resolved);
  assert.deepEqual(resolved!.ray.direction, new THREE.Vector3(0, 0, -1));
});

test("resolveInteractionRay does not resolve XR ray without sampled XR context", () => {
  const resolved = resolveInteractionRay(makeInput({
    frameContext: frameContext({ source: "desktop", aimRay: true }),
    xrPresenting: true
  }));

  assert.equal(resolved, null);
});
