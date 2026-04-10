import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";

export type AvatarInteractionTarget =
  | { kind: "none" }
  | { kind: "floor"; point: THREE.Vector3 }
  | { kind: "seat"; point: THREE.Vector3; seatAnchor: SceneBundleSeatAnchor };

export function resolveAvatarInteractionTarget(input: {
  ray: THREE.Ray;
  seatAnchors: SceneBundleSeatAnchor[];
  teleportFloorY: number;
  maxDistance?: number;
}): AvatarInteractionTarget {
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
    const radius = anchor.radius;
    if (point.distanceTo(anchorCenter) > radius) {
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
      seatAnchor: bestSeat.anchor
    };
  }

  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -input.teleportFloorY);
  const floorPoint = input.ray.intersectPlane(plane, new THREE.Vector3());
  if (!floorPoint) {
    return { kind: "none" };
  }
  if (floorPoint.distanceTo(input.ray.origin) > maxDistance) {
    return { kind: "none" };
  }
  return {
    kind: "floor",
    point: floorPoint
  };
}
