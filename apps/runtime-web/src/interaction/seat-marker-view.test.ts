import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import { createSeatMarkerViewController } from "./seat-marker-view.js";

function seatAnchor(id: string, x = 1): SceneBundleSeatAnchor {
  return {
    id,
    position: { x, y: 0, z: -2 },
    yaw: 0,
    seatHeight: 0.5,
    radius: 0.8,
    label: `Seat ${id}`
  };
}

function meshBasicMaterial(mesh: THREE.Mesh): THREE.MeshBasicMaterial {
  assert.ok(mesh.material instanceof THREE.MeshBasicMaterial);
  return mesh.material;
}

test("seat marker view rebuilds marker groups and hit meshes", () => {
  const controller = createSeatMarkerViewController();
  const anchors = [seatAnchor("a", 1), seatAnchor("b", -1)];

  controller.rebuild(anchors);

  assert.equal(controller.root.children.length, 2);
  assert.equal(controller.hitMeshes.length, 6);
  assert.equal(controller.hitMeshes.every((mesh) => mesh.userData.seatAnchorId === "a" || mesh.userData.seatAnchorId === "b"), true);
  assert.deepEqual(controller.getMarker("a")?.group.position.toArray(), [1, 0.5, -2]);

  controller.clear();

  assert.equal(controller.root.children.length, 0);
  assert.equal(controller.hitMeshes.length, 0);
  assert.equal(controller.getMarker("a"), null);
});

test("seat marker view colors current, hovered, pending, and occupied seats", () => {
  const controller = createSeatMarkerViewController();
  controller.rebuild([seatAnchor("current"), seatAnchor("hovered"), seatAnchor("pending"), seatAnchor("occupied"), seatAnchor("free")]);

  controller.update({
    hoveredSeatId: "hovered",
    currentSeatId: "current",
    pendingSeatId: "pending",
    occupancy: { occupied: "participant-b" },
    timeSeconds: 0
  });

  assert.equal(meshBasicMaterial(controller.getMarker("current")!.ring).color.getHex(), 0x66ff99);
  assert.equal(controller.getMarker("current")!.group.scale.x, 1.18);
  assert.equal(meshBasicMaterial(controller.getMarker("hovered")!.ring).color.getHex(), 0xb8ff8d);
  assert.equal(controller.getMarker("hovered")!.group.scale.x, 1.12);
  assert.equal(meshBasicMaterial(controller.getMarker("pending")!.ring).color.getHex(), 0xffd166);
  assert.equal(meshBasicMaterial(controller.getMarker("occupied")!.ring).color.getHex(), 0xff7b7b);
  assert.equal(meshBasicMaterial(controller.getMarker("occupied")!.ring).opacity, 0.55);
  assert.equal(meshBasicMaterial(controller.getMarker("free")!.ring).color.getHex(), 0x64d7ff);
});
