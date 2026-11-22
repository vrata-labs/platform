import * as THREE from "three";
import type { SceneFloorArea } from "@vrata/shared-types";

import type { LocalAvatarHandFrameResult, XrSpatialLike } from "../avatar/avatar-xr-hands.js";
import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import {
  resolveInteractionRay,
  type ResolvedInteractionRay,
  type SyntheticXrInteractionState
} from "./interaction-ray.js";
import {
  clearInteractionRayView,
  showInteractionRayView,
  type InteractionRayDebugState,
  type InteractionRayView
} from "./interaction-ray-view.js";
import { isSeatMarkerBlocked, resolveInteractionTargetFromRay, type InteractionTarget } from "./interaction-targets.js";

import type { FloorLinkPicker } from "./floor-link-picker.js";

interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface RuntimeInteractionRayInput {
  frameContext: RuntimeFrameContext;
  localAvatarHandFrame?: LocalAvatarHandFrameResult | null;
  forcedRay?: THREE.Ray | null;
  forceXrAimRay?: boolean;
  avatarVrMockEnabled: boolean;
  syntheticXrState?: SyntheticXrInteractionState | null;
  xrPresenting: boolean;
  xrControllerGrips: Array<XrSpatialLike | null | undefined>;
  xrControllers: Array<XrSpatialLike | null | undefined>;
  playerPosition: Vector3Like;
  playerYaw: number;
  pointerHoveringScene: boolean;
  pointerNdc: THREE.Vector2;
  camera: THREE.Camera;
  raycaster: THREE.Raycaster;
}

export interface RuntimeInteractionTargetInput {
  ray: THREE.Ray;
  forcedSeatId?: string | null;
  seatMarkerHitMeshes: THREE.Object3D[];
  seatAnchorMap: ReadonlyMap<string, SceneBundleSeatAnchor>;
  raycaster: THREE.Raycaster;
  seatAnchors: SceneBundleSeatAnchor[];
  teleportFloorY: number;
  floorAreas?: SceneFloorArea[];
  pickFloorLink?: FloorLinkPicker;
  maxDistance?: number;
}

export interface RuntimeInteractionFrameInput extends RuntimeInteractionRayInput {
  forcedSeatId?: string | null;
  seatMarkerHitMeshes: THREE.Object3D[];
  seatAnchorMap: ReadonlyMap<string, SceneBundleSeatAnchor>;
  seatAnchors: SceneBundleSeatAnchor[];
  teleportFloorY: number;
  floorAreas?: SceneFloorArea[];
  pickFloorLink?: FloorLinkPicker;
  maxDistance?: number;
  view: InteractionRayView;
  state: InteractionRayDebugState;
  markTelemetry?: (kind: string) => void;
  updateSeatMarkerVisuals?: (timeSeconds: number) => void;
  nowSeconds?: () => number;
}

export function resolveRuntimeInteractionRay(input: RuntimeInteractionRayInput): ResolvedInteractionRay | null {
  return resolveInteractionRay({
    frameContext: input.frameContext,
    localAvatarHandFrame: input.localAvatarHandFrame,
    forcedRay: input.forcedRay,
    forceXrAimRay: input.forceXrAimRay,
    avatarVrMockEnabled: input.avatarVrMockEnabled,
    syntheticXrState: input.syntheticXrState,
    xrPresenting: input.xrPresenting,
    xrControllerGrips: input.xrControllerGrips,
    xrControllers: input.xrControllers,
    playerPosition: input.playerPosition,
    playerYaw: input.playerYaw,
    pointerHoveringScene: input.pointerHoveringScene,
    pointerNdc: input.pointerNdc,
    camera: input.camera,
    pointerRaycaster: input.raycaster
  });
}

export function resolveInteractionTargetForRay(input: RuntimeInteractionTargetInput): InteractionTarget {
  const sameFloor = (a?: SceneBundleSeatAnchor) => a !== undefined && Math.abs(a.position.y - input.teleportFloorY) < 0.01;
  const forcedSeatAnchor = input.forcedSeatId ? input.seatAnchorMap.get(input.forcedSeatId) ?? null : null;
  if (forcedSeatAnchor && (!input.floorAreas || sameFloor(forcedSeatAnchor))) {
    if (isSeatMarkerBlocked(forcedSeatAnchor.id, input.seatMarkerHitMeshes)) return { kind: "none" };
    return {
      kind: "seat",
      point: new THREE.Vector3(
        forcedSeatAnchor.position.x,
        forcedSeatAnchor.position.y + forcedSeatAnchor.seatHeight,
        forcedSeatAnchor.position.z
      ),
      seatId: forcedSeatAnchor.id,
      seatAnchor: forcedSeatAnchor
    };
  }

  const target = resolveInteractionTargetFromRay({
    ray: input.ray,
    seatMarkerHitMeshes: input.floorAreas ? input.seatMarkerHitMeshes.filter(m => sameFloor(input.seatAnchorMap.get(m.userData.seatAnchorId))) : input.seatMarkerHitMeshes,
    seatAnchorMap: input.seatAnchorMap,
    raycaster: input.raycaster,
    seatAnchors: input.floorAreas ? input.seatAnchors.filter(sameFloor) : input.seatAnchors,
    floorAreas: input.floorAreas,
    teleportFloorY: input.teleportFloorY,
    maxDistance: input.maxDistance
  });
  const link = input.pickFloorLink?.(input.ray, input.teleportFloorY, input.maxDistance ?? 20);
  if (link && (target.kind !== "seat" || link.point.distanceToSquared(input.ray.origin) < target.point.distanceToSquared(input.ray.origin))) return link;
  return target;
}

function updateSeatMarkers(input: RuntimeInteractionFrameInput): void {
  input.updateSeatMarkerVisuals?.(input.nowSeconds?.() ?? input.frameContext.nowMs / 1000);
}

export function updateInteractionRayState(input: RuntimeInteractionFrameInput): InteractionTarget {
  const resolvedRay = resolveRuntimeInteractionRay(input);
  if (!resolvedRay) {
    clearInteractionRayView({
      view: input.view,
      state: input.state,
      mode: input.xrPresenting || input.frameContext.source === "xr" ? "xr-right-stick" : "none",
      markTelemetry: input.markTelemetry
    });
    updateSeatMarkers(input);
    return { kind: "none" };
  }

  const target = resolveInteractionTargetForRay({
    ray: resolvedRay.ray,
    pickFloorLink: input.pickFloorLink,
    forcedSeatId: input.forcedSeatId,
    seatMarkerHitMeshes: input.seatMarkerHitMeshes,
    seatAnchorMap: input.seatAnchorMap,
    raycaster: input.raycaster,
    seatAnchors: input.seatAnchors,
    teleportFloorY: input.teleportFloorY,
    floorAreas: input.floorAreas,
    maxDistance: input.maxDistance
  });
  const mode = input.frameContext.source === "xr" ? "xr-right-stick" : "cursor";
  if (target.kind === "none") {
    clearInteractionRayView({
      view: input.view,
      state: input.state,
      mode,
      markTelemetry: input.markTelemetry,
      forceRayOffTelemetry: true
    });
    updateSeatMarkers(input);
    return { kind: "none" };
  }

  showInteractionRayView({
    view: input.view,
    state: input.state,
    ray: resolvedRay.ray,
    target,
    mode,
    debug: resolvedRay.debug,
    markTelemetry: input.markTelemetry
  });
  return target;
}
