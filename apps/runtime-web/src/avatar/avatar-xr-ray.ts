import * as THREE from "three";

import type { XrFrameLike, XrInputSourceLike } from "./avatar-xr-hands.js";

export interface XrRayLike {
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  source: { index: number; handedness: string | null };
}

interface XrPoseWithOrientation {
  transform?: {
    position?: { x?: number; y?: number; z?: number };
    orientation?: { x?: number; y?: number; z?: number; w?: number };
  };
}

function applyPlayerOffset(position: THREE.Vector3, offset: { x: number; y: number; z: number }): THREE.Vector3 {
  position.x += offset.x;
  position.y += offset.y;
  position.z += offset.z;
  return position;
}

function applyPlayerTransform(position: THREE.Vector3, yaw: number, offset: { x: number; y: number; z: number }): THREE.Vector3 {
  const x = position.x;
  const z = position.z;
  position.x = x * Math.cos(yaw) - z * Math.sin(yaw) + offset.x;
  position.y = position.y + offset.y;
  position.z = x * Math.sin(yaw) + z * Math.cos(yaw) + offset.z;
  return position;
}

function applyYawToDirection(direction: THREE.Vector3, yaw: number): THREE.Vector3 {
  return direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).normalize();
}

export function resolvePrimaryRightInputSourceIndex(inputSources: XrInputSourceLike[]): number {
  const rightIndex = inputSources.findIndex((source) => source.handedness === "right");
  if (rightIndex >= 0) {
    return rightIndex;
  }
  const trackedIndex = inputSources.findIndex((source) => source.targetRayMode === "tracked-pointer");
  if (trackedIndex >= 0) {
    return trackedIndex;
  }
  return inputSources.length > 0 ? 0 : -1;
}

export function resolveXrInteractionRay(input: {
  inputSources: XrInputSourceLike[];
  xrFrame?: (XrFrameLike & { getPose(space: unknown, referenceSpace: unknown): XrPoseWithOrientation | null | undefined }) | null;
  referenceSpace?: unknown;
  playerOffset: { x: number; y: number; z: number };
  playerYaw: number;
}): XrRayLike | null {
  const index = resolvePrimaryRightInputSourceIndex(input.inputSources);
  if (index < 0) {
    return null;
  }
  const source = input.inputSources[index];
  if (!source?.targetRaySpace || !input.xrFrame || !input.referenceSpace) {
    return null;
  }
  const pose = input.xrFrame.getPose(source.targetRaySpace, input.referenceSpace);
  const position = pose?.transform?.position;
  const orientation = pose?.transform?.orientation;
  if (
    !position || typeof position.x !== "number" || typeof position.y !== "number" || typeof position.z !== "number"
    || !orientation || typeof orientation.x !== "number" || typeof orientation.y !== "number" || typeof orientation.z !== "number" || typeof orientation.w !== "number"
  ) {
    return null;
  }

  const origin = applyPlayerOffset(new THREE.Vector3(position.x, position.y, position.z), input.playerOffset);
  const direction = applyYawToDirection(
    new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w)),
    input.playerYaw
  );

  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    direction: { x: direction.x, y: direction.y, z: direction.z },
    source: {
      index,
      handedness: source.handedness ?? null
    }
  };
}
