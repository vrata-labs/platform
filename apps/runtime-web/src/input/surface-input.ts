import * as THREE from "three";
import {
  hasRoomPermission,
  type RoomPermission,
  type SurfaceInputBlockedReason,
  type SurfaceInputButton,
  type SurfaceInputDebugState,
  type SurfaceInputEvent,
  type SurfaceInputHitDebug,
  type SurfaceInputKind,
  type SurfaceInputPixel,
  type SurfaceInputSource,
  type SurfaceInputUv
} from "@noah/shared-types";

export interface DebugSurfaceDefinition {
  surfaceId: string;
  objectId?: string;
  object: THREE.Object3D;
  widthPx: number;
  heightPx: number;
  inputEnabled: boolean;
}

export interface DebugSurfacePlaneDefinition extends DebugSurfaceDefinition {
  widthM: number;
  heightM: number;
  maxDistanceM: number;
}

export interface ResolvedSurfaceHit extends SurfaceInputHitDebug {
  inputEnabled: boolean;
}

export type SurfaceInputResolution =
  | { accepted: true; event: SurfaceInputEvent }
  | { accepted: false; blockedReason: SurfaceInputBlockedReason };

function clampPixel(value: number, maxExclusive: number): number {
  return Math.max(0, Math.min(Math.max(0, maxExclusive - 1), Math.floor(value)));
}

function roundSurfaceNumber(value: number): number {
  return Number(value.toFixed(4));
}

export function createSurfaceInputDebugState(debugSurfaceId: string): SurfaceInputDebugState {
  return {
    enabled: true,
    debugSurfaceId,
    focusedSurfaceId: null,
    lastHit: null,
    lastEvent: null,
    blockedReason: null,
    acceptedEventCount: 0,
    seq: 0
  };
}

export function isValidSurfaceUv(uv: SurfaceInputUv): boolean {
  return Number.isFinite(uv.u) && Number.isFinite(uv.v) && uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1;
}

export function pixelFromUv(uv: SurfaceInputUv, widthPx: number, heightPx: number): SurfaceInputPixel {
  return {
    x: clampPixel(uv.u * widthPx, widthPx),
    y: clampPixel(uv.v * heightPx, heightPx)
  };
}

export function createSurfaceInputEventId(input: { participantId: string; seq: number }): string {
  return `${input.participantId}:${input.seq}`;
}

export function createSyntheticSurfaceHit(input: {
  surfaceId: string;
  objectId?: string;
  source: SurfaceInputSource;
  uv: SurfaceInputUv;
  widthPx: number;
  heightPx: number;
  inputEnabled?: boolean;
}): ResolvedSurfaceHit {
  return {
    surfaceId: input.surfaceId,
    objectId: input.objectId,
    source: input.source,
    uv: {
      u: roundSurfaceNumber(input.uv.u),
      v: roundSurfaceNumber(input.uv.v)
    },
    pixel: pixelFromUv(input.uv, input.widthPx, input.heightPx),
    inputEnabled: input.inputEnabled ?? true
  };
}

export function resolveSurfaceHitFromRay(input: {
  ray: THREE.Ray;
  surfaces: DebugSurfaceDefinition[];
  raycaster: THREE.Raycaster;
  source: SurfaceInputSource;
}): ResolvedSurfaceHit | null {
  let bestHit: ResolvedSurfaceHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  input.raycaster.ray.copy(input.ray);

  for (const surface of input.surfaces) {
    const intersections = input.raycaster.intersectObject(surface.object, false);
    const hit = intersections[0];
    if (!hit?.uv || hit.distance >= bestDistance) {
      continue;
    }
    const uv = {
      u: roundSurfaceNumber(hit.uv.x),
      v: roundSurfaceNumber(hit.uv.y)
    };
    bestDistance = hit.distance;
    bestHit = {
      surfaceId: surface.surfaceId,
      objectId: surface.objectId,
      source: input.source,
      uv,
      pixel: pixelFromUv(uv, surface.widthPx, surface.heightPx),
      distanceM: roundSurfaceNumber(hit.distance),
      inputEnabled: surface.inputEnabled
    };
  }

  return bestHit;
}

export function resolveSurfaceHitFromPlanePoint(input: {
  point: THREE.Vector3;
  surfaces: DebugSurfacePlaneDefinition[];
  source: SurfaceInputSource;
}): ResolvedSurfaceHit | null {
  let bestHit: ResolvedSurfaceHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const surface of input.surfaces) {
    const localPoint = surface.object.worldToLocal(input.point.clone());
    const distance = Math.abs(localPoint.z);
    if (distance > surface.maxDistanceM || distance >= bestDistance) {
      continue;
    }
    const halfWidth = surface.widthM / 2;
    const halfHeight = surface.heightM / 2;
    if (localPoint.x < -halfWidth || localPoint.x > halfWidth || localPoint.y < -halfHeight || localPoint.y > halfHeight) {
      continue;
    }
    const uv = {
      u: roundSurfaceNumber(localPoint.x / surface.widthM + 0.5),
      v: roundSurfaceNumber(localPoint.y / surface.heightM + 0.5)
    };
    bestDistance = distance;
    bestHit = {
      surfaceId: surface.surfaceId,
      objectId: surface.objectId,
      source: input.source,
      uv,
      pixel: pixelFromUv(uv, surface.widthPx, surface.heightPx),
      distanceM: roundSurfaceNumber(distance),
      inputEnabled: surface.inputEnabled
    };
  }

  return bestHit;
}

function requiredPermissionForKind(kind: SurfaceInputKind): RoomPermission {
  if (kind === "key-down" || kind === "key-up") {
    return "surface.input";
  }
  return "surface.input";
}

export function resolveSurfaceInputEvent(input: {
  roomId: string;
  participantId: string;
  permissions: readonly RoomPermission[];
  hit: ResolvedSurfaceHit | null;
  kind: SurfaceInputKind;
  source: SurfaceInputSource;
  clientTimeMs: number;
  seq: number;
  focusedSurfaceId?: string | null;
  button?: SurfaceInputButton;
  pressure?: number;
  key?: string;
  text?: string;
}): SurfaceInputResolution {
  if (!input.hit) {
    return { accepted: false, blockedReason: "missing-hit" };
  }
  if (!input.hit.inputEnabled) {
    return { accepted: false, blockedReason: "surface-disabled" };
  }
  if (!isValidSurfaceUv(input.hit.uv)) {
    return { accepted: false, blockedReason: "uv-out-of-range" };
  }
  const requiredPermission = requiredPermissionForKind(input.kind);
  if (!hasRoomPermission(input.permissions, requiredPermission)) {
    return { accepted: false, blockedReason: `missing-permission:${requiredPermission}` };
  }
  if ((input.kind === "key-down" || input.kind === "key-up") && input.focusedSurfaceId !== input.hit.surfaceId) {
    return { accepted: false, blockedReason: "missing-focus" };
  }

  const event: SurfaceInputEvent = {
    eventId: createSurfaceInputEventId({ participantId: input.participantId, seq: input.seq }),
    roomId: input.roomId,
    surfaceId: input.hit.surfaceId,
    objectId: input.hit.objectId,
    participantId: input.participantId,
    source: input.source,
    kind: input.kind,
    uv: input.hit.uv,
    pixel: input.hit.pixel,
    button: input.button,
    pressure: input.pressure,
    key: input.key,
    text: input.text,
    clientTimeMs: input.clientTimeMs,
    seq: input.seq
  };

  return { accepted: true, event };
}

export function recordSurfaceInputHit(state: SurfaceInputDebugState, hit: SurfaceInputHitDebug | null): void {
  state.lastHit = hit;
  if (hit) {
    state.blockedReason = null;
  }
}

export function applySurfaceInputResolution(state: SurfaceInputDebugState, resolution: SurfaceInputResolution): void {
  if (resolution.accepted) {
    state.lastEvent = resolution.event;
    state.blockedReason = null;
    state.acceptedEventCount += 1;
    state.seq = resolution.event.seq;
    return;
  }
  state.blockedReason = resolution.blockedReason;
}

export function tryFocusSurface(input: {
  state: SurfaceInputDebugState;
  permissions: readonly RoomPermission[];
  hit: ResolvedSurfaceHit | null;
}): SurfaceInputBlockedReason | null {
  if (!input.hit) {
    input.state.blockedReason = "missing-hit";
    return "missing-hit";
  }
  if (!hasRoomPermission(input.permissions, "surface.select")) {
    input.state.blockedReason = "missing-permission:surface.select";
    return "missing-permission:surface.select";
  }
  input.state.focusedSurfaceId = input.hit.surfaceId;
  input.state.blockedReason = null;
  return null;
}
