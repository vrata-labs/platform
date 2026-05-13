import * as THREE from "three";

interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface XrInputSourceLike {
  handedness?: string;
  gripSpace?: unknown;
  targetRaySpace?: unknown;
  targetRayMode?: string;
}

interface XrPoseLike {
  transform?: {
    position?: Partial<Vector3Like>;
    orientation?: Partial<QuaternionLike>;
  };
}

interface XrFrameLike {
  getPose(space: unknown, referenceSpace: unknown): XrPoseLike | null | undefined;
}

interface XrSpatialLike {
  getWorldPosition(target: THREE.Vector3): THREE.Vector3;
  getWorldQuaternion?(target: THREE.Quaternion): THREE.Quaternion;
}

export interface XrPencilPose {
  sourceIndex: number;
  anchorWorld: THREE.Vector3;
  orientationWorld: THREE.Quaternion;
  tipWorld: THREE.Vector3;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);

function isVector3Like(value: Partial<Vector3Like> | null | undefined): value is Vector3Like {
  return typeof value?.x === "number" && typeof value.y === "number" && typeof value.z === "number";
}

function isQuaternionLike(value: Partial<QuaternionLike> | null | undefined): value is QuaternionLike {
  return typeof value?.x === "number" && typeof value.y === "number" && typeof value.z === "number" && typeof value.w === "number";
}

function applyPlayerTransform(position: THREE.Vector3, yaw: number, offset: Vector3Like): THREE.Vector3 {
  const x = position.x;
  const z = position.z;
  position.x = x * Math.cos(yaw) + z * Math.sin(yaw) + offset.x;
  position.y += offset.y;
  position.z = -x * Math.sin(yaw) + z * Math.cos(yaw) + offset.z;
  return position;
}

function applyPlayerYaw(orientation: THREE.Quaternion, yaw: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw).multiply(orientation).normalize();
}

function readPose(input: { frame?: XrFrameLike | null; referenceSpace?: unknown; space?: unknown }): {
  position: THREE.Vector3;
  orientation: THREE.Quaternion;
} | null {
  if (!input.frame || !input.referenceSpace || !input.space) {
    return null;
  }
  const pose = input.frame.getPose(input.space, input.referenceSpace);
  const position = pose?.transform?.position;
  const orientation = pose?.transform?.orientation;
  if (!isVector3Like(position) || !isQuaternionLike(orientation)) {
    return null;
  }
  return {
    position: new THREE.Vector3(position.x, position.y, position.z),
    orientation: new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w).normalize()
  };
}

function readSpatial(anchor: XrSpatialLike | null | undefined): {
  position: THREE.Vector3;
  orientation: THREE.Quaternion;
} | null {
  if (!anchor) {
    return null;
  }
  const position = new THREE.Vector3();
  anchor.getWorldPosition(position);
  const orientation = new THREE.Quaternion();
  anchor.getWorldQuaternion?.(orientation);
  return { position, orientation: orientation.normalize() };
}

function resolvePrimaryRightInputSourceIndex(inputSources: XrInputSourceLike[]): number {
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

function createPencilPose(input: {
  sourceIndex: number;
  anchor: { position: THREE.Vector3; orientation: THREE.Quaternion };
  playerOffset: Vector3Like;
  playerYaw: number;
  tipLocalZ: number;
}): XrPencilPose {
  const anchorWorld = applyPlayerTransform(input.anchor.position.clone(), input.playerYaw, input.playerOffset);
  const orientationWorld = applyPlayerYaw(input.anchor.orientation, input.playerYaw);
  const tipWorld = new THREE.Vector3(0, 0, input.tipLocalZ).applyQuaternion(orientationWorld).add(anchorWorld);
  return {
    sourceIndex: input.sourceIndex,
    anchorWorld,
    orientationWorld,
    tipWorld
  };
}

export function resolveSyntheticXrPencilPose(input: {
  anchor: Vector3Like;
  direction: Vector3Like;
  tipLocalZ: number;
  sourceIndex?: number;
}): XrPencilPose | null {
  const direction = new THREE.Vector3(input.direction.x, input.direction.y, input.direction.z);
  if (direction.lengthSq() === 0) {
    return null;
  }
  const orientationWorld = new THREE.Quaternion().setFromUnitVectors(LOCAL_FORWARD, direction.normalize()).normalize();
  const anchorWorld = new THREE.Vector3(input.anchor.x, input.anchor.y, input.anchor.z);
  return {
    sourceIndex: input.sourceIndex ?? 0,
    anchorWorld,
    orientationWorld,
    tipWorld: new THREE.Vector3(0, 0, input.tipLocalZ).applyQuaternion(orientationWorld).add(anchorWorld)
  };
}

export function resolveXrPencilPose(input: {
  presenting: boolean;
  inputSources: XrInputSourceLike[];
  grips: Array<XrSpatialLike | null | undefined>;
  controllers: Array<XrSpatialLike | null | undefined>;
  xrFrame?: XrFrameLike | null;
  referenceSpace?: unknown;
  playerOffset: Vector3Like;
  playerYaw: number;
  tipLocalZ: number;
}): XrPencilPose | null {
  if (!input.presenting) {
    return null;
  }
  const sourceIndex = resolvePrimaryRightInputSourceIndex(input.inputSources);
  if (sourceIndex < 0) {
    return null;
  }
  const source = input.inputSources[sourceIndex];
  const anchor = readPose({ frame: input.xrFrame, referenceSpace: input.referenceSpace, space: source?.gripSpace })
    ?? readSpatial(input.grips[sourceIndex])
    ?? readPose({ frame: input.xrFrame, referenceSpace: input.referenceSpace, space: source?.targetRaySpace })
    ?? readSpatial(input.controllers[sourceIndex]);
  if (!anchor) {
    return null;
  }
  return createPencilPose({
    sourceIndex,
    anchor,
    playerOffset: input.playerOffset,
    playerYaw: input.playerYaw,
    tipLocalZ: input.tipLocalZ
  });
}
