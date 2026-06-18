import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import {
  clearInteractionRayView,
  createInteractionRayView,
  setInteractionRayDebugTarget,
  showInteractionRayPointView,
  showInteractionRayView,
  type InteractionRayDebugState
} from "./interaction-ray-view.js";

function createDebugState(): InteractionRayDebugState {
  return {
    active: false,
    mode: "none",
    targetKind: "none",
    seatId: null,
    point: null,
    origin: null,
    direction: null,
    source: null
  };
}

function seatAnchor(id: string): SceneBundleSeatAnchor {
  return {
    id,
    position: { x: 1, y: 0, z: -2 },
    yaw: 0,
    seatHeight: 0.5,
    radius: 0.8
  };
}

test("createInteractionRayView creates hidden scene visuals", () => {
  const scene = new THREE.Scene();
  const view = createInteractionRayView(scene);

  assert.equal(scene.children.includes(view.root), true);
  assert.equal(view.root.children.includes(view.line), true);
  assert.equal(view.root.children.includes(view.beam), true);
  assert.equal(view.root.children.includes(view.reticle), true);
  assert.equal(view.line.visible, false);
  assert.equal(view.beam.visible, false);
  assert.equal(view.reticle.visible, false);
  assert.equal(view.root.renderOrder, 1300);
  assert.equal(view.line.renderOrder, 1300);
  assert.equal(view.beam.renderOrder, 1301);
  assert.equal(view.reticle.renderOrder, 1302);
  assert.ok(view.root.renderOrder > 1202);
});

test("showInteractionRayView draws floor target and updates debug state", () => {
  const view = createInteractionRayView(new THREE.Scene());
  const state = createDebugState();
  const telemetry: string[] = [];
  const ray = new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -0.5, -1).normalize());
  const target = { kind: "floor" as const, point: new THREE.Vector3(0, 0, -2.25) };

  showInteractionRayView({
    view,
    state,
    ray,
    target,
    mode: "xr-right-stick",
    debug: {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: -0.45, z: -0.89 },
      source: { index: 1, handedness: "right" }
    },
    markTelemetry: (kind) => telemetry.push(kind)
  });

  assert.equal(view.line.visible, true);
  assert.equal(view.beam.visible, true);
  assert.equal(view.reticle.visible, true);
  assert.deepEqual(view.reticle.position.toArray(), [0, 0, -2.25]);
  assert.equal(view.lineMaterial.color.getHex(), 0x00f6ff);
  assert.equal(state.active, true);
  assert.equal(state.mode, "xr-right-stick");
  assert.equal(state.targetKind, "floor");
  assert.deepEqual(state.point, { x: 0, y: 0, z: -2.25 });
  assert.deepEqual(state.source, { index: 1, handedness: "right" });
  assert.deepEqual(telemetry, ["ray_on"]);
});

test("showInteractionRayView draws seat target with seat color", () => {
  const view = createInteractionRayView(new THREE.Scene());
  const state = createDebugState();
  const anchor = seatAnchor("seat-a");
  const target = {
    kind: "seat" as const,
    point: new THREE.Vector3(1, 0.5, -2),
    seatId: anchor.id,
    seatAnchor: anchor
  };

  showInteractionRayView({
    view,
    state,
    ray: new THREE.Ray(new THREE.Vector3(1, 1, 0), new THREE.Vector3(0, -0.25, -1).normalize()),
    target,
    mode: "cursor"
  });

  assert.equal(view.lineMaterial.color.getHex(), 0xb8ff8d);
  assert.equal(view.beamMaterial.color.getHex(), 0xb8ff8d);
  assert.equal(view.reticleMaterial.color.getHex(), 0xb8ff8d);
  assert.equal(state.targetKind, "seat");
  assert.equal(state.seatId, "seat-a");
});

test("showInteractionRayPointView draws surface target", () => {
  const view = createInteractionRayView(new THREE.Scene());
  const state = createDebugState();

  showInteractionRayPointView({
    view,
    state,
    ray: new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)),
    point: new THREE.Vector3(0, 1, -3),
    targetKind: "surface",
    mode: "xr-right-stick",
    color: 0xffc857
  });

  assert.equal(view.line.visible, true);
  assert.equal(view.beam.visible, true);
  assert.equal(view.reticle.visible, true);
  assert.equal(view.lineMaterial.color.getHex(), 0xffc857);
  assert.equal(state.active, true);
  assert.equal(state.targetKind, "surface");
  assert.equal(state.seatId, null);
  assert.deepEqual(state.point, { x: 0, y: 1, z: -3 });
});

test("showInteractionRayPointView can stop visuals before the target point", () => {
  const view = createInteractionRayView(new THREE.Scene());
  const state = createDebugState();

  showInteractionRayPointView({
    view,
    state,
    ray: new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)),
    point: new THREE.Vector3(0, 1, -3),
    targetKind: "keyboard",
    mode: "xr-right-stick",
    visualEndOffsetM: 0.1,
    showReticle: false
  });

  assert.equal(view.line.visible, true);
  assert.equal(view.beam.visible, true);
  assert.equal(view.reticle.visible, false);
  assert.deepEqual(view.end.toArray(), [0, 1, -2.9]);
  assert.deepEqual(state.point, { x: 0, y: 1, z: -3 });
  assert.equal(state.targetKind, "keyboard");
});

test("clearInteractionRayView hides visuals and clears debug state", () => {
  const view = createInteractionRayView(new THREE.Scene());
  const state = createDebugState();
  const telemetry: string[] = [];
  setInteractionRayDebugTarget({
    state,
    target: { kind: "floor", point: new THREE.Vector3(0, 0, -1) },
    mode: "cursor"
  });
  view.line.visible = true;
  view.beam.visible = true;
  view.reticle.visible = true;

  clearInteractionRayView({
    view,
    state,
    mode: "none",
    markTelemetry: (kind) => telemetry.push(kind)
  });

  assert.equal(view.line.visible, false);
  assert.equal(view.beam.visible, false);
  assert.equal(view.reticle.visible, false);
  assert.equal(state.active, false);
  assert.equal(state.mode, "none");
  assert.equal(state.targetKind, "none");
  assert.equal(state.point, null);
  assert.equal(state.origin, null);
  assert.deepEqual(telemetry, ["ray_off"]);
});
