import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import { createFloorLinkPicker } from "./floor-link-picker.js";
import { createInteractionRayView, type InteractionRayDebugState } from "./interaction-ray-view.js";
import { resolveInteractionTargetForRay, updateInteractionRayState, type RuntimeInteractionFrameInput } from "./interaction-frame.js";

function frameContext(input: { source?: "desktop" | "xr"; aimRay?: boolean } = {}): RuntimeFrameContext {
  const source = input.source ?? "desktop";
  return {
    deltaSeconds: 0.016,
    nowMs: 12_000,
    source,
    intents: {
      move: { x: 0, z: 0 },
      snapTurn: { axis: 0 },
      aimRay: input.aimRay ?? false,
      confirmInteraction: false,
      source
    }
  };
}

function createDebugState(overrides: Partial<InteractionRayDebugState> = {}): InteractionRayDebugState {
  return {
    active: false,
    mode: "none",
    targetKind: "none",
    seatId: null,
    point: null,
    origin: null,
    direction: null,
    source: null,
    ...overrides
  };
}

function seatAnchor(id: string): SceneBundleSeatAnchor {
  return {
    id,
    position: { x: 1, y: 0, z: -2 },
    yaw: 0.25,
    seatHeight: 0.5,
    radius: 0.8,
    label: "Seat A"
  };
}

function makeInput(overrides: Partial<RuntimeInteractionFrameInput> = {}): RuntimeInteractionFrameInput {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld(true);
  const view = createInteractionRayView(new THREE.Scene());
  return {
    frameContext: frameContext(),
    forcedRay: null,
    forcedSeatId: null,
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
    raycaster: new THREE.Raycaster(),
    seatMarkerHitMeshes: [],
    seatAnchorMap: new Map(),
    seatAnchors: [],
    teleportFloorY: 0,
    maxDistance: 18,
    view,
    state: createDebugState(),
    ...overrides
  };
}

test("updateInteractionRayState resolves forced seat target through interaction frame orchestration", () => {
  const anchor = seatAnchor("seat-a");
  const telemetry: string[] = [];
  const state = createDebugState();
  const target = updateInteractionRayState(makeInput({
    forcedRay: new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)),
    forcedSeatId: anchor.id,
    seatAnchorMap: new Map([[anchor.id, anchor]]),
    state,
    markTelemetry: (kind) => telemetry.push(kind)
  }));

  assert.equal(target.kind, "seat");
  assert.equal(target.kind === "seat" ? target.seatId : null, "seat-a");
  assert.deepEqual(target.kind === "seat" ? target.point.toArray() : [], [1, 0.5, -2]);
  assert.equal(state.active, true);
  assert.equal(state.mode, "cursor");
  assert.equal(state.targetKind, "seat");
  assert.equal(state.seatId, "seat-a");
  assert.deepEqual(telemetry, ["ray_on"]);
});

test("updateInteractionRayState clears visuals and refreshes seat markers when no ray resolves", () => {
  const markerVisualTimes: number[] = [];
  const telemetry: string[] = [];
  const state = createDebugState({ active: true, mode: "cursor", targetKind: "floor" });
  const input = makeInput({
    state,
    markTelemetry: (kind) => telemetry.push(kind),
    updateSeatMarkerVisuals: (timeSeconds) => markerVisualTimes.push(timeSeconds),
    nowSeconds: () => 12.5
  });
  input.view.line.visible = true;
  input.view.beam.visible = true;
  input.view.reticle.visible = true;

  const target = updateInteractionRayState(input);

  assert.deepEqual(target, { kind: "none" });
  assert.equal(input.view.line.visible, false);
  assert.equal(input.view.beam.visible, false);
  assert.equal(input.view.reticle.visible, false);
  assert.equal(state.active, false);
  assert.equal(state.mode, "none");
  assert.equal(state.targetKind, "none");
  assert.deepEqual(telemetry, ["ray_off"]);
  assert.deepEqual(markerVisualTimes, [12.5]);
});
test("authored floors limit both seat hits and destinations; a landing displays the hit but teleports to the linked floor", () => {
  const lower = { y: 0, minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
  const upper = { ...lower, y: 4 }, destination = { x: .5, y: 4, z: -.5 };
  const ray = new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0));
  const below = { ...seatAnchor("other"), position: { x: 0, y: -1, z: 0 } };
  const input = { ray, seatAnchors: [below], seatAnchorMap: new Map([[below.id, below]]),
    seatMarkerHitMeshes: [], raycaster: new THREE.Raycaster(), teleportFloorY: 0,
    floorAreas: [lower, upper], pickFloorLink: (r: THREE.Ray, y: number) => r.origin.x === 0 && y === 0 ? { kind: "floor" as const, point: new THREE.Vector3(), destination } : null };
  const link = resolveInteractionTargetForRay(input);
  assert.equal(link.kind, "floor");
  if (link.kind === "floor") { assert.deepEqual(link.point.toArray(), [0, 0, 0]); assert.deepEqual(link.destination, destination); }
  ray.origin.set(3, 1, 0);
  assert.equal(resolveInteractionTargetForRay(input).kind, "none");
  ray.origin.set(0, 5, 0);
  const level = resolveInteractionTargetForRay({ ...input, teleportFloorY: 4 });
  assert.ok(level.kind === "floor" && level.point.y === 4 && !level.destination);
});

test("a regular teleport on a fractional floor preserves the active stair link", () => {
  const lower = { y: 0.001, minX: -3, maxX: 1, minZ: -1, maxZ: 1 };
  const upper = { ...lower, y: 3.201 };
  const stairs = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 1));
  stairs.name = "stairs";
  stairs.position.set(0, 0.6, -3);
  stairs.updateMatrixWorld(true);
  const destination = { x: 0, y: upper.y, z: 0 };
  const input = {
    teleportFloorY: lower.y, floorAreas: [lower, upper],
    seatAnchors: [], seatAnchorMap: new Map(), seatMarkerHitMeshes: [],
    raycaster: new THREE.Raycaster(),
    pickFloorLink: createFloorLinkPicker(stairs, [{ node: stairs.name, fromY: lower.y, destination }])
  };
  const start = new THREE.Vector3(-2, lower.y + 1.6, 0);
  const landing = new THREE.Vector3(-1, lower.y, 0);
  const floor = resolveInteractionTargetForRay({
    ...input,
    ray: new THREE.Ray(start, landing.sub(start).normalize())
  });
  assert.ok(floor.kind === "floor" && !floor.destination);

  // The runtime remembers the height of the ordinary teleport as its active level.
  const eye = floor.point.clone().add(new THREE.Vector3(0, 1.6, 0));
  const stair = resolveInteractionTargetForRay({
    ...input, teleportFloorY: floor.point.y,
    ray: new THREE.Ray(eye, stairs.position.clone().sub(eye).normalize())
  });
  assert.ok(stair.kind === "floor");
  assert.deepEqual(stair.destination, destination);
});
