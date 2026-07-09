import type { RoomPermission, RoomRole } from "@vrata/shared-types";

export interface TransformState {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
}

export type PresenceMode = "desktop" | "mobile" | "vr";

export interface PresenceState {
  participantId: string;
  displayName: string;
  role: RoomRole;
  permissions: RoomPermission[];
  mode: PresenceMode;
  rootTransform: TransformState;
  bodyTransform?: TransformState;
  headTransform?: TransformState;
  audioJoined?: boolean;
  muted: boolean;
  speaking?: boolean;
  activeMedia: {
    audio: boolean;
    screenShare: boolean;
  };
  seq?: number;
  clientTimeMs?: number;
  serverTimeMs?: number;
  updatedAt: string;
}
