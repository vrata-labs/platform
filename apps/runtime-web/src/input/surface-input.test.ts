import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  applySurfaceInputResolution,
  createSurfaceInputDebugState,
  createSyntheticSurfaceHit,
  resolveSurfaceHitFromPlanePoint,
  resolveSurfaceHitFromRay,
  resolveSurfaceInputEvent,
  tryFocusSurface
} from "./surface-input.js";

test("resolveSurfaceHitFromRay maps plane hit to stable uv and pixels", () => {
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  surface.position.set(0, 0, -2);
  surface.updateMatrixWorld(true);

  const hit = resolveSurfaceHitFromRay({
    ray: new THREE.Ray(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)),
    surfaces: [{ surfaceId: "debug-main", object: surface, widthPx: 200, heightPx: 100, inputEnabled: true }],
    raycaster: new THREE.Raycaster(),
    source: "mouse"
  });

  assert.ok(hit);
  assert.equal(hit!.surfaceId, "debug-main");
  assert.deepEqual(hit!.uv, { u: 0.5, v: 0.5 });
  assert.deepEqual(hit!.pixel, { x: 100, y: 50 });
});

test("resolveSurfaceHitFromPlanePoint maps a nearby pencil tip to surface uv", () => {
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshBasicMaterial());
  surface.position.set(0, 0, -2);
  surface.updateMatrixWorld(true);

  const hit = resolveSurfaceHitFromPlanePoint({
    point: new THREE.Vector3(0.5, 0.25, -2.02),
    surfaces: [{ surfaceId: "debug-main", object: surface, widthPx: 200, heightPx: 100, widthM: 2, heightM: 1, maxDistanceM: 0.05, inputEnabled: true }],
    source: "xr-controller"
  });

  assert.ok(hit);
  assert.deepEqual(hit!.uv, { u: 0.75, v: 0.75 });
  assert.deepEqual(hit!.pixel, { x: 150, y: 75 });
  assert.equal(hit!.distanceM, 0.02);
});

test("resolveSurfaceHitFromPlanePoint rejects distant or out-of-bounds tips", () => {
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshBasicMaterial());
  surface.position.set(0, 0, -2);
  surface.updateMatrixWorld(true);
  const surfaces = [{ surfaceId: "debug-main", object: surface, widthPx: 200, heightPx: 100, widthM: 2, heightM: 1, maxDistanceM: 0.05, inputEnabled: true }];

  assert.equal(resolveSurfaceHitFromPlanePoint({ point: new THREE.Vector3(0, 0, -2.1), surfaces, source: "xr-controller" }), null);
  assert.equal(resolveSurfaceHitFromPlanePoint({ point: new THREE.Vector3(1.2, 0, -2.01), surfaces, source: "xr-controller" }), null);
});

test("resolveSurfaceInputEvent accepts member surface input", () => {
  const resolution = resolveSurfaceInputEvent({
    roomId: "room-1",
    participantId: "p-1",
    permissions: ["room.join", "surface.view", "surface.input"],
    hit: createSyntheticSurfaceHit({ surfaceId: "debug-main", source: "mouse", uv: { u: 0.25, v: 0.75 }, widthPx: 400, heightPx: 200 }),
    kind: "click",
    source: "mouse",
    clientTimeMs: 10,
    seq: 1
  });

  assert.equal(resolution.accepted, true);
  assert.equal(resolution.accepted ? resolution.event.eventId : "", "p-1:1");
  assert.deepEqual(resolution.accepted ? resolution.event.pixel : null, { x: 100, y: 150 });
});

test("resolveSurfaceInputEvent rejects guest, disabled surfaces, and invalid uv", () => {
  const hit = createSyntheticSurfaceHit({ surfaceId: "debug-main", source: "mouse", uv: { u: 0.5, v: 0.5 }, widthPx: 100, heightPx: 100 });
  const guest = resolveSurfaceInputEvent({
    roomId: "room-1",
    participantId: "p-1",
    permissions: ["room.join", "surface.view"],
    hit,
    kind: "click",
    source: "mouse",
    clientTimeMs: 10,
    seq: 1
  });
  assert.deepEqual(guest, { accepted: false, blockedReason: "missing-permission:surface.input" });

  const disabled = resolveSurfaceInputEvent({
    roomId: "room-1",
    participantId: "p-1",
    permissions: ["surface.input"],
    hit: { ...hit, inputEnabled: false },
    kind: "click",
    source: "mouse",
    clientTimeMs: 10,
    seq: 2
  });
  assert.deepEqual(disabled, { accepted: false, blockedReason: "surface-disabled" });

  const invalidUv = resolveSurfaceInputEvent({
    roomId: "room-1",
    participantId: "p-1",
    permissions: ["surface.input"],
    hit: { ...hit, uv: { u: 1.2, v: 0.5 } },
    kind: "click",
    source: "mouse",
    clientTimeMs: 10,
    seq: 3
  });
  assert.deepEqual(invalidUv, { accepted: false, blockedReason: "uv-out-of-range" });
});

test("surface input debug state records accepted and blocked resolutions", () => {
  const state = createSurfaceInputDebugState("debug-main");
  const accepted = resolveSurfaceInputEvent({
    roomId: "room-1",
    participantId: "p-1",
    permissions: ["surface.input"],
    hit: createSyntheticSurfaceHit({ surfaceId: "debug-main", source: "xr-controller", uv: { u: 0.5, v: 0.5 }, widthPx: 100, heightPx: 100 }),
    kind: "pointer-down",
    source: "xr-controller",
    clientTimeMs: 10,
    seq: 4
  });
  applySurfaceInputResolution(state, accepted);

  assert.equal(state.acceptedEventCount, 1);
  assert.equal(state.lastEvent?.source, "xr-controller");
  assert.equal(state.seq, 4);

  applySurfaceInputResolution(state, { accepted: false, blockedReason: "missing-hit" });
  assert.equal(state.blockedReason, "missing-hit");
});

test("tryFocusSurface requires surface.select permission", () => {
  const state = createSurfaceInputDebugState("debug-main");
  const hit = createSyntheticSurfaceHit({ surfaceId: "debug-main", source: "mouse", uv: { u: 0.5, v: 0.5 }, widthPx: 100, heightPx: 100 });

  assert.equal(tryFocusSurface({ state, permissions: ["surface.input"], hit }), "missing-permission:surface.select");
  assert.equal(state.focusedSurfaceId, null);
  assert.equal(tryFocusSurface({ state, permissions: ["surface.select"], hit }), null);
  assert.equal(state.focusedSurfaceId, "debug-main");
});
