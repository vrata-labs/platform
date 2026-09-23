import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import { createInteractionCommandPlanner } from "../locomotion/interaction-command-planner.js";
import { resolveInteractionTargetForRay } from "./interaction-frame.js";
import { resolveInteractionTargetFromRay, resolveSeatMarkerTarget } from "./interaction-targets.js";
import { createSeatMarkerViewController, type SeatMarkerVisualState } from "./seat-marker-view.js";

const seat: SceneBundleSeatAnchor = {
  id: "seat", position: { x: 0, y: 0, z: -2 }, yaw: 0, seatHeight: 0.5, radius: 0.8
};
function state(overrides: Partial<SeatMarkerVisualState> = {}): SeatMarkerVisualState {
  return { hoveredSeatId: null, currentSeatId: null, pendingSeatId: null, occupancy: {}, timeSeconds: 0, ...overrides };
}
function fixture(seats = [seat]) {
  const view = createSeatMarkerViewController(); view.rebuild(seats);
  const targetPoint = new THREE.Vector3(0, 0.66, -2);
  const origin = new THREE.Vector3(0, 1.6, 0);
  const input = {
    ray: new THREE.Ray(origin, targetPoint.clone().sub(origin).normalize()),
    seatMarkerHitMeshes: view.hitMeshes,
    seatAnchorMap: new Map(seats.map(anchor => [anchor.id, anchor])),
    raycaster: new THREE.Raycaster(), seatAnchors: seats, teleportFloorY: 0, maxDistance: 18
  };
  return { view, input };
}

test("invisible picking volume accepts centre and oblique rays, not just rim or chevron", () => {
  const { view, input } = fixture();
  for (const origin of [new THREE.Vector3(0, 1.6, -2), new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(1, 0.9, -1)]) {
    input.ray.set(origin, new THREE.Vector3(0, 0.60, -2).sub(origin).normalize());
    const marker = resolveSeatMarkerTarget(input);
    assert.equal(marker?.seatAnchor.id, "seat");
    assert.equal(resolveInteractionTargetFromRay(input).kind, "seat");
  }
  view.clear();
});

test("rays outside the reduced artwork retain the original picking envelope and occupancy rules", () => {
  const { view, input } = fixture();
  const marker = view.getMarker("seat")!;
  const visualMeshes = [marker.bottom, marker.side, marker.cap, marker.top, marker.lowerRim, marker.upperRim, marker.direction];
  const rays = [
    // Between the new 19 cm visual radius and the retained 22 cm picking radius.
    new THREE.Ray(new THREE.Vector3(0.205, 1.6, -2), new THREE.Vector3(0, -1, 0)),
    // Above the new top/chevron, but still inside the old 14 cm picking height.
    new THREE.Ray(new THREE.Vector3(0, 0.65, 0), new THREE.Vector3(0, 0, -1))
  ];
  for (const ray of rays) {
    input.ray.copy(ray);
    input.raycaster.set(ray.origin, ray.direction);
    assert.equal(input.raycaster.intersectObjects(visualMeshes, false).length, 0);
    assert.equal(resolveSeatMarkerTarget(input)?.seatAnchor.id, "seat");
    assert.equal(resolveInteractionTargetFromRay(input).kind, "seat");
    for (const blocked of [state({ occupancy: { seat: "other" } }), state({ currentSeatId: "seat" })]) {
      view.update(blocked);
      assert.equal(resolveSeatMarkerTarget(input)?.seatAnchor.id, "seat");
      assert.deepEqual(resolveInteractionTargetFromRay(input), { kind: "none" });
    }
    view.update(state());
    assert.equal(resolveInteractionTargetFromRay(input).kind, "seat");
  }
  input.ray.set(new THREE.Vector3(0.225, 1.6, -2), new THREE.Vector3(0, -1, 0));
  assert.equal(resolveSeatMarkerTarget(input), null);
  view.clear();
});

test("occupied/current collider blocks floor fall-through and stale forced-seat hover", () => {
  const { view, input } = fixture();
  assert.equal(resolveInteractionTargetFromRay(input).kind, "seat");
  for (const snapshot of [state({ occupancy: { seat: "other" } }), state({ currentSeatId: "seat" })]) {
    view.update(snapshot);
    assert.equal(view.getMarker("seat")!.group.visible, false);
    // The invisible target remains in the hit list; removing it would expose the floor.
    assert.equal(resolveSeatMarkerTarget(input)?.seatAnchor.id, "seat");
    assert.deepEqual(resolveInteractionTargetFromRay(input), { kind: "none" });
    assert.deepEqual(resolveInteractionTargetForRay({ ...input, forcedSeatId: "seat" }), { kind: "none" });
    const planner = createInteractionCommandPlanner();
    assert.deepEqual(planner.plan({
      target: resolveInteractionTargetFromRay(input), currentSeatId: null, pendingSeatId: null,
      floorY: 0, seatingAvailable: true, nowMs: 1000
    }), []);
  }
  view.update(state());
  assert.equal(resolveInteractionTargetFromRay(input).kind, "seat");
  view.clear();
});

test("occupied anchor envelope is blocked even when ray misses the smaller visual cylinder", () => {
  const { view, input } = fixture();
  input.ray.set(new THREE.Vector3(0.4, 1.6, -2), new THREE.Vector3(0, -1, 0));
  assert.equal(resolveSeatMarkerTarget(input), null);
  assert.equal(resolveInteractionTargetFromRay(input).kind, "seat");
  view.update(state({ occupancy: { seat: "other" } }));
  assert.deepEqual(resolveInteractionTargetFromRay(input), { kind: "none" });
  view.clear();
});

test("a free marker behind an occupied anchor envelope cannot steal the ray", () => {
  const front = { ...seat, position: { x: 0.4, y: 0, z: -1 }, id: "front" };
  const { view, input } = fixture([front, seat]);
  input.ray.set(new THREE.Vector3(0, 0.60, 0), new THREE.Vector3(0, 0, -1));
  assert.equal(resolveSeatMarkerTarget(input)?.seatAnchor.id, "seat");
  view.update(state({ occupancy: { front: "other" } }));
  assert.deepEqual(resolveInteractionTargetFromRay(input), { kind: "none" });
  view.clear();
});

test("marker hit respects distance limit", () => {
  const { view, input } = fixture();
  input.maxDistance = 0.5;
  assert.equal(resolveSeatMarkerTarget(input), null);
  assert.deepEqual(resolveInteractionTargetFromRay(input), { kind: "none" });
  view.clear();
});

test("pending confirmation is not duplicated and hiding own marker preserves floor release and transfer", () => {
  const next = { ...seat, id: "next", position: { x: 3, y: 0, z: -2 } };
  const { view, input } = fixture([seat, next]);
  const planner = createInteractionCommandPlanner();
  const context = { currentSeatId: null, pendingSeatId: "seat", floorY: 0, seatingAvailable: true, nowMs: 1000 };
  assert.deepEqual(planner.plan({ ...context, target: resolveInteractionTargetFromRay(input) }), []);
  view.update(state({ currentSeatId: "seat", occupancy: { seat: "self" } }));
  input.ray.set(new THREE.Vector3(3, 1.6, 0), new THREE.Vector3(0, 0.6 - 1.6, -2).normalize());
  const transfer = planner.plan({ ...context, target: resolveInteractionTargetFromRay(input), currentSeatId: "seat", pendingSeatId: null, nowMs: 2000 });
  assert.ok(transfer.some(command => command.type === "send_seat_claim" && command.seatId === "next"));
  input.ray.set(new THREE.Vector3(5, 1.6, 0), new THREE.Vector3(0, -1, 0));
  const floor = resolveInteractionTargetFromRay(input);
  assert.equal(floor.kind, "floor");
  const release = planner.plan({ ...context, target: floor, currentSeatId: "seat", pendingSeatId: null, nowMs: 3000 });
  assert.ok(release.some(command => command.type === "send_seat_release" && command.seatId === "seat"));
  assert.ok(release.some(command => command.type === "release_local_seat"));
  assert.ok(release.some(command => command.type === "teleport_to_floor"));
  view.clear();
});
