import * as THREE from "three";

export interface AvatarHandTarget {
  x: number;
  y: number;
  z: number;
}

export interface XrSpatialLike {
  getWorldPosition(target: THREE.Vector3): THREE.Vector3;
}

export interface XrInputSourceLike {
  handedness?: string;
}

export function resolveLocalAvatarHandTargets(input: {
  presenting: boolean;
  inputSources: XrInputSourceLike[];
  grips: Array<XrSpatialLike | null | undefined>;
  controllers: Array<XrSpatialLike | null | undefined>;
}): { leftHand: AvatarHandTarget | null; rightHand: AvatarHandTarget | null } {
  if (!input.presenting) {
    return { leftHand: null, rightHand: null };
  }

  const result = {
    leftHand: null as AvatarHandTarget | null,
    rightHand: null as AvatarHandTarget | null
  };

  for (const [index, source] of input.inputSources.entries()) {
    if (source.handedness !== "left" && source.handedness !== "right") {
      continue;
    }
    const anchor = input.grips[index] ?? input.controllers[index];
    if (!anchor) {
      continue;
    }
    const worldPosition = new THREE.Vector3();
    anchor.getWorldPosition(worldPosition);
    result[source.handedness === "left" ? "leftHand" : "rightHand"] = {
      x: worldPosition.x,
      y: worldPosition.y,
      z: worldPosition.z
    };
  }

  return result;
}
