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

// A visual snapshot marks the collider as blocked without removing it from the ray.
// Reading this metadata is side-effect free and does not create a reservation system.
export function isSeatMarkerBlocked(seatId: string, hitMeshes: readonly THREE.Object3D[]): boolean {
  return hitMeshes.some((mesh) => mesh.userData.seatAnchorId === seatId && mesh.userData.seatMarkerBlocked === true);
}

export function resolveSeatMarkerTarget(input: {
  ray: THREE.Ray;
  seatMarkerHitMeshes: THREE.Object3D[];
  seatAnchorMap: ReadonlyMap<string, SceneBundleSeatAnchor>;
  raycaster: THREE.Raycaster;
  maxDistance?: number;
}): SeatMarkerTarget | null {
  if (input.seatMarkerHitMeshes.length === 0) {
    return null;
  }
  input.raycaster.ray.copy(input.ray);
  const intersections = input.raycaster.intersectObjects(input.seatMarkerHitMeshes, false);
  for (const hit of intersections) {
    if (hit.distance > (input.maxDistance ?? 20)) continue;
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
  const marker = resolveSeatMarkerTarget(input);
  const fallback = resolveInteractionTarget(input);
  // Do not tunnel through an occupied seat's existing interaction envelope to
  // either the floor or another marker. Free-seat marker priority is unchanged.
  if (fallback.kind === "seat" && isSeatMarkerBlocked(fallback.seatId, input.seatMarkerHitMeshes)
      && (!marker || fallback.point.distanceTo(input.ray.origin) <= marker.point.distanceTo(input.ray.origin))) {
    return { kind: "none" };
  }
  if (marker) {
    if (isSeatMarkerBlocked(marker.seatAnchor.id, input.seatMarkerHitMeshes)) return { kind: "none" };
    return {
      kind: "seat",
      point: marker.point,
      seatId: marker.seatAnchor.id,
      seatAnchor: marker.seatAnchor
    };
  }
  return fallback.kind === "seat" && isSeatMarkerBlocked(fallback.seatId, input.seatMarkerHitMeshes)
    ? { kind: "none" }
    : fallback;
}
