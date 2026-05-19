import {
  REMOTE_BROWSER_OBJECT_TYPE,
  SCREEN_SHARE_OBJECT_TYPE,
  WHITEBOARD_OBJECT_TYPE,
  type MediaObjectInstance,
  type RemoteBrowserObjectState,
  type RoomMediaObjectsState,
  type ScreenShareObjectState,
  type WhiteboardState
} from "@noah/shared-types";

export function activeMediaObjectForSurface(mediaObjects: RoomMediaObjectsState | null, surfaceId: string): MediaObjectInstance | null {
  const surface = mediaObjects?.surfaces[surfaceId];
  const objectId = surface?.activeObjectId;
  return objectId ? mediaObjects?.objects[objectId] ?? null : null;
}

export function activeMediaObjectIdForSurface(mediaObjects: RoomMediaObjectsState | null, surfaceId: string): string | undefined {
  return activeMediaObjectForSurface(mediaObjects, surfaceId)?.objectId;
}

export function isScreenShareState(state: unknown): state is ScreenShareObjectState {
  return Boolean(state)
    && typeof state === "object"
    && typeof (state as { status?: unknown }).status === "string"
    && typeof (state as { ownerParticipantId?: unknown }).ownerParticipantId === "string"
    && typeof (state as { surfaceId?: unknown }).surfaceId === "string";
}

export function activeScreenShareObjectForSurface(mediaObjects: RoomMediaObjectsState | null, surfaceId: string): MediaObjectInstance<ScreenShareObjectState> | null {
  const object = activeMediaObjectForSurface(mediaObjects, surfaceId);
  if (!object || object.type !== SCREEN_SHARE_OBJECT_TYPE || !isScreenShareState(object.state)) {
    return null;
  }
  return object as MediaObjectInstance<ScreenShareObjectState>;
}

export function isWhiteboardState(state: unknown): state is WhiteboardState {
  return Boolean(state)
    && typeof state === "object"
    && (state as { status?: unknown }).status === "active"
    && Array.isArray((state as { strokes?: unknown }).strokes)
    && typeof (state as { revision?: unknown }).revision === "number";
}

export function activeWhiteboardObjectForSurface(mediaObjects: RoomMediaObjectsState | null, surfaceId: string): MediaObjectInstance<WhiteboardState> | null {
  const object = activeMediaObjectForSurface(mediaObjects, surfaceId);
  if (!object || object.type !== WHITEBOARD_OBJECT_TYPE || !isWhiteboardState(object.state)) {
    return null;
  }
  return object as MediaObjectInstance<WhiteboardState>;
}

export function isRemoteBrowserState(state: unknown): state is RemoteBrowserObjectState {
  return Boolean(state)
    && typeof state === "object"
    && typeof (state as { status?: unknown }).status === "string"
    && typeof (state as { ownerParticipantId?: unknown }).ownerParticipantId === "string"
    && typeof (state as { surfaceId?: unknown }).surfaceId === "string";
}

export function activeRemoteBrowserObjectForSurface(mediaObjects: RoomMediaObjectsState | null, surfaceId: string): MediaObjectInstance<RemoteBrowserObjectState> | null {
  const object = activeMediaObjectForSurface(mediaObjects, surfaceId);
  if (!object || object.type !== REMOTE_BROWSER_OBJECT_TYPE || !isRemoteBrowserState(object.state)) {
    return null;
  }
  return object as MediaObjectInstance<RemoteBrowserObjectState>;
}

function isMockRemoteBrowserTrackSid(trackSid: string): boolean {
  return trackSid.startsWith("mock-remote-browser-");
}

export function remoteBrowserObjectNeedsLiveKitRoom(object: MediaObjectInstance<RemoteBrowserObjectState> | null | undefined): boolean {
  if (!object || object.type !== REMOTE_BROWSER_OBJECT_TYPE || !isRemoteBrowserState(object.state)) {
    return false;
  }
  if (!object.state.mediaParticipantId || object.state.status !== "active") {
    return false;
  }
  const trackSids = [object.state.mediaTrackSid, object.state.audioTrackSid].filter((trackSid): trackSid is string => Boolean(trackSid));
  return trackSids.some((trackSid) => !isMockRemoteBrowserTrackSid(trackSid));
}

export function remoteBrowserObjectForMediaTrack(mediaObjects: RoomMediaObjectsState | null, participantId: string | null | undefined, trackSid: string | null | undefined, kind: "audio" | "video"): MediaObjectInstance<RemoteBrowserObjectState> | null {
  if (!mediaObjects || !participantId) {
    return null;
  }
  let participantScopedMatch: MediaObjectInstance<RemoteBrowserObjectState> | null = null;
  for (const object of Object.values(mediaObjects.objects)) {
    if (object.type !== REMOTE_BROWSER_OBJECT_TYPE || !isRemoteBrowserState(object.state)) {
      continue;
    }
    const state = object.state as RemoteBrowserObjectState;
    if (state.mediaParticipantId !== participantId || state.status !== "active") {
      continue;
    }
    const expectedTrackSid = kind === "video" ? state.mediaTrackSid : state.audioTrackSid;
    if (!expectedTrackSid || (trackSid && expectedTrackSid !== trackSid)) {
      if (expectedTrackSid && trackSid && expectedTrackSid !== trackSid) {
        participantScopedMatch ??= object as MediaObjectInstance<RemoteBrowserObjectState>;
      }
      continue;
    }
    return object as MediaObjectInstance<RemoteBrowserObjectState>;
  }
  return participantScopedMatch;
}

export function resolveScreenShareSurfaceForOwner(mediaObjects: RoomMediaObjectsState | null, ownerParticipantId: string | null | undefined, fallbackSurfaceId: string): string {
  if (!ownerParticipantId || !mediaObjects) {
    return fallbackSurfaceId;
  }
  const object = Object.values(mediaObjects.objects).find((item) => {
    if (item.type !== SCREEN_SHARE_OBJECT_TYPE || !isScreenShareState(item.state)) {
      return false;
    }
    return item.state.ownerParticipantId === ownerParticipantId && item.state.status === "active";
  });
  return object?.surfaceId ?? fallbackSurfaceId;
}
