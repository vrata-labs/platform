import * as THREE from "three";

import { resolveLocalAvatarHandTargets, type XrSpatialLike } from "../avatar/avatar-xr-hands.js";
import { resolveXrInteractionRay } from "../avatar/avatar-xr-ray.js";
import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";

interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface SyntheticXrInteractionState {
  rightController: Vector3Like;
  rayDirection: Vector3Like;
  rayVisible: boolean;
}

export interface InteractionRayDebugSample {
  origin: Vector3Like;
  direction: Vector3Like;
  source: { index: number; handedness: string | null };
}

export interface ResolvedInteractionRay {
  ray: THREE.Ray;
  debug: InteractionRayDebugSample | null;
}

function roundVector3(input: Vector3Like): Vector3Like {
  return {
    x: Number(input.x.toFixed(2)),
    y: Number(input.y.toFixed(2)),
    z: Number(input.z.toFixed(2))
  };
}

export function resolveInteractionRay(input: {
  frameContext: RuntimeFrameContext;
  forcedRay?: THREE.Ray | null;
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
  pointerRaycaster: THREE.Raycaster;
}): ResolvedInteractionRay | null {
  if (input.forcedRay) {
    return { ray: input.forcedRay.clone(), debug: null };
  }

  const syntheticXrState = input.syntheticXrState;
  if (input.avatarVrMockEnabled && syntheticXrState) {
    if (!syntheticXrState.rayVisible && !input.frameContext.intents.aimRay) {
      return null;
    }
    const origin = new THREE.Vector3(
      syntheticXrState.rightController.x,
      syntheticXrState.rightController.y,
      syntheticXrState.rightController.z
    );
    const direction = new THREE.Vector3(
      syntheticXrState.rayDirection.x,
      syntheticXrState.rayDirection.y,
      syntheticXrState.rayDirection.z
    ).normalize();
    return {
      ray: new THREE.Ray(origin.clone(), direction.clone()),
      debug: {
        origin: roundVector3(origin),
        direction: roundVector3(direction),
        source: { index: 0, handedness: "right" }
      }
    };
  }

  if (input.xrPresenting) {
    const frameContext = input.frameContext;
    if (frameContext.source !== "xr" || !frameContext.xr || !frameContext.intents.aimRay) {
      return null;
    }
    const xrRay = resolveXrInteractionRay({
      inputSources: frameContext.xr.inputSources,
      xrFrame: frameContext.xr.frame,
      referenceSpace: frameContext.xr.referenceSpace,
      playerOffset: input.playerPosition,
      playerYaw: input.playerYaw
    });
    if (!xrRay) {
      return null;
    }
    const xrHands = resolveLocalAvatarHandTargets({
      presenting: true,
      inputSources: frameContext.xr.inputSources,
      grips: input.xrControllerGrips,
      controllers: input.xrControllers,
      xrFrame: frameContext.xr.frame,
      referenceSpace: frameContext.xr.referenceSpace,
      playerOffset: input.playerPosition,
      playerYaw: input.playerYaw
    });
    const rayOrigin = xrHands.rightHand ?? xrRay.origin;
    const origin = new THREE.Vector3(rayOrigin.x, rayOrigin.y, rayOrigin.z);
    const direction = new THREE.Vector3(xrRay.direction.x, xrRay.direction.y, xrRay.direction.z).normalize();
    return {
      ray: new THREE.Ray(origin.clone(), direction.clone()),
      debug: {
        origin: roundVector3(origin),
        direction: roundVector3(direction),
        source: xrRay.source
      }
    };
  }

  if (!input.pointerHoveringScene) {
    return null;
  }
  input.pointerRaycaster.setFromCamera(input.pointerNdc, input.camera);
  return { ray: input.pointerRaycaster.ray.clone(), debug: null };
}
