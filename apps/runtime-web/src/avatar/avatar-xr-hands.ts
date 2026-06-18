import * as THREE from "three";

export interface AvatarHandTarget {
  x: number;
  y: number;
  z: number;
}

export interface AvatarHandOrientation {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface AvatarHandPose {
  position: AvatarHandTarget;
  orientation: AvatarHandOrientation;
  sourceIndex: number;
}

export interface XrSpatialLike {
  getWorldPosition(target: THREE.Vector3): THREE.Vector3;
  getWorldQuaternion?(target: THREE.Quaternion): THREE.Quaternion;
}

export interface XrInputSourceLike {
  handedness?: string;
  gripSpace?: unknown;
  targetRaySpace?: unknown;
  targetRayMode?: string;
}

export interface XrFrameLike {
  getPose(space: unknown, referenceSpace: unknown): {
    transform?: {
      position?: { x?: number; y?: number; z?: number };
      orientation?: { x?: number; y?: number; z?: number; w?: number };
    }
  } | null | undefined;
}

export interface XrHandResolutionDebug {
  leftGrip: AvatarHandTarget | null;
  rightGrip: AvatarHandTarget | null;
  leftController: AvatarHandTarget | null;
  rightController: AvatarHandTarget | null;
  leftResolved: AvatarHandTarget | null;
  rightResolved: AvatarHandTarget | null;
}

export interface AvatarHandTargets {
  leftHand: AvatarHandTarget | null;
  rightHand: AvatarHandTarget | null;
}

export interface AvatarHandPoses {
  leftHand: AvatarHandPose | null;
  rightHand: AvatarHandPose | null;
}

export interface LocalAvatarHandFrameResult {
  debug: XrHandResolutionDebug;
  worldHands: AvatarHandTargets;
  controllerWorldHands: AvatarHandTargets;
  worldHandPoses: AvatarHandPoses;
  controllerWorldHandPoses: AvatarHandPoses;
}

interface RawHandPose {
  position: THREE.Vector3;
  orientation: THREE.Quaternion;
  sourceIndex: number;
}

interface RawHandPoseResolutionDebug {
  leftGrip: RawHandPose | null;
  rightGrip: RawHandPose | null;
  leftController: RawHandPose | null;
  rightController: RawHandPose | null;
  leftResolved: RawHandPose | null;
  rightResolved: RawHandPose | null;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);

function avatarTargetFromVector(input: THREE.Vector3): AvatarHandTarget {
  return {
    x: input.x,
    y: input.y,
    z: input.z
  };
}

function avatarOrientationFromQuaternion(input: THREE.Quaternion): AvatarHandOrientation {
  return {
    x: input.x,
    y: input.y,
    z: input.z,
    w: input.w
  };
}

function isVector3Like(value: { x?: number; y?: number; z?: number } | null | undefined): value is { x: number; y: number; z: number } {
  return typeof value?.x === "number" && typeof value.y === "number" && typeof value.z === "number";
}

function isQuaternionLike(value: { x?: number; y?: number; z?: number; w?: number } | null | undefined): value is { x: number; y: number; z: number; w: number } {
  return typeof value?.x === "number" && typeof value.y === "number" && typeof value.z === "number" && typeof value.w === "number";
}

function readWorldPose(anchor: XrSpatialLike | null | undefined, sourceIndex: number): RawHandPose | null {
  if (!anchor) {
    return null;
  }
  const worldPosition = new THREE.Vector3();
  anchor.getWorldPosition(worldPosition);
  const worldOrientation = new THREE.Quaternion();
  anchor.getWorldQuaternion?.(worldOrientation);
  return {
    position: worldPosition,
    orientation: worldOrientation.normalize(),
    sourceIndex
  };
}

function readPoseTarget(frame: XrFrameLike | null | undefined, referenceSpace: unknown, space: unknown, sourceIndex: number): RawHandPose | null {
  if (!frame || !referenceSpace || !space) {
    return null;
  }
  const pose = frame.getPose(space, referenceSpace);
  const position = pose?.transform?.position;
  if (!isVector3Like(position)) {
    return null;
  }
  const orientation = pose?.transform?.orientation;
  return {
    position: new THREE.Vector3(position.x, position.y, position.z),
    orientation: isQuaternionLike(orientation)
      ? new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w).normalize()
      : new THREE.Quaternion(),
    sourceIndex
  };
}

function applyPlayerTransform(position: THREE.Vector3, yaw: number, offset: { x: number; y: number; z: number }): THREE.Vector3 {
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

function createAvatarHandPose(input: {
  raw: RawHandPose;
  playerOffset?: { x: number; y: number; z: number };
  playerYaw?: number;
}): AvatarHandPose {
  const offset = input.playerOffset ?? { x: 0, y: 0, z: 0 };
  const yaw = input.playerYaw ?? 0;
  const position = applyPlayerTransform(input.raw.position.clone(), yaw, offset);
  const orientation = applyPlayerYaw(input.raw.orientation.clone(), yaw);
  return {
    position: avatarTargetFromVector(position),
    orientation: avatarOrientationFromQuaternion(orientation),
    sourceIndex: input.raw.sourceIndex
  };
}

function createRawPoseDebug(input: {
  inputSources: XrInputSourceLike[];
  grips: Array<XrSpatialLike | null | undefined>;
  controllers: Array<XrSpatialLike | null | undefined>;
  xrFrame?: XrFrameLike | null;
  referenceSpace?: unknown;
}): RawHandPoseResolutionDebug {
  const result: RawHandPoseResolutionDebug = {
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
    const grip = readPoseTarget(input.xrFrame, input.referenceSpace, source.gripSpace, index) ?? readWorldPose(input.grips[index], index);
    const controller = readPoseTarget(input.xrFrame, input.referenceSpace, source.targetRaySpace, index) ?? readWorldPose(input.controllers[index], index);
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

function publicDebugFromRawDebug(input: RawHandPoseResolutionDebug): XrHandResolutionDebug {
  return {
    leftGrip: input.leftGrip ? avatarTargetFromVector(input.leftGrip.position) : null,
    rightGrip: input.rightGrip ? avatarTargetFromVector(input.rightGrip.position) : null,
    leftController: input.leftController ? avatarTargetFromVector(input.leftController.position) : null,
    rightController: input.rightController ? avatarTargetFromVector(input.rightController.position) : null,
    leftResolved: input.leftResolved ? avatarTargetFromVector(input.leftResolved.position) : null,
    rightResolved: input.rightResolved ? avatarTargetFromVector(input.rightResolved.position) : null
  };
}

function resolveHandPosesFromRawDebug(input: {
  presenting: boolean;
  debug: RawHandPoseResolutionDebug;
  playerOffset?: { x: number; y: number; z: number };
  playerYaw?: number;
  preferController?: boolean;
}): AvatarHandPoses {
  if (!input.presenting) {
    return { leftHand: null, rightHand: null };
  }

  const leftTarget = input.preferController ? (input.debug.leftController ?? input.debug.leftResolved) : input.debug.leftResolved;
  const rightTarget = input.preferController ? (input.debug.rightController ?? input.debug.rightResolved) : input.debug.rightResolved;
  return {
    leftHand: leftTarget ? createAvatarHandPose({ raw: leftTarget, playerOffset: input.playerOffset, playerYaw: input.playerYaw }) : null,
    rightHand: rightTarget ? createAvatarHandPose({ raw: rightTarget, playerOffset: input.playerOffset, playerYaw: input.playerYaw }) : null
  };
}

function targetsFromPoses(input: AvatarHandPoses): AvatarHandTargets {
  return {
    leftHand: input.leftHand?.position ?? null,
    rightHand: input.rightHand?.position ?? null
  };
}

export function collectLocalAvatarHandDebug(input: {
  inputSources: XrInputSourceLike[];
  grips: Array<XrSpatialLike | null | undefined>;
  controllers: Array<XrSpatialLike | null | undefined>;
  xrFrame?: XrFrameLike | null;
  referenceSpace?: unknown;
}): XrHandResolutionDebug {
  return publicDebugFromRawDebug(createRawPoseDebug(input));
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
  preferController?: boolean;
}): AvatarHandTargets {
  if (!input.presenting) {
    return { leftHand: null, rightHand: null };
  }

  const frame = resolveLocalAvatarHandFrame(input);
  return input.preferController ? frame.controllerWorldHands : frame.worldHands;
}

export function createSyntheticLocalAvatarHandFrame(input: {
  rightController: AvatarHandTarget;
  rightGrip?: AvatarHandTarget | null;
  rayDirection: AvatarHandTarget;
}): LocalAvatarHandFrameResult {
  const direction = new THREE.Vector3(input.rayDirection.x, input.rayDirection.y, input.rayDirection.z);
  const orientation = direction.lengthSq() > 0
    ? new THREE.Quaternion().setFromUnitVectors(LOCAL_FORWARD, direction.normalize()).normalize()
    : new THREE.Quaternion();
  const createPose = (position: AvatarHandTarget): AvatarHandPose => ({
    position: { ...position },
    orientation: avatarOrientationFromQuaternion(orientation),
    sourceIndex: 0
  });
  const rightGrip = input.rightGrip ?? null;
  const rightController = input.rightController;
  const rightResolved = rightGrip ?? rightController;
  const worldHandPoses = { leftHand: null, rightHand: createPose(rightResolved) };
  const controllerWorldHandPoses = { leftHand: null, rightHand: createPose(rightController) };
  return {
    debug: {
      leftGrip: null,
      rightGrip: rightGrip ? { ...rightGrip } : null,
      leftController: null,
      rightController: { ...rightController },
      leftResolved: null,
      rightResolved: { ...rightResolved }
    },
    worldHands: targetsFromPoses(worldHandPoses),
    controllerWorldHands: targetsFromPoses(controllerWorldHandPoses),
    worldHandPoses,
    controllerWorldHandPoses
  };
}

export function resolveLocalAvatarHandFrame(input: {
  presenting: boolean;
  inputSources: XrInputSourceLike[];
  grips: Array<XrSpatialLike | null | undefined>;
  controllers: Array<XrSpatialLike | null | undefined>;
  xrFrame?: XrFrameLike | null;
  referenceSpace?: unknown;
  playerOffset?: { x: number; y: number; z: number };
  playerYaw?: number;
}): LocalAvatarHandFrameResult {
  const rawDebug = createRawPoseDebug(input);
  const worldHandPoses = resolveHandPosesFromRawDebug({
    presenting: input.presenting,
    debug: rawDebug,
    playerOffset: input.playerOffset,
    playerYaw: input.playerYaw
  });
  const controllerWorldHandPoses = resolveHandPosesFromRawDebug({
    presenting: input.presenting,
    debug: rawDebug,
    playerOffset: input.playerOffset,
    playerYaw: input.playerYaw,
    preferController: true
  });
  return {
    debug: publicDebugFromRawDebug(rawDebug),
    worldHands: targetsFromPoses(worldHandPoses),
    controllerWorldHands: targetsFromPoses(controllerWorldHandPoses),
    worldHandPoses,
    controllerWorldHandPoses
  };
}
