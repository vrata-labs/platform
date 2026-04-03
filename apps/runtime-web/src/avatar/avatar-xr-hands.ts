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
  gripSpace?: unknown;
  targetRaySpace?: unknown;
}

export interface XrFrameLike {
  getPose(space: unknown, referenceSpace: unknown): { transform?: { position?: { x?: number; y?: number; z?: number } } } | null | undefined;
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

function readPoseTarget(frame: XrFrameLike | null | undefined, referenceSpace: unknown, space: unknown): AvatarHandTarget | null {
  if (!frame || !referenceSpace || !space) {
    return null;
  }
  const pose = frame.getPose(space, referenceSpace);
  const position = pose?.transform?.position;
  if (!position || typeof position.x !== "number" || typeof position.y !== "number" || typeof position.z !== "number") {
    return null;
  }
  return {
    x: position.x,
    y: position.y,
    z: position.z
  };
}

export function collectLocalAvatarHandDebug(input: {
  inputSources: XrInputSourceLike[];
  grips: Array<XrSpatialLike | null | undefined>;
  controllers: Array<XrSpatialLike | null | undefined>;
  xrFrame?: XrFrameLike | null;
  referenceSpace?: unknown;
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
    const grip = readPoseTarget(input.xrFrame, input.referenceSpace, source.gripSpace) ?? readWorldTarget(input.grips[index]);
    const controller = readPoseTarget(input.xrFrame, input.referenceSpace, source.targetRaySpace) ?? readWorldTarget(input.controllers[index]);
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
  xrFrame?: XrFrameLike | null;
  referenceSpace?: unknown;
  playerOffset?: { x: number; y: number; z: number };
  playerYaw?: number;
}): { leftHand: AvatarHandTarget | null; rightHand: AvatarHandTarget | null } {
  if (!input.presenting) {
    return { leftHand: null, rightHand: null };
  }

  const debug = collectLocalAvatarHandDebug(input);
  const offset = input.playerOffset ?? { x: 0, y: 0, z: 0 };
  const yaw = input.playerYaw ?? 0;
  const applyOffset = (target: AvatarHandTarget | null): AvatarHandTarget | null => target ? {
    x: target.x * Math.cos(yaw) - target.z * Math.sin(yaw) + offset.x,
    y: target.y + offset.y,
    z: target.x * Math.sin(yaw) + target.z * Math.cos(yaw) + offset.z
  } : null;
  return {
    leftHand: applyOffset(debug.leftResolved),
    rightHand: applyOffset(debug.rightResolved)
  };
}
