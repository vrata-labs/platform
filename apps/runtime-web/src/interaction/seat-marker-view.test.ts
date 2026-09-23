import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import { createLocalPoseController } from "../local/local-pose.js";
import { SEAT_MARKER_COLORS, SEAT_MARKER_DIMENSIONS } from "./seat-marker-geometry.js";
import { createSeatMarkerViewController, type SeatMarkerVisualState } from "./seat-marker-view.js";

function anchor(id = "seat", yaw = 0): SceneBundleSeatAnchor {
  return { id, position: { x: 1, y: 0.1, z: -2 }, yaw, seatHeight: 0.5, radius: 0.8 };
}
function state(overrides: Partial<SeatMarkerVisualState> = {}): SeatMarkerVisualState {
  return { hoveredSeatId: null, currentSeatId: null, pendingSeatId: null, occupancy: {}, timeSeconds: 0, ...overrides };
}
function near(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

test("seat marker is one assembled round volume at seat height, independent of interaction radius", () => {
  const controller = createSeatMarkerViewController();
  const seats = [anchor("a"), { ...anchor("b"), radius: 3 }];
  controller.rebuild(seats);
  assert.equal(controller.root.children.length, 2);
  assert.equal(controller.hitMeshes.length, 2);
  const marker = controller.getMarker("a")!;
  assert.deepEqual(marker.group.position.toArray(), [1, 0.6, -2]);
  assert.equal(marker.hit.material.visible, false);
  assert.equal(marker.hit.userData.seatAnchorId, "a");
  assert.equal(marker.top.geometry, controller.getMarker("b")!.top.geometry);
  assert.notEqual(marker.top.material, controller.getMarker("b")!.top.material);
  assert.equal("beacon" in marker || "orb" in marker, false);
  const bounds = new THREE.Box3().setFromObject(marker.group);
  near(bounds.getSize(new THREE.Vector3()).x, SEAT_MARKER_DIMENSIONS.diameter);
  near(bounds.min.y, 0.6 + SEAT_MARKER_DIMENSIONS.seatGap);
  near(bounds.max.y, 0.6 + SEAT_MARKER_DIMENSIONS.seatGap + SEAT_MARKER_DIMENSIONS.height + SEAT_MARKER_DIMENSIONS.arrowLift);
  const side = new THREE.Box3().setFromObject(marker.side);
  const cap = new THREE.Box3().setFromObject(marker.cap);
  near(side.max.y, cap.min.y);
  near(cap.max.y, marker.top.getWorldPosition(new THREE.Vector3()).y);
  near(side.min.y, marker.bottom.getWorldPosition(new THREE.Vector3()).y);
  assert.ok(side.getSize(new THREE.Vector3()).y > 0.12);
  controller.clear();
});

for (const yaw of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
  test(`chevron geometry points along the real seated camera forward at yaw ${yaw}`, () => {
    const controller = createSeatMarkerViewController();
    const seat = anchor("seat", yaw);
    controller.rebuild([seat]);
    const marker = controller.getMarker("seat")!;
    const positions = marker.direction.geometry.getAttribute("position");
    const tip = new THREE.Vector3(0, 0, Infinity);
    for (let index = 0; index < positions.count; index++) {
      if (positions.getZ(index) < tip.z) tip.fromBufferAttribute(positions, index);
    }
    near(tip.x, 0);
    assert.ok(tip.z < -0.04);
    const forward = marker.direction.localToWorld(tip).sub(marker.direction.getWorldPosition(new THREE.Vector3())).normalize();
    const player = new THREE.Group(), pitch = new THREE.Group(), camera = new THREE.PerspectiveCamera();
    player.add(pitch); pitch.add(camera);
    const pose = createLocalPoseController({ player, pitch });
    pose.lockToSeat(marker.group.position, "seat_enter", { yaw });
    near(forward.dot(camera.getWorldDirection(new THREE.Vector3())), 1);
    camera.position.set(3, 2, 1); camera.lookAt(-4, 1, -9);
    controller.update(state({ hoveredSeatId: "seat", timeSeconds: 2 }));
    assert.equal(marker.group.rotation.y, yaw);
    controller.clear();
  });
}

test("hover fades in 150ms without moving or scaling, and materials are seat-local", () => {
  const controller = createSeatMarkerViewController();
  controller.rebuild([anchor("a"), anchor("b")]);
  const a = controller.getMarker("a")!, b = controller.getMarker("b")!;
  const original = a.group.children.map(mesh => mesh.position.toArray());
  controller.update(state({ hoveredSeatId: "a" }));
  near(a.top.material.opacity, 0.19);
  controller.update(state({ hoveredSeatId: "a", timeSeconds: 0.075 }));
  assert.ok(a.top.material.opacity > 0.19 && a.top.material.opacity < 0.32);
  controller.update(state({ hoveredSeatId: "a", timeSeconds: 0.15 }));
  near(a.top.material.opacity, 0.32);
  assert.equal(a.top.material.color.getHex(), SEAT_MARKER_COLORS.hovered);
  near(b.top.material.opacity, 0.19);
  assert.equal(b.top.material.color.getHex(), SEAT_MARKER_COLORS.free);
  assert.deepEqual(a.group.scale.toArray(), [1, 1, 1]);
  assert.deepEqual(a.group.children.map(mesh => mesh.position.toArray()), original);
  assert.equal(a.side.material.depthTest, true);
  assert.equal(a.side.material.depthWrite, false);
  assert.equal(a.top.material.toneMapped, false);
  controller.clear();
});

test("hover interpolation depends on elapsed time, not frame rate, and tolerates a reset clock", () => {
  const opacityAt = (frames: number) => {
    const controller = createSeatMarkerViewController(); controller.rebuild([anchor()]);
    controller.update(state({ hoveredSeatId: "seat" }));
    for (let n = 1; n <= frames; n++) controller.update(state({ hoveredSeatId: "seat", timeSeconds: n * 0.1 / frames }));
    const opacity = controller.getMarker("seat")!.top.material.opacity;
    controller.update(state({ hoveredSeatId: "seat", timeSeconds: -1 }));
    near(controller.getMarker("seat")!.top.material.opacity, opacity);
    controller.update(state({ hoveredSeatId: "seat", timeSeconds: NaN }));
    near(controller.getMarker("seat")!.top.material.opacity, opacity);
    controller.clear(); return opacity;
  };
  near(opacityAt(3), opacityAt(9));
});

test("authoritative occupied/current wins over hover and pending, and released/rejected seats recover", () => {
  const controller = createSeatMarkerViewController(); controller.rebuild([anchor()]);
  const marker = controller.getMarker("seat")!;
  controller.update(state({ hoveredSeatId: "seat", pendingSeatId: "seat" }));
  assert.equal(marker.top.material.color.getHex(), SEAT_MARKER_COLORS.pending);
  assert.equal(marker.group.visible, true);
  for (const authoritative of [{ currentSeatId: "seat" }, { occupancy: { seat: "other" } }]) {
    controller.update(state({ hoveredSeatId: "seat", pendingSeatId: "seat", ...authoritative, timeSeconds: 1 }));
    assert.equal(marker.group.visible, false);
    assert.equal(marker.hit.userData.seatMarkerBlocked, true);
  }
  controller.update(state({ timeSeconds: 2 }));
  assert.equal(marker.group.visible, true);
  assert.equal(marker.hit.userData.seatMarkerBlocked, false);
  assert.equal(marker.top.material.color.getHex(), SEAT_MARKER_COLORS.free);
  near(marker.top.material.opacity, 0.19);
  controller.update(state({ pendingSeatId: "seat", timeSeconds: 3 }));
  controller.update(state({ timeSeconds: 4 }));
  assert.equal(marker.top.material.color.getHex(), SEAT_MARKER_COLORS.free);
  controller.update(state({ timeSeconds: 4.15 }));
  near(marker.top.material.opacity, 0.19);
  controller.clear();
});

test("clear disposes each owned shared resource once, preserves hit array, and leaves other controllers intact", () => {
  const controller = createSeatMarkerViewController(), other = createSeatMarkerViewController();
  controller.rebuild([anchor("a"), anchor("b")]); other.rebuild([anchor()]);
  const hitArray = controller.hitMeshes;
  const counts = new Map<THREE.BufferGeometry | THREE.Material, number>();
  controller.root.traverse(object => {
    if (object instanceof THREE.Mesh) {
      for (const resource of [object.geometry, ...(Array.isArray(object.material) ? object.material : [object.material])]) {
        if (counts.has(resource)) continue;
        counts.set(resource, 0);
        resource.addEventListener("dispose", () => counts.set(resource, counts.get(resource)! + 1));
      }
    }
  });
  let otherDisposed = false;
  other.getMarker("seat")!.top.geometry.addEventListener("dispose", () => { otherDisposed = true; });
  controller.clear(); controller.clear();
  assert.equal(controller.hitMeshes, hitArray);
  assert.equal(hitArray.length, 0);
  assert.equal(controller.getMarker("a"), null);
  assert.ok([...counts.values()].every(count => count === 1));
  assert.equal(otherDisposed, false);
  for (let n = 0; n < 3; n++) {
    controller.rebuild([anchor()]);
    assert.equal(controller.hitMeshes, hitArray);
    assert.equal(hitArray.length, 1);
    assert.equal(controller.root.children.length, 1);
  }
  controller.clear(); other.clear();
});
