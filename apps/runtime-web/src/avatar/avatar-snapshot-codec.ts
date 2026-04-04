import { mapAvatarLocomotionStateToMode, type AvatarLocomotionState } from "./avatar-locomotion.js";
import type { AvatarReliableState, CompactPoseFrame, LocalAvatarSnapshotV1 } from "./avatar-types.js";

function rotateAroundYaw(point: { x: number; y: number; z: number }, yaw: number): { x: number; y: number; z: number } {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: point.x * cos - point.z * sin,
    y: point.y,
    z: point.x * sin + point.z * cos
  };
}

function toWorldPoint(snapshot: LocalAvatarSnapshotV1, point: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const rotated = rotateAroundYaw(point, snapshot.root.yaw);
  return {
    x: snapshot.root.x + rotated.x,
    y: snapshot.root.y + rotated.y,
    z: snapshot.root.z + rotated.z
  };
}

function estimateSpeed(snapshot: LocalAvatarSnapshotV1): number {
  switch (snapshot.locomotionState) {
    case "walk":
      return 1;
    case "strafe":
      return 0.85;
    case "backpedal":
      return 0.7;
    case "turn":
      return 0;
    default:
      return 0;
  }
}

function estimateAngularVelocity(snapshot: LocalAvatarSnapshotV1): number {
  return snapshot.locomotionState === "turn" ? 1 : 0;
}

function encodeFlags(snapshot: LocalAvatarSnapshotV1): number {
  let flags = 0;
  if (snapshot.leftHand.visible) {
    flags |= 1;
  }
  if (snapshot.rightHand.visible) {
    flags |= 1 << 1;
  }
  if (snapshot.visibilityState === "hands-only") {
    flags |= 1 << 2;
  }
  if (snapshot.fallbackReason) {
    flags |= 1 << 3;
  }
  return flags;
}

export function serializeReliableAvatarState(input: {
  participantId: string;
  snapshot: LocalAvatarSnapshotV1;
  muted: boolean;
  audioActive: boolean;
  seated?: boolean;
  seatId?: string;
}): AvatarReliableState {
  return {
    participantId: input.participantId,
    avatarId: input.snapshot.avatarId,
    recipeVersion: 1,
    inputMode: input.snapshot.inputMode,
    seated: input.seated ?? false,
    seatId: input.seatId,
    muted: input.muted,
    audioActive: input.audioActive,
    updatedAt: input.snapshot.updatedAt
  };
}

export function serializeCompactPoseFrame(input: {
  seq: number;
  sentAtMs: number;
  snapshot: LocalAvatarSnapshotV1;
}): CompactPoseFrame {
  const headWorld = toWorldPoint(input.snapshot, input.snapshot.head);
  const leftHandWorld = toWorldPoint(input.snapshot, input.snapshot.leftHand);
  const rightHandWorld = toWorldPoint(input.snapshot, input.snapshot.rightHand);
  return {
    seq: input.seq,
    sentAtMs: input.sentAtMs,
    flags: encodeFlags(input.snapshot),
    root: {
      x: input.snapshot.root.x,
      y: input.snapshot.root.y,
      z: input.snapshot.root.z,
      yaw: input.snapshot.root.yaw,
      vx: 0,
      vz: estimateSpeed(input.snapshot)
    },
    head: {
      x: headWorld.x,
      y: headWorld.y,
      z: headWorld.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1
    },
    leftHand: {
      x: leftHandWorld.x,
      y: leftHandWorld.y,
      z: leftHandWorld.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      gesture: input.snapshot.leftHand.visible ? 1 : 0
    },
    rightHand: {
      x: rightHandWorld.x,
      y: rightHandWorld.y,
      z: rightHandWorld.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      gesture: input.snapshot.rightHand.visible ? 1 : 0
    },
    locomotion: {
      mode: mapAvatarLocomotionStateToMode(input.snapshot.locomotionState as AvatarLocomotionState),
      speed: estimateSpeed(input.snapshot),
      angularVelocity: estimateAngularVelocity(input.snapshot)
    }
  };
}
