import type { AvatarPoseProfile } from "./avatar-visibility.js";

export interface AvatarPosePoint {
  x: number;
  y: number;
  z: number;
}

export interface AvatarUpperBodySolveResult {
  solveState: "active" | "fallback";
  headLocal: AvatarPosePoint;
  leftHandLocal: AvatarPosePoint;
  rightHandLocal: AvatarPosePoint;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rotateAroundYaw(point: AvatarPosePoint, yaw: number): AvatarPosePoint {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: point.x * cos - point.z * sin,
    y: point.y,
    z: point.x * sin + point.z * cos
  };
}

function toLocal(root: AvatarPosePoint, point: AvatarPosePoint, rootYaw = 0): AvatarPosePoint {
  const translated = {
    x: point.x - root.x,
    y: point.y - root.y,
    z: point.z - root.z
  };
  return {
    ...rotateAroundYaw(translated, -rootYaw)
  };
}

function clampHead(point: AvatarPosePoint): AvatarPosePoint {
  return {
    x: clamp(point.x, -0.25, 0.25),
    y: clamp(point.y, 1.25, 1.9),
    z: clamp(point.z, -0.25, 0.25)
  };
}

function clampHand(point: AvatarPosePoint, side: "left" | "right"): AvatarPosePoint {
  const lateralMin = side === "left" ? -0.75 : 0.05;
  const lateralMax = side === "left" ? -0.05 : 0.75;
  return {
    x: clamp(point.x, lateralMin, lateralMax),
    y: clamp(point.y, 0.65, 1.75),
    z: clamp(point.z, -0.6, 0.45)
  };
}

export function solveUpperBodyPose(input: {
  root: AvatarPosePoint;
  head: AvatarPosePoint;
  leftHand?: AvatarPosePoint | null;
  rightHand?: AvatarPosePoint | null;
  inputMode: "desktop" | "mobile" | "vr-controller" | "vr-hand";
  poseProfile?: AvatarPoseProfile;
  rootYaw?: number;
}): AvatarUpperBodySolveResult {
  const headLocal = clampHead(toLocal(input.root, input.head, input.rootYaw));
  const poseProfile = input.poseProfile;
  const leftFallback = {
    x: -(poseProfile?.handSpread ?? (input.inputMode === "mobile" ? 0.22 : 0.28)),
    y: poseProfile?.handHeight ?? (input.inputMode === "mobile" ? 1.02 : 1.16),
    z: poseProfile?.handForward ?? (input.inputMode === "desktop" ? -0.08 : 0.12)
  };
  const rightFallback = {
    x: poseProfile?.handSpread ?? (input.inputMode === "mobile" ? 0.22 : 0.28),
    y: poseProfile?.handHeight ?? (input.inputMode === "mobile" ? 1.02 : 1.16),
    z: poseProfile?.handForward ?? (input.inputMode === "desktop" ? -0.08 : 0.12)
  };

  const leftHandLocal = clampHand(
    input.leftHand ? toLocal(input.root, input.leftHand, input.rootYaw) : leftFallback,
    "left"
  );
  const rightHandLocal = clampHand(
    input.rightHand ? toLocal(input.root, input.rightHand, input.rootYaw) : rightFallback,
    "right"
  );

  return {
    solveState: input.leftHand && input.rightHand ? "active" : "fallback",
    headLocal,
    leftHandLocal,
    rightHandLocal
  };
}
