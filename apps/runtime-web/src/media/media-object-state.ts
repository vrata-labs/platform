import {
  REMOTE_BROWSER_OBJECT_TYPE,
  PDF_PRESENTATION_OBJECT_TYPE,
  IMAGE_VIEWER_OBJECT_TYPE,
  VIDEO_PLAYER_OBJECT_TYPE,
  SCREEN_SHARE_OBJECT_TYPE,
  MARKDOWN_BOARD_OBJECT_TYPE,
  WHITEBOARD_OBJECT_TYPE,
  type MediaObjectInstance,
  type MarkdownBoardState,
  type PdfPresentationState,
  type ImageViewerState,
  type VideoPlayerState,
  type RemoteBrowserObjectState,
  type RoomMediaObjectsState,
  type ScreenShareObjectState,
  type WhiteboardState
} from "@vrata/shared-types";

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

export function isMarkdownBoardState(state: unknown): state is MarkdownBoardState {
  return Boolean(state)
    && typeof state === "object"
    && (state as { status?: unknown }).status === "active"
    && Array.isArray((state as { notes?: unknown }).notes)
    && typeof (state as { revision?: unknown }).revision === "number";
}

export function activeMarkdownBoardObjectForSurface(mediaObjects: RoomMediaObjectsState | null, surfaceId: string): MediaObjectInstance<MarkdownBoardState> | null {
  const object = activeMediaObjectForSurface(mediaObjects, surfaceId);
  if (!object || object.type !== MARKDOWN_BOARD_OBJECT_TYPE || !isMarkdownBoardState(object.state)) {
    return null;
  }
  return object as MediaObjectInstance<MarkdownBoardState>;
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

export function isPdfPresentationState(state: unknown): state is PdfPresentationState {
  return Boolean(state)
    && typeof state === "object"
    && ((state as { status?: unknown }).status === "idle" || (state as { status?: unknown }).status === "active")
    && typeof (state as { pageCount?: unknown }).pageCount === "number"
    && typeof (state as { currentPage?: unknown }).currentPage === "number"
    && ((state as { displayMode?: unknown }).displayMode === "normal" || (state as { displayMode?: unknown }).displayMode === "large");
}

export function activePdfPresentationObjectForSurface(mediaObjects: RoomMediaObjectsState | null, surfaceId: string): MediaObjectInstance<PdfPresentationState> | null {
  const object = activeMediaObjectForSurface(mediaObjects, surfaceId);
  if (!object || object.type !== PDF_PRESENTATION_OBJECT_TYPE || !isPdfPresentationState(object.state)) {
    return null;
  }
  return object as MediaObjectInstance<PdfPresentationState>;
}

export function activeImageViewerObjectForSurface(mediaObjects: RoomMediaObjectsState | null, surfaceId: string): MediaObjectInstance<ImageViewerState> | null {
  const object = activeMediaObjectForSurface(mediaObjects, surfaceId);
  const state = object?.state as Partial<ImageViewerState> | undefined;
  return object?.type === IMAGE_VIEWER_OBJECT_TYPE && (state?.status === "idle" || state?.status === "active")
    ? object as MediaObjectInstance<ImageViewerState>
    : null;
}

export function activeVideoPlayerObjectForSurface(mediaObjects: RoomMediaObjectsState | null, surfaceId: string): MediaObjectInstance<VideoPlayerState> | null {
  const object = activeMediaObjectForSurface(mediaObjects, surfaceId);
  const state = object?.state as Partial<VideoPlayerState> | undefined;
  return object?.type === VIDEO_PLAYER_OBJECT_TYPE && (state?.status === "idle" || state?.status === "active")
    ? object as MediaObjectInstance<VideoPlayerState>
    : null;
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
  let hasAuthoritativeTrackSid = false;
  for (const object of Object.values(mediaObjects.objects)) {
    if (object.type !== REMOTE_BROWSER_OBJECT_TYPE || !isRemoteBrowserState(object.state)) {
      continue;
    }
    const state = object.state as RemoteBrowserObjectState;
    if (state.mediaParticipantId !== participantId || state.status !== "active") {
      continue;
    }
    const expectedTrackSid = kind === "video" ? state.mediaTrackSid : state.audioTrackSid;
    if (!expectedTrackSid) {
      participantScopedMatch ??= object as MediaObjectInstance<RemoteBrowserObjectState>;
      continue;
    }
    hasAuthoritativeTrackSid = true;
    if (trackSid === expectedTrackSid) {
      return object as MediaObjectInstance<RemoteBrowserObjectState>;
    }
  }
  return hasAuthoritativeTrackSid ? null : participantScopedMatch;
}

type PhysicalMediaSurfaceLookup = Pick<ReadonlySet<string>, "has">;

export function physicalRemoteBrowserObjectForMediaTrack(
  mediaObjects: RoomMediaObjectsState | null,
  physicalSurfaceIds: PhysicalMediaSurfaceLookup,
  participantId: string | null | undefined,
  trackSid: string | null | undefined,
  kind: "audio" | "video"
): MediaObjectInstance<RemoteBrowserObjectState> | null {
  const object = remoteBrowserObjectForMediaTrack(mediaObjects, participantId, trackSid, kind);
  return object && physicalSurfaceIds.has(object.surfaceId) ? object : null;
}

export function findPhysicalRemoteBrowserObjectNeedingLiveKitRoom(
  mediaObjects: RoomMediaObjectsState | null,
  physicalSurfaceIds: PhysicalMediaSurfaceLookup
): MediaObjectInstance<RemoteBrowserObjectState> | null {
  if (!mediaObjects) {
    return null;
  }
  for (const [surfaceId, surface] of Object.entries(mediaObjects.surfaces)) {
    if (!physicalSurfaceIds.has(surfaceId) || !surface.activeObjectId) {
      continue;
    }
    const object = mediaObjects.objects[surface.activeObjectId] as MediaObjectInstance<RemoteBrowserObjectState> | undefined;
    if (object?.surfaceId === surfaceId && remoteBrowserObjectNeedsLiveKitRoom(object)) {
      return object;
    }
  }
  return null;
}

function isActiveScreenShareObject(mediaObjects: RoomMediaObjectsState, object: MediaObjectInstance): object is MediaObjectInstance<ScreenShareObjectState> {
  return object.type === SCREEN_SHARE_OBJECT_TYPE
    && isScreenShareState(object.state)
    && object.status === "active"
    && object.state.status === "active"
    && mediaObjects.surfaces[object.surfaceId]?.activeObjectId === object.objectId;
}

export function screenShareObjectForMediaTrack(
  mediaObjects: RoomMediaObjectsState | null,
  ownerParticipantId: string | null | undefined,
  trackSid: string | null | undefined,
  kind: "audio" | "video",
  publicationName?: string | null
): MediaObjectInstance<ScreenShareObjectState> | null {
  if (!mediaObjects || !ownerParticipantId) {
    return null;
  }

  const namedMatch = /^screen-share:([^:]+):(audio|video)$/.exec(publicationName ?? "");
  if (namedMatch) {
    if (namedMatch[2] !== kind) {
      return null;
    }
    const object = mediaObjects.objects[namedMatch[1]!];
    if (!object || !isActiveScreenShareObject(mediaObjects, object) || object.state.ownerParticipantId !== ownerParticipantId) {
      return null;
    }
    if (kind === "video" && object.state.mediaTrackSid && object.state.mediaTrackSid !== trackSid) {
      return null;
    }
    return object;
  }

  const ownerMatches = Object.values(mediaObjects.objects).filter((object): object is MediaObjectInstance<ScreenShareObjectState> => {
    return isActiveScreenShareObject(mediaObjects, object) && object.state.ownerParticipantId === ownerParticipantId;
  });
  if (kind === "audio") {
    return ownerMatches.length === 1 ? ownerMatches[0]! : null;
  }

  const exactMatch = ownerMatches.find((object) => object.state.mediaTrackSid === trackSid);
  if (exactMatch) {
    return exactMatch;
  }
  if (ownerMatches.some((object) => Boolean(object.state.mediaTrackSid))) {
    return null;
  }
  return ownerMatches.length === 1 ? ownerMatches[0]! : null;
}

export function physicalScreenShareObjectForMediaTrack(
  mediaObjects: RoomMediaObjectsState | null,
  physicalSurfaceIds: PhysicalMediaSurfaceLookup,
  ownerParticipantId: string | null | undefined,
  trackSid: string | null | undefined,
  kind: "audio" | "video",
  publicationName?: string | null
): MediaObjectInstance<ScreenShareObjectState> | null {
  const object = screenShareObjectForMediaTrack(mediaObjects, ownerParticipantId, trackSid, kind, publicationName);
  return object && physicalSurfaceIds.has(object.surfaceId) ? object : null;
}
