import type { RoomPermission } from "./access.js";

export type SurfaceInputSource = "mouse" | "touch" | "xr-controller" | "xr-hand" | "keyboard";

export type SurfaceInputKind = "pointer-down" | "pointer-move" | "pointer-up" | "click" | "scroll" | "key-down" | "key-up";

export type SurfaceInputButton = "primary" | "secondary" | "middle";

export type SurfaceInputBlockedReason =
  | "missing-hit"
  | "missing-surface"
  | "surface-disabled"
  | "uv-out-of-range"
  | "missing-focus"
  | `missing-permission:${RoomPermission}`;

export interface SurfaceInputUv {
  u: number;
  v: number;
}

export interface SurfaceInputPixel {
  x: number;
  y: number;
}

export interface SurfaceInputEvent {
  eventId: string;
  roomId: string;
  surfaceId: string;
  objectId?: string;
  participantId: string;
  source: SurfaceInputSource;
  kind: SurfaceInputKind;
  uv?: SurfaceInputUv;
  pixel?: SurfaceInputPixel;
  button?: SurfaceInputButton;
  pressure?: number;
  key?: string;
  text?: string;
  clientTimeMs: number;
  seq: number;
}

export interface SurfaceInputHitDebug {
  surfaceId: string;
  objectId?: string;
  source: SurfaceInputSource;
  uv: SurfaceInputUv;
  pixel: SurfaceInputPixel;
  distanceM?: number;
}

export interface SurfaceInputDebugState {
  enabled: boolean;
  debugSurfaceId: string;
  focusedSurfaceId: string | null;
  lastHit: SurfaceInputHitDebug | null;
  lastEvent: SurfaceInputEvent | null;
  blockedReason: SurfaceInputBlockedReason | null;
  acceptedEventCount: number;
  seq: number;
}
