import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";

export type InteractionTarget =
  | { kind: "none" }
  | { kind: "floor"; point: THREE.Vector3 }
  | { kind: "seat"; point: THREE.Vector3; seatId: string; seatAnchor: SceneBundleSeatAnchor };

export interface SeatMarkerTarget {
  point: THREE.Vector3;
  seatAnchor: SceneBundleSeatAnchor;
}

export function resolveSeatMarkerTarget(input: {
  ray: THREE.Ray;
  seatMarkerHitMeshes: THREE.Object3D[];
  seatAnchorMap: ReadonlyMap<string, SceneBundleSeatAnchor>;
  raycaster: THREE.Raycaster;
}): SeatMarkerTarget | null {
  if (input.seatMarkerHitMeshes.length === 0) {
    return null;
  }
  input.raycaster.ray.copy(input.ray);
  const intersections = input.raycaster.intersectObjects(input.seatMarkerHitMeshes, false);
  for (const hit of intersections) {
    const seatAnchorId = typeof hit.object.userData.seatAnchorId === "string" ? hit.object.userData.seatAnchorId : null;
    if (!seatAnchorId) {
      continue;
    }
    const seatAnchor = input.seatAnchorMap.get(seatAnchorId);
    if (!seatAnchor) {
      continue;
    }
    return {
      point: hit.point.clone(),
      seatAnchor
    };
  }
  return null;
}

export function resolveInteractionTarget(input: {
  ray: THREE.Ray;
  seatAnchors: SceneBundleSeatAnchor[];
  teleportFloorY: number;
  maxDistance?: number;
}): InteractionTarget {
  const maxDistance = input.maxDistance ?? 20;
  let bestSeat: { anchor: SceneBundleSeatAnchor; distance: number; point: THREE.Vector3 } | null = null;
  for (const anchor of input.seatAnchors) {
    const toAnchor = new THREE.Vector3(anchor.position.x, anchor.position.y + anchor.seatHeight, anchor.position.z).sub(input.ray.origin);
    const distanceAlongRay = toAnchor.dot(input.ray.direction);
    if (distanceAlongRay < 0 || distanceAlongRay > maxDistance) {
      continue;
    }
    const point = input.ray.at(distanceAlongRay, new THREE.Vector3());
    const anchorCenter = new THREE.Vector3(anchor.position.x, anchor.position.y + anchor.seatHeight, anchor.position.z);
    if (point.distanceTo(anchorCenter) > anchor.radius) {
      continue;
    }
    if (!bestSeat || distanceAlongRay < bestSeat.distance) {
      bestSeat = { anchor, distance: distanceAlongRay, point };
    }
  }
  if (bestSeat) {
    return {
      kind: "seat",
      point: bestSeat.point,
      seatId: bestSeat.anchor.id,
      seatAnchor: bestSeat.anchor
    };
  }

  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -input.teleportFloorY);
  const floorPoint = input.ray.intersectPlane(plane, new THREE.Vector3());
  if (!floorPoint || floorPoint.distanceTo(input.ray.origin) > maxDistance) {
    return { kind: "none" };
  }
  return {
    kind: "floor",
    point: floorPoint
  };
}

export function resolveInteractionTargetFromRay(input: {
  ray: THREE.Ray;
  seatMarkerHitMeshes: THREE.Object3D[];
  seatAnchorMap: ReadonlyMap<string, SceneBundleSeatAnchor>;
  raycaster: THREE.Raycaster;
  seatAnchors: SceneBundleSeatAnchor[];
  teleportFloorY: number;
  maxDistance?: number;
}): InteractionTarget {
  const seatMarkerTarget = resolveSeatMarkerTarget(input);
  if (seatMarkerTarget) {
    return {
      kind: "seat",
      point: seatMarkerTarget.point,
      seatId: seatMarkerTarget.seatAnchor.id,
      seatAnchor: seatMarkerTarget.seatAnchor
    };
  }
  return resolveInteractionTarget({
    ray: input.ray,
    seatAnchors: input.seatAnchors,
    teleportFloorY: input.teleportFloorY,
    maxDistance: input.maxDistance
  });
}
