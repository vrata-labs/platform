import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import {
  clearInteractionRayView, createInteractionRayView, showInteractionRayPointView,
  showInteractionRayView, type InteractionRayDebugState
} from "./interaction-ray-view.js";

for (const mode of ["cursor", "xr-right-stick"] as const) {
  test(`${mode}: seat hover preserves the ray without obscuring the chevron and restores other reticles`, () => {
    const view = createInteractionRayView(new THREE.Scene());
    const state: InteractionRayDebugState = {
      active: false, mode: "none", targetKind: "none", seatId: null,
      point: null, origin: null, direction: null, source: null
    };
    const ray = new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
    const anchor: SceneBundleSeatAnchor = {
      id: "seat", position: { x: 0, y: 0, z: -2 }, yaw: 0, seatHeight: 0.5, radius: 0.8
    };
    const seat = { kind: "seat" as const, point: new THREE.Vector3(0, 0.66, -2), seatId: anchor.id, seatAnchor: anchor };
    const floor = { kind: "floor" as const, point: new THREE.Vector3(0, 0, -3) };
    const telemetry: string[] = [];
    const show = (target: typeof seat | typeof floor) => showInteractionRayView({
      view, state, ray, target, mode, markTelemetry: kind => telemetry.push(kind)
    });
    try {
      show(floor);
      assert.equal(view.reticle.visible, true);
      show(seat);
      assert.equal(view.reticle.visible, false);
      assert.equal(view.line.visible, true);
      assert.equal(view.beam.visible, true);
      assert.deepEqual(view.end.toArray(), seat.point.toArray());
      assert.equal(view.beamMaterial.color.getHex(), 0xb8ff8d);
      assert.equal(state.active, true);
      assert.equal(state.mode, mode);
      assert.equal(state.targetKind, "seat");
      assert.equal(state.seatId, anchor.id);
      assert.deepEqual(state.point, { x: 0, y: 0.66, z: -2 });
      show(floor);
      assert.equal(view.reticle.visible, true);
      assert.equal(view.reticleMaterial.color.getHex(), 0x00f6ff);
      assert.deepEqual(view.reticle.position.toArray(), floor.point.toArray());
      assert.equal(state.targetKind, "floor");
      assert.equal(state.seatId, null);
      assert.deepEqual(telemetry, ["ray_on", "ray_on", "ray_on"]);
      show(seat);
      showInteractionRayPointView({ view, state, ray, point: floor.point, targetKind: "surface", mode });
      assert.equal(view.reticle.visible, true);
      assert.equal(state.targetKind, "surface");
      clearInteractionRayView({ view, state });
      assert.equal(view.reticle.visible, false);
      assert.equal(view.beam.visible, false);
      assert.equal(state.active, false);
    } finally {
      view.lineGeometry.dispose();
      view.lineMaterial.dispose();
      view.beam.geometry.dispose();
      view.beamMaterial.dispose();
      view.reticle.geometry.dispose();
      view.reticleMaterial.dispose();
    }
  });
}
