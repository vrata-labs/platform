import * as THREE from "three";
import type { Room, Track } from "livekit-client";
import { SCREEN_SHARE_OBJECT_TYPE, type MediaObjectInstance, type RoomMediaObjectsState, type ScreenShareObjectState } from "@vrata/shared-types";

import { physicalScreenShareObjectForMediaTrack } from "./media-object-state.js";
import type { RuntimeMediaSurfaceView } from "./media-surface-view.js";

export type ScreenShareRuntimeEntry = {
  objectId: string;
  surfaceId: string;
  ownerParticipantId: string | null;
  mediaTrackSid: string | null;
  remote: boolean;
  track: Track | null;
  element: HTMLVideoElement | null;
  texture: THREE.Texture | null;
  stream: MediaStream | null;
  publishedTracks: MediaStreamTrack[];
  stopping: boolean;
};

export interface ScreenShareRuntimeContext {
  screenShareRuntimeByObjectId: Map<string, ScreenShareRuntimeEntry>;
  retainedDisplayTextures: Set<THREE.Texture>;
  mediaSurfaceViews: Pick<ReadonlyMap<string, RuntimeMediaSurfaceView>, "has">;
  debugState: { screenShareState: string; screenShare: { remoteSubscribedTrackCount: number } };
  // Read replaceable room/session state when an operation runs, not at construction.
  readonly roomMediaObjects: RoomMediaObjectsState | null;
  readonly livekitRoom: Room | null;
  getMediaSurfaceView: (surfaceId: string) => RuntimeMediaSurfaceView;
  applySurfaceTexture: (surfaceId: string, texture: THREE.Texture | null) => void;
  reconcileMediaRoomIdleDisconnect: (room: Room | null, diagnosticsReason: string) => void;
}

export function createScreenShareRuntime(context: ScreenShareRuntimeContext) {
  const {
    screenShareRuntimeByObjectId,
    retainedDisplayTextures,
    mediaSurfaceViews,
    debugState,
    getMediaSurfaceView,
    applySurfaceTexture,
    reconcileMediaRoomIdleDisconnect
  } = context;

  function screenShareEntries(): ScreenShareRuntimeEntry[] {
    return Array.from(screenShareRuntimeByObjectId.values());
  }

  function hasLocalScreenSharePublishing(): boolean {
    return screenShareEntries().some((entry) => !entry.remote);
  }

  function remoteScreenShareTrackCount(): number {
    return screenShareEntries().filter((entry) => entry.remote && (entry.track || entry.element)).length;
  }

  function localScreenShareEntryForSurface(surfaceId: string): ScreenShareRuntimeEntry | null {
    return screenShareEntries().find((entry) => !entry.remote && entry.surfaceId === surfaceId) ?? null;
  }

  function anyLocalScreenShareEntry(): ScreenShareRuntimeEntry | null {
    return screenShareEntries().find((entry) => !entry.remote) ?? null;
  }

  function screenShareEntryForTrack(track: Track): ScreenShareRuntimeEntry | null {
    return screenShareEntries().find((entry) => entry.track === track) ?? null;
  }

  function screenShareEntryForObject(objectId: string | null | undefined): ScreenShareRuntimeEntry | null {
    return objectId ? screenShareRuntimeByObjectId.get(objectId) ?? null : null;
  }

  function createScreenShareVideoTexture(element: HTMLVideoElement): THREE.VideoTexture {
    const texture = new THREE.VideoTexture(element);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function clearScreenShareEntryTexture(entry: ScreenShareRuntimeEntry): void {
    if (!entry.texture) {
      return;
    }
    const material = getMediaSurfaceView(entry.surfaceId).object.material;
    if (material instanceof THREE.MeshBasicMaterial && material.map === entry.texture) {
      applySurfaceTexture(entry.surfaceId, null);
    } else if (!retainedDisplayTextures.has(entry.texture)) {
      entry.texture.dispose();
    }
    entry.texture = null;
  }

  function moveScreenShareEntryToSurface(entry: ScreenShareRuntimeEntry, surfaceId: string): void {
    if (entry.surfaceId === surfaceId) {
      return;
    }
    const texture = entry.texture;
    if (texture) {
      const material = getMediaSurfaceView(entry.surfaceId).object.material;
      if (material instanceof THREE.MeshBasicMaterial && material.map === texture) {
        retainedDisplayTextures.add(texture);
        applySurfaceTexture(entry.surfaceId, null);
        retainedDisplayTextures.delete(texture);
      }
      applySurfaceTexture(surfaceId, texture);
    }
    entry.surfaceId = surfaceId;
  }

  function registerScreenShareEntry(entry: ScreenShareRuntimeEntry): ScreenShareRuntimeEntry {
    const existing = screenShareRuntimeByObjectId.get(entry.objectId);
    if (existing && existing !== entry) {
      detachScreenShareEntry(existing);
    }
    screenShareRuntimeByObjectId.set(entry.objectId, entry);
    reconcileMediaRoomIdleDisconnect(context.livekitRoom, "screen_share_consumer_active");
    return entry;
  }

  function detachScreenShareEntry(entry: ScreenShareRuntimeEntry): void {
    entry.stopping = true;
    if (entry.track) {
      entry.track.detach().forEach((element) => element.remove());
      entry.track = null;
    }
    if (entry.element) {
      entry.element.remove();
      entry.element = null;
    }
    clearScreenShareEntryTexture(entry);
    entry.stream?.getTracks().forEach((track) => track.stop());
    entry.stream = null;
    entry.publishedTracks.forEach((track) => {
      if (track.readyState !== "ended") {
        track.stop();
      }
    });
    entry.publishedTracks = [];
    screenShareRuntimeByObjectId.delete(entry.objectId);
    debugState.screenShare.remoteSubscribedTrackCount = remoteScreenShareTrackCount();
    if (!hasLocalScreenSharePublishing() && remoteScreenShareTrackCount() === 0 && debugState.screenShareState !== "stopped") {
      debugState.screenShareState = "idle";
    }
    reconcileMediaRoomIdleDisconnect(context.livekitRoom, "screen_share_consumer_detached_idle");
  }

  async function unpublishScreenShareEntry(entry: ScreenShareRuntimeEntry): Promise<void> {
    const localParticipant = context.livekitRoom?.localParticipant as {
      unpublishTrack?: (track: MediaStreamTrack, stopOnUnpublish?: boolean) => Promise<unknown> | unknown;
    } | undefined;
    if (!localParticipant?.unpublishTrack) {
      return;
    }
    await Promise.all(entry.publishedTracks.map((track) => Promise.resolve(localParticipant.unpublishTrack!(track, true)).catch(() => undefined)));
  }

  function isActiveScreenShareObject(object: MediaObjectInstance<ScreenShareObjectState> | null | undefined): object is MediaObjectInstance<ScreenShareObjectState> {
    return isCurrentScreenShareObject(object)
      && object.state.status === "active";
  }

  function isCurrentScreenShareObject(object: MediaObjectInstance<ScreenShareObjectState> | null | undefined): object is MediaObjectInstance<ScreenShareObjectState> {
    if (!object) {
      return false;
    }
    return object.type === SCREEN_SHARE_OBJECT_TYPE
      && object.state.status !== "stopped"
      && object.state.status !== "failed"
      && context.roomMediaObjects?.surfaces[object.surfaceId]?.activeObjectId === object.objectId;
  }

  function syncScreenShareRuntimeWithObjects(): void {
    if (!context.roomMediaObjects) {
      return;
    }
    for (const entry of screenShareEntries()) {
      const currentObject = context.roomMediaObjects.objects[entry.objectId] as MediaObjectInstance<ScreenShareObjectState> | undefined;
      const matchedObject = isCurrentScreenShareObject(currentObject)
        && mediaSurfaceViews.has(currentObject.surfaceId)
        && (!currentObject.state.mediaTrackSid || currentObject.state.mediaTrackSid === entry.mediaTrackSid)
        ? currentObject
        : physicalScreenShareObjectForMediaTrack(context.roomMediaObjects, mediaSurfaceViews, entry.ownerParticipantId, entry.mediaTrackSid, "video");
      if (!isCurrentScreenShareObject(matchedObject)) {
        detachScreenShareEntry(entry);
        continue;
      }
      if (matchedObject.objectId !== entry.objectId) {
        screenShareRuntimeByObjectId.delete(entry.objectId);
        entry.objectId = matchedObject.objectId;
        screenShareRuntimeByObjectId.set(entry.objectId, entry);
      }
      entry.ownerParticipantId = matchedObject.ownerParticipantId;
      entry.mediaTrackSid = matchedObject.state.mediaTrackSid ?? entry.mediaTrackSid;
      moveScreenShareEntryToSurface(entry, matchedObject.surfaceId);
    }
  }

  return {
    screenShareEntries,
    hasLocalScreenSharePublishing,
    remoteScreenShareTrackCount,
    localScreenShareEntryForSurface,
    anyLocalScreenShareEntry,
    screenShareEntryForTrack,
    screenShareEntryForObject,
    createScreenShareVideoTexture,
    moveScreenShareEntryToSurface,
    registerScreenShareEntry,
    detachScreenShareEntry,
    unpublishScreenShareEntry,
    isActiveScreenShareObject,
    syncScreenShareRuntimeWithObjects
  };
}
