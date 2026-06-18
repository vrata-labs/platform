import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import { resolveInteractionTargetFromRay, resolveSeatMarkerTarget } from "./interaction-targets.js";

function seatAnchor(id: string): SceneBundleSeatAnchor {
  return {
    id,
    position: { x: 0, y: 0, z: -2 },
    yaw: 0,
    seatHeight: 0.5,
    radius: 0.8
  };
}

function seatMarkerMesh(seatAnchorId: string | null): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial());
  mesh.position.set(0, 0.5, -2);
  if (seatAnchorId !== null) {
    mesh.userData.seatAnchorId = seatAnchorId;
  }
  mesh.updateMatrixWorld(true);
  return mesh;
}

function forwardRay(): THREE.Ray {
  return new THREE.Ray(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0, 0, -1));
}

test("resolveSeatMarkerTarget returns marker seat hit from userData anchor id", () => {
  const anchor = seatAnchor("seat-a");
  const target = resolveSeatMarkerTarget({
    ray: forwardRay(),
    seatMarkerHitMeshes: [seatMarkerMesh(anchor.id)],
    seatAnchorMap: new Map([[anchor.id, anchor]]),
    raycaster: new THREE.Raycaster()
  });

  assert.ok(target);
  assert.equal(target!.seatAnchor.id, anchor.id);
  assert.equal(Number(target!.point.z.toFixed(2)), -1.75);
});

test("resolveSeatMarkerTarget ignores marker hits without known anchors", () => {
  const target = resolveSeatMarkerTarget({
    ray: forwardRay(),
    seatMarkerHitMeshes: [seatMarkerMesh("missing-seat")],
    seatAnchorMap: new Map(),
    raycaster: new THREE.Raycaster()
  });

  assert.equal(target, null);
});

test("resolveInteractionTargetFromRay prioritizes marker seats over floor fallback", () => {
  const anchor = seatAnchor("seat-marker");
  const target = resolveInteractionTargetFromRay({
    ray: forwardRay(),
    seatMarkerHitMeshes: [seatMarkerMesh(anchor.id)],
    seatAnchorMap: new Map([[anchor.id, anchor]]),
    raycaster: new THREE.Raycaster(),
    seatAnchors: [],
    teleportFloorY: 0,
    maxDistance: 18
  });

  assert.equal(target.kind, "seat");
  if (target.kind === "seat") {
    assert.equal(target.seatId, anchor.id);
  }
});

test("resolveInteractionTargetFromRay falls back when marker hit has no seat anchor", () => {
  const target = resolveInteractionTargetFromRay({
    ray: new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)),
    seatMarkerHitMeshes: [seatMarkerMesh("missing-seat")],
    seatAnchorMap: new Map(),
    raycaster: new THREE.Raycaster(),
    seatAnchors: [],
    teleportFloorY: 0,
    maxDistance: 18
  });

  assert.equal(target.kind, "floor");
  if (target.kind === "floor") {
    assert.equal(target.point.y, 0);
  }
});
