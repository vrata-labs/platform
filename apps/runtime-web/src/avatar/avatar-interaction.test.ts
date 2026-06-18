import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { resolveAvatarInteractionTarget } from "./avatar-interaction.js";

test("resolveAvatarInteractionTarget prioritizes seat anchor over floor hit", () => {
  const target = resolveAvatarInteractionTarget({
    ray: new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -0.5, -1).normalize()),
    seatAnchors: [{
      id: "seat-a",
      position: { x: 0, y: 0, z: -2 },
      yaw: 0,
      seatHeight: 0.5,
      radius: 0.8
    }],
    teleportFloorY: 0
  });

  assert.equal(target.kind, "seat");
  if (target.kind === "seat") {
    assert.equal(target.seatAnchor.id, "seat-a");
  }
});

test("resolveAvatarInteractionTarget falls back to floor hit when no seat matches", () => {
  const target = resolveAvatarInteractionTarget({
    ray: new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0).normalize()),
    seatAnchors: [],
    teleportFloorY: 0
  });

  assert.equal(target.kind, "floor");
  if (target.kind === "floor") {
    assert.equal(target.point.y, 0);
  }
});

test("resolveAvatarInteractionTarget returns none when ray misses floor plane within distance", () => {
  const target = resolveAvatarInteractionTarget({
    ray: new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0).normalize()),
    seatAnchors: [],
    teleportFloorY: 0
  });

  assert.equal(target.kind, "none");
});
