export interface TransformState {
  x: number;
  y: number;
  z: number;
}

export interface PresenceState {
  participantId: string;
  displayName: string;
  role: "guest" | "member" | "host" | "admin";
  mode: "desktop" | "mobile" | "vr";
  rootTransform: TransformState;
  headTransform?: TransformState;
  muted: boolean;
  activeMedia: {
    audio: boolean;
    screenShare: boolean;
  };
}
