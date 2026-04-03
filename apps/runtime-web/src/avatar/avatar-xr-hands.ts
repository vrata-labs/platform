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

export interface XrHandResolutionDebug {
  leftGrip: AvatarHandTarget | null;
  rightGrip: AvatarHandTarget | null;
  leftController: AvatarHandTarget | null;
  rightController: AvatarHandTarget | null;
  leftResolved: AvatarHandTarget | null;
  rightResolved: AvatarHandTarget | null;
}

function readWorldTarget(anchor: XrSpatialLike | null | undefined): AvatarHandTarget | null {
  if (!anchor) {
    return null;
  }
  const worldPosition = new THREE.Vector3();
  anchor.getWorldPosition(worldPosition);
  return {
    x: worldPosition.x,
    y: worldPosition.y,
    z: worldPosition.z
  };
}

export function collectLocalAvatarHandDebug(input: {
  inputSources: XrInputSourceLike[];
  grips: Array<XrSpatialLike | null | undefined>;
  controllers: Array<XrSpatialLike | null | undefined>;
}): XrHandResolutionDebug {
  const result: XrHandResolutionDebug = {
    leftGrip: null,
    rightGrip: null,
    leftController: null,
    rightController: null,
    leftResolved: null,
    rightResolved: null
  };

  for (const [index, source] of input.inputSources.entries()) {
    if (source.handedness !== "left" && source.handedness !== "right") {
      continue;
    }
    const grip = readWorldTarget(input.grips[index]);
    const controller = readWorldTarget(input.controllers[index]);
    const resolved = grip ?? controller;
    if (source.handedness === "left") {
      result.leftGrip = grip;
      result.leftController = controller;
      result.leftResolved = resolved;
    } else {
      result.rightGrip = grip;
      result.rightController = controller;
      result.rightResolved = resolved;
    }
  }

  return result;
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

  const debug = collectLocalAvatarHandDebug(input);
  return {
    leftHand: debug.leftResolved,
    rightHand: debug.rightResolved
  };
}
