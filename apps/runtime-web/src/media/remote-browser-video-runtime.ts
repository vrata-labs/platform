import * as THREE from "three";
import type { Room, Track } from "livekit-client";
import { REMOTE_BROWSER_OBJECT_TYPE, type MediaObjectInstance, type RemoteBrowserObjectState, type RoomMediaObjectsState } from "@vrata/shared-types";

import type { RuntimeMediaSurfaceView } from "./media-surface-view.js";
import type { createRemoteBrowserObjectRuntime } from "./remote-browser-object.js";

export type RemoteBrowserVideoEntry = {
  objectId: string;
  surfaceId: string;
  track: Track;
  element: HTMLVideoElement;
  texture: THREE.Texture;
  trackSid: string;
  playError: string | null;
  frameCount: number;
  lastFrameAtMs: number;
  presentedFrames: number;
};

export interface RemoteBrowserVideoRuntimeContext {
  remoteBrowserVideoByObjectId: Map<string, RemoteBrowserVideoEntry>;
  retainedDisplayTextures: Set<THREE.Texture>;
  mediaSurfaceViews: Pick<ReadonlyMap<string, RuntimeMediaSurfaceView>, "has">;
  // Read replaceable session state when an operation runs, not at construction.
  readonly roomMediaObjects: RoomMediaObjectsState | null;
  readonly livekitRoom: Room | null;
  getMediaSurfaceView: (surfaceId: string) => RuntimeMediaSurfaceView;
  applySurfaceTexture: (surfaceId: string, texture: THREE.Texture | null) => void;
  activeRemoteBrowserObjectForSurface: (surfaceId: string) => MediaObjectInstance<RemoteBrowserObjectState> | null;
  getRemoteBrowserRuntime: (surfaceId: string) => Pick<ReturnType<typeof createRemoteBrowserObjectRuntime>, "sync">;
  reconcileMediaRoomIdleDisconnect: (room: Room | null, diagnosticsReason: string) => void;
}

export function createRemoteBrowserVideoRuntime(context: RemoteBrowserVideoRuntimeContext) {
  const {
    remoteBrowserVideoByObjectId,
    retainedDisplayTextures,
    mediaSurfaceViews,
    getMediaSurfaceView,
    applySurfaceTexture,
    activeRemoteBrowserObjectForSurface,
    getRemoteBrowserRuntime,
    reconcileMediaRoomIdleDisconnect
  } = context;

  function remoteBrowserVideoEntryForObject(objectId: string | null | undefined): RemoteBrowserVideoEntry | null {
    return objectId ? remoteBrowserVideoByObjectId.get(objectId) ?? null : null;
  }

  function remoteBrowserVideoEntryForTrack(track: Track): RemoteBrowserVideoEntry | null {
    for (const entry of remoteBrowserVideoByObjectId.values()) {
      if (entry.track === track) {
        return entry;
      }
    }
    return null;
  }

  function createRemoteBrowserVideoTexture(element: HTMLVideoElement): THREE.VideoTexture {
    const texture = new THREE.VideoTexture(element);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function moveRemoteBrowserVideoEntryToSurface(entry: RemoteBrowserVideoEntry, surfaceId: string): void {
    if (entry.surfaceId === surfaceId) {
      return;
    }
    const material = getMediaSurfaceView(entry.surfaceId).object.material;
    if (material instanceof THREE.MeshBasicMaterial && material.map === entry.texture) {
      retainedDisplayTextures.add(entry.texture);
      applySurfaceTexture(entry.surfaceId, null);
      retainedDisplayTextures.delete(entry.texture);
    }
    applySurfaceTexture(surfaceId, entry.texture);
    entry.surfaceId = surfaceId;
  }

  function detachRemoteBrowserVideoEntry(entry: RemoteBrowserVideoEntry): void {
    entry.track.detach().forEach((element) => element.remove());
    entry.element.remove();
    const material = getMediaSurfaceView(entry.surfaceId).object.material;
    if (material instanceof THREE.MeshBasicMaterial && material.map === entry.texture) {
      applySurfaceTexture(entry.surfaceId, null);
    } else if (!retainedDisplayTextures.has(entry.texture)) {
      entry.texture.dispose();
    }
    remoteBrowserVideoByObjectId.delete(entry.objectId);
    const object = activeRemoteBrowserObjectForSurface(entry.surfaceId);
    if (object) {
      getRemoteBrowserRuntime(entry.surfaceId).sync(object);
    }
    reconcileMediaRoomIdleDisconnect(context.livekitRoom, "remote_browser_consumer_detached_idle");
  }

  function isCurrentRemoteBrowserObject(object: MediaObjectInstance<RemoteBrowserObjectState> | null | undefined): object is MediaObjectInstance<RemoteBrowserObjectState> {
    if (!object) {
      return false;
    }
    return object.type === REMOTE_BROWSER_OBJECT_TYPE
      && object.state.status !== "stopped"
      && object.state.status !== "failed"
      && context.roomMediaObjects?.surfaces[object.surfaceId]?.activeObjectId === object.objectId;
  }

  function syncRemoteBrowserVideoRuntimeWithObjects(): void {
    if (!context.roomMediaObjects) {
      return;
    }
    for (const entry of Array.from(remoteBrowserVideoByObjectId.values())) {
      const object = context.roomMediaObjects.objects[entry.objectId] as MediaObjectInstance<RemoteBrowserObjectState> | undefined;
      if (!isCurrentRemoteBrowserObject(object)
        || !mediaSurfaceViews.has(object.surfaceId)
        || (object.state.mediaTrackSid && object.state.mediaTrackSid !== entry.trackSid)) {
        detachRemoteBrowserVideoEntry(entry);
        continue;
      }
      moveRemoteBrowserVideoEntryToSurface(entry, object.surfaceId);
    }
  }

  function startRemoteBrowserExternalVideoFrameDiagnostics(entry: RemoteBrowserVideoEntry): void {
    const element = entry.element;
    const video = element as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number, metadata: { presentedFrames?: number }) => void) => number;
    };
    if (!video.requestVideoFrameCallback) {
      return;
    }
    const onFrame = (_now: number, metadata: { presentedFrames?: number }) => {
      if (remoteBrowserVideoByObjectId.get(entry.objectId) !== entry) {
        return;
      }
      entry.frameCount += 1;
      entry.lastFrameAtMs = Date.now();
      entry.presentedFrames = metadata.presentedFrames ?? entry.presentedFrames;
      video.requestVideoFrameCallback?.(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  function createRemoteBrowserExternalVideoDebugSnapshot(object: MediaObjectInstance<RemoteBrowserObjectState> | null): {
    externalVideoAttached: boolean;
    externalVideoObjectId: string | null;
    externalVideoTrackSid: string | null;
    externalVideoPaused: boolean | null;
    externalVideoReadyState: number | null;
    externalVideoCurrentTime: number | null;
    externalVideoWidth: number;
    externalVideoHeight: number;
    externalVideoMuted: boolean | null;
    externalVideoAutoplay: boolean | null;
    externalVideoPlayError: string | null;
    externalVideoFrameCount: number;
    externalVideoLastFrameAtMs: number;
    externalVideoPresentedFrames: number;
  } {
    const entry = remoteBrowserVideoEntryForObject(object?.objectId);
    const element = entry?.element ?? null;
    return {
      externalVideoAttached: Boolean(element),
      externalVideoObjectId: entry?.objectId ?? null,
      externalVideoTrackSid: entry?.trackSid ?? null,
      externalVideoPaused: element?.paused ?? null,
      externalVideoReadyState: element?.readyState ?? null,
      externalVideoCurrentTime: element ? Number(element.currentTime.toFixed(3)) : null,
      externalVideoWidth: element?.videoWidth ?? 0,
      externalVideoHeight: element?.videoHeight ?? 0,
      externalVideoMuted: element?.muted ?? null,
      externalVideoAutoplay: element?.autoplay ?? null,
      externalVideoPlayError: entry?.playError ?? null,
      externalVideoFrameCount: entry?.frameCount ?? 0,
      externalVideoLastFrameAtMs: entry?.lastFrameAtMs ?? 0,
      externalVideoPresentedFrames: entry?.presentedFrames ?? 0
    };
  }

  return {
    remoteBrowserVideoEntryForObject,
    remoteBrowserVideoEntryForTrack,
    createRemoteBrowserVideoTexture,
    moveRemoteBrowserVideoEntryToSurface,
    detachRemoteBrowserVideoEntry,
    syncRemoteBrowserVideoRuntimeWithObjects,
    startRemoteBrowserExternalVideoFrameDiagnostics,
    createRemoteBrowserExternalVideoDebugSnapshot
  };
}
