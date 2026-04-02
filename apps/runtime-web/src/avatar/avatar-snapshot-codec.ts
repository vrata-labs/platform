import type { AvatarReliableState, CompactPoseFrame, LocalAvatarSnapshotV1 } from "./avatar-types.js";

function mapLocomotionMode(mode: string): number {
  switch (mode) {
    case "walk":
      return 1;
    case "strafe":
      return 2;
    case "backpedal":
      return 3;
    case "turn":
      return 4;
    case "idle":
    default:
      return 0;
  }
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
      x: input.snapshot.head.x,
      y: input.snapshot.head.y,
      z: input.snapshot.head.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1
    },
    leftHand: {
      x: input.snapshot.leftHand.x,
      y: input.snapshot.leftHand.y,
      z: input.snapshot.leftHand.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      gesture: input.snapshot.leftHand.visible ? 1 : 0
    },
    rightHand: {
      x: input.snapshot.rightHand.x,
      y: input.snapshot.rightHand.y,
      z: input.snapshot.rightHand.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      gesture: input.snapshot.rightHand.visible ? 1 : 0
    },
    locomotion: {
      mode: mapLocomotionMode(input.snapshot.locomotionState),
      speed: estimateSpeed(input.snapshot),
      angularVelocity: estimateAngularVelocity(input.snapshot)
    }
  };
}
