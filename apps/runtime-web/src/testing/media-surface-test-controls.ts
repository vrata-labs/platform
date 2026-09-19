import * as THREE from "three";
import type { RoomPermission, SurfaceInputDebugState, SurfaceInputKind, SurfaceInputScrollDelta, SurfaceInputSource } from "@vrata/shared-types";

import { createSyntheticSurfaceHit, recordSurfaceInputHit, tryFocusSurface, type ResolvedSurfaceHit } from "../input/surface-input.js";
import type { createMediaSurfaceTextureController } from "../media/media-surface-textures.js";
import type { RuntimeMediaSurfaceView } from "../media/media-surface-view.js";
import type { RemoteBrowserVrKeyboardView } from "../media/remote-browser-vr-keyboard.js";
import type { RuntimeTestApi } from "./runtime-test-api.js";

export interface MediaSurfaceTestControlsContext {
  debugSurfaceId: string;
  // Read selection at command time; the runtime can switch surfaces after registration.
  readonly selectedMediaSurfaceId: string;
  debugState: { surfaceInput: SurfaceInputDebugState; access: { permissions: readonly RoomPermission[] } };
  camera: THREE.Camera;
  displaySurface: THREE.Object3D;
  mediaSurfaceViews: ReadonlyMap<string, RuntimeMediaSurfaceView>;
  whiteboardRuntimes: ReadonlyMap<string, { texture: Pick<THREE.Texture, "image"> }>;
  markdownBoardRuntimes: Pick<ReadonlyMap<string, unknown>, "has">;
  remoteBrowserRuntimes: Pick<ReadonlyMap<string, unknown>, "has">;
  remoteBrowserVrKeyboardView: Pick<RemoteBrowserVrKeyboardView, "toggleMesh" | "meshById">;
  selectMediaSurface: RuntimeTestApi["selectMediaSurface"];
  resolveDebugSurfaceHit: (ray: THREE.Ray, source: SurfaceInputSource) => ResolvedSurfaceHit | null;
  activeMediaObjectIdForSurface: (surfaceId: string) => string | undefined;
  isMediaSurfaceInputEnabled: (surface: RuntimeMediaSurfaceView) => boolean;
  commitDebugSurfaceInput: (input: {
    hit: ResolvedSurfaceHit | null;
    source: SurfaceInputSource;
    kind: SurfaceInputKind;
    clientTimeMs: number;
    key?: string;
    text?: string;
    scrollDelta?: SurfaceInputScrollDelta;
  }) => boolean;
  syncPhysicalMediaSurfaceDebugSnapshots: () => void;
  sampleMediaSurfaceTexture: ReturnType<typeof createMediaSurfaceTextureController>["sampleMediaSurfaceTexture"];
}

export type MediaSurfaceTestControls = Pick<RuntimeTestApi,
  | "selectMediaSurface"
  | "getMediaSurfaceRuntimePixelDimensions"
  | "getMediaCanvasRuntimeKinds"
  | "resolveMediaSurfaceRayHit"
  | "sendDebugSurfaceInput"
  | "setDebugSurfaceInputEnabled"
  | "focusDebugSurface"
  | "getDebugSurfaceWorldPosition"
  | "getDebugSurfaceClientPosition"
  | "getMediaSurfaceWorldPosition"
  | "getMediaSurfaceClientPosition"
  | "sampleDebugSurfaceTexture"
  | "sampleMediaSurfaceTexture"
  | "getRemoteBrowserVrKeyboardTargetWorldPosition"
  | "getRemoteBrowserVrKeyboardKeyWorldPosition"
>;

export function createMediaSurfaceTestControls(context: MediaSurfaceTestControlsContext): MediaSurfaceTestControls {
  const {
    debugSurfaceId: DEBUG_SURFACE_ID,
    debugState,
    camera,
    displaySurface,
    mediaSurfaceViews,
    whiteboardRuntimes,
    markdownBoardRuntimes,
    remoteBrowserRuntimes,
    remoteBrowserVrKeyboardView,
    selectMediaSurface,
    resolveDebugSurfaceHit,
    activeMediaObjectIdForSurface,
    isMediaSurfaceInputEnabled,
    commitDebugSurfaceInput,
    syncPhysicalMediaSurfaceDebugSnapshots,
    sampleMediaSurfaceTexture
  } = context;

  return {
    selectMediaSurface: (surfaceId) => selectMediaSurface(surfaceId),
    getMediaSurfaceRuntimePixelDimensions: (surfaceId) => {
      const image = whiteboardRuntimes.get(surfaceId)?.texture.image as { width?: number; height?: number } | undefined;
      return typeof image?.width === "number" && typeof image.height === "number"
        ? { width: image.width, height: image.height }
        : null;
    },
    getMediaCanvasRuntimeKinds: (surfaceId) => {
      const kinds: Array<"whiteboard" | "markdown-board" | "remote-browser"> = [];
      if (whiteboardRuntimes.has(surfaceId)) kinds.push("whiteboard");
      if (markdownBoardRuntimes.has(surfaceId)) kinds.push("markdown-board");
      if (remoteBrowserRuntimes.has(surfaceId)) kinds.push("remote-browser");
      return kinds;
    },
    resolveMediaSurfaceRayHit: (origin, direction) => {
      if (![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z].every(Number.isFinite)) {
        return null;
      }
      const rayDirection = new THREE.Vector3(direction.x, direction.y, direction.z);
      if (rayDirection.lengthSq() === 0) {
        return null;
      }
      const hit = resolveDebugSurfaceHit(
        new THREE.Ray(new THREE.Vector3(origin.x, origin.y, origin.z), rayDirection.normalize()),
        "mouse"
      );
      return hit ? { surfaceId: hit.surfaceId, distanceM: hit.distanceM ?? null } : null;
    },
    sendDebugSurfaceInput: (input = {}) => {
      const source = input.source ?? "mouse";
      const surfaceId = input.surfaceId ?? context.selectedMediaSurfaceId;
      const surface = mediaSurfaceViews.get(surfaceId);
      if (!surface) {
        return false;
      }
      const hit = createSyntheticSurfaceHit({
        surfaceId,
        objectId: activeMediaObjectIdForSurface(surfaceId),
        source,
        uv: { u: input.u ?? 0.5, v: input.v ?? 0.5 },
        widthPx: surface.widthPx,
        heightPx: surface.heightPx,
        inputEnabled: isMediaSurfaceInputEnabled(surface)
      });
      return commitDebugSurfaceInput({
        hit,
        source,
        kind: input.kind ?? "click",
        key: input.key,
        text: input.text,
        scrollDelta: input.scrollDelta,
        clientTimeMs: Date.now()
      });
    },
    setDebugSurfaceInputEnabled: (enabled) => {
      debugState.surfaceInput.enabled = enabled;
      syncPhysicalMediaSurfaceDebugSnapshots();
      return true;
    },
    focusDebugSurface: (surfaceId = context.selectedMediaSurfaceId) => {
      const surface = mediaSurfaceViews.get(surfaceId);
      if (!surface) {
        return false;
      }
      const hit = createSyntheticSurfaceHit({
        surfaceId,
        objectId: activeMediaObjectIdForSurface(surfaceId),
        source: "mouse",
        uv: { u: 0.5, v: 0.5 },
        widthPx: surface.widthPx,
        heightPx: surface.heightPx,
        inputEnabled: isMediaSurfaceInputEnabled(surface)
      });
      recordSurfaceInputHit(debugState.surfaceInput, hit);
      return tryFocusSurface({ state: debugState.surfaceInput, permissions: debugState.access.permissions, hit }) === null;
    },
    getDebugSurfaceWorldPosition: (u, v) => {
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        return null;
      }
      const surface = mediaSurfaceViews.get(DEBUG_SURFACE_ID);
      if (!surface) {
        return null;
      }
      surface.object.updateMatrixWorld(true);
      const position = surface.object.localToWorld(new THREE.Vector3(
        (Math.max(0, Math.min(1, u)) - 0.5) * surface.widthM,
        (Math.max(0, Math.min(1, v)) - 0.5) * surface.heightM,
        0
      ));
      return {
        x: position.x,
        y: position.y,
        z: position.z
      };
    },
    getDebugSurfaceClientPosition: (u, v) => {
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        return null;
      }
      const surface = mediaSurfaceViews.get(DEBUG_SURFACE_ID);
      if (!surface) {
        return null;
      }
      surface.object.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      const ndc = surface.object.localToWorld(new THREE.Vector3(
        (Math.max(0, Math.min(1, u)) - 0.5) * surface.widthM,
        (Math.max(0, Math.min(1, v)) - 0.5) * surface.heightM,
        0
      )).project(camera);
      return {
        x: (ndc.x + 1) * 0.5 * window.innerWidth,
        y: (1 - ndc.y) * 0.5 * window.innerHeight
      };
    },
    getMediaSurfaceWorldPosition: (surfaceId, u, v) => {
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        return null;
      }
      const surface = mediaSurfaceViews.get(surfaceId);
      if (!surface) {
        return null;
      }
      surface.object.updateMatrixWorld(true);
      const position = surface.object.localToWorld(new THREE.Vector3(
        (Math.max(0, Math.min(1, u)) - 0.5) * surface.widthM,
        (Math.max(0, Math.min(1, v)) - 0.5) * surface.heightM,
        0
      ));
      return {
        x: position.x,
        y: position.y,
        z: position.z
      };
    },
    getMediaSurfaceClientPosition: (surfaceId, u, v) => {
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        return null;
      }
      const surface = mediaSurfaceViews.get(surfaceId);
      if (!surface) {
        return null;
      }
      surface.object.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      const ndc = surface.object.localToWorld(new THREE.Vector3(
        (Math.max(0, Math.min(1, u)) - 0.5) * surface.widthM,
        (Math.max(0, Math.min(1, v)) - 0.5) * surface.heightM,
        0
      )).project(camera);
      return {
        x: (ndc.x + 1) * 0.5 * window.innerWidth,
        y: (1 - ndc.y) * 0.5 * window.innerHeight
      };
    },
    sampleDebugSurfaceTexture: (center, size = { width: 0.18, height: 0.18 }) => {
      return sampleMediaSurfaceTexture(DEBUG_SURFACE_ID, center, size);
    },
    sampleMediaSurfaceTexture: (surfaceId, center, size = { width: 0.18, height: 0.18 }) => {
      return sampleMediaSurfaceTexture(surfaceId, center, size);
    },
    getRemoteBrowserVrKeyboardTargetWorldPosition: (targetId) => {
      const mesh = targetId === "toggle" ? remoteBrowserVrKeyboardView.toggleMesh : remoteBrowserVrKeyboardView.meshById.get(targetId);
      if (!mesh) {
        return null;
      }
      displaySurface.updateMatrixWorld(true);
      mesh.updateMatrixWorld(true);
      const position = mesh.getWorldPosition(new THREE.Vector3());
      return {
        x: position.x,
        y: position.y,
        z: position.z
      };
    },
    getRemoteBrowserVrKeyboardKeyWorldPosition: (keyId) => {
      return (window as Window & {
        __VRATA_TEST__?: { getRemoteBrowserVrKeyboardTargetWorldPosition: (targetId: string) => { x: number; y: number; z: number } | null };
      }).__VRATA_TEST__?.getRemoteBrowserVrKeyboardTargetWorldPosition(keyId) ?? null;
    }
  };
}
