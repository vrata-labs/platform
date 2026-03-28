export interface TransformState {
  x: number;
  y: number;
  z: number;
}

export type PresenceMode = "desktop" | "mobile" | "vr";

export interface PresenceState {
  participantId: string;
  displayName: string;
  mode: PresenceMode;
  rootTransform: TransformState;
  bodyTransform?: TransformState;
  headTransform?: TransformState;
  muted: boolean;
  activeMedia: {
    audio: boolean;
    screenShare: boolean;
  };
  updatedAt: string;
}
