import {
  SCREEN_SHARE_OBJECT_TYPE, WHITEBOARD_OBJECT_TYPE, MARKDOWN_BOARD_OBJECT_TYPE,
  REMOTE_BROWSER_OBJECT_TYPE, PDF_PRESENTATION_OBJECT_TYPE, IMAGE_VIEWER_OBJECT_TYPE, VIDEO_PLAYER_OBJECT_TYPE,
  type MediaObjectInstance, type RoomMediaObjectsState, type ScreenShareObjectState,
  type WhiteboardState, type MarkdownBoardState, type RemoteBrowserObjectState,
  type PdfPresentationState, type ImageViewerState, type VideoPlayerState
} from "@vrata/shared-types";
import {
  activeMediaObjectForSurface as selectActiveMediaObjectForSurface,
  activeMediaObjectIdForSurface as selectActiveMediaObjectIdForSurface,
  activeMarkdownBoardObjectForSurface as selectActiveMarkdownBoardObjectForSurface,
  activePdfPresentationObjectForSurface as selectActivePdfPresentationObjectForSurface,
  activeImageViewerObjectForSurface as selectActiveImageViewerObjectForSurface,
  activeVideoPlayerObjectForSurface as selectActiveVideoPlayerObjectForSurface,
  activeRemoteBrowserObjectForSurface as selectActiveRemoteBrowserObjectForSurface,
  activeScreenShareObjectForSurface as selectActiveScreenShareObjectForSurface,
  activeWhiteboardObjectForSurface as selectActiveWhiteboardObjectForSurface,
  findPhysicalRemoteBrowserObjectNeedingLiveKitRoom
} from "./media-object-state.js";

export interface MediaObjectQueriesContext {
  // The room snapshot and selection can be replaced after initialization.
  readonly roomMediaObjects: RoomMediaObjectsState | null;
  readonly selectedMediaSurfaceId: string;
  participantId: string;
  mediaSurfaceViews: Pick<ReadonlySet<string>, "has">;
}

export function createMediaObjectQueries(context: MediaObjectQueriesContext) {
  const { participantId, mediaSurfaceViews } = context;

  function activeMediaObjectForSurface(surfaceId: string): MediaObjectInstance | null {
    return selectActiveMediaObjectForSurface(context.roomMediaObjects, surfaceId);
  }

  function activeMediaObjectIdForSurface(surfaceId: string): string | undefined {
    return selectActiveMediaObjectIdForSurface(context.roomMediaObjects, surfaceId);
  }

  function activeScreenShareObjectForSurface(surfaceId: string): MediaObjectInstance<ScreenShareObjectState> | null {
    return selectActiveScreenShareObjectForSurface(context.roomMediaObjects, surfaceId);
  }

  function activeWhiteboardObjectForSurface(surfaceId: string): MediaObjectInstance<WhiteboardState> | null {
    return selectActiveWhiteboardObjectForSurface(context.roomMediaObjects, surfaceId);
  }

  function activeMarkdownBoardObjectForSurface(surfaceId: string): MediaObjectInstance<MarkdownBoardState> | null {
    return selectActiveMarkdownBoardObjectForSurface(context.roomMediaObjects, surfaceId);
  }

  function activeRemoteBrowserObjectForSurface(surfaceId: string): MediaObjectInstance<RemoteBrowserObjectState> | null {
    return selectActiveRemoteBrowserObjectForSurface(context.roomMediaObjects, surfaceId);
  }

  function activePdfPresentationObjectForSurface(surfaceId: string): MediaObjectInstance<PdfPresentationState> | null {
    return selectActivePdfPresentationObjectForSurface(context.roomMediaObjects, surfaceId);
  }

  function activeImageViewerObjectForSurface(surfaceId: string): MediaObjectInstance<ImageViewerState> | null {
    return selectActiveImageViewerObjectForSurface(context.roomMediaObjects, surfaceId);
  }

  function activeVideoPlayerObjectForSurface(surfaceId: string): MediaObjectInstance<VideoPlayerState> | null {
    return selectActiveVideoPlayerObjectForSurface(context.roomMediaObjects, surfaceId);
  }

  function findActiveObjectByType<State>(type: string): MediaObjectInstance<State> | null {
    if (!context.roomMediaObjects) {
      return null;
    }
    for (const object of Object.values(context.roomMediaObjects.objects)) {
      if (mediaSurfaceViews.has(object.surfaceId)
        && object.type === type
        && context.roomMediaObjects.surfaces[object.surfaceId]?.activeObjectId === object.objectId) {
        return object as MediaObjectInstance<State>;
      }
    }
    return null;
  }

  function findActiveScreenShareObject(): MediaObjectInstance<ScreenShareObjectState> | null {
    return findActiveObjectByType<ScreenShareObjectState>(SCREEN_SHARE_OBJECT_TYPE);
  }

  function findLocalActiveScreenShareObject(surfaceId?: string): MediaObjectInstance<ScreenShareObjectState> | null {
    if (!context.roomMediaObjects) {
      return null;
    }
    for (const object of Object.values(context.roomMediaObjects.objects)) {
      if (object.type !== SCREEN_SHARE_OBJECT_TYPE || object.ownerParticipantId !== participantId) {
        continue;
      }
      if (!mediaSurfaceViews.has(object.surfaceId)) {
        continue;
      }
      if (surfaceId && object.surfaceId !== surfaceId) {
        continue;
      }
      if (context.roomMediaObjects.surfaces[object.surfaceId]?.activeObjectId === object.objectId) {
        return object as MediaObjectInstance<ScreenShareObjectState>;
      }
    }
    return null;
  }

  function findActiveWhiteboardObject(): MediaObjectInstance<WhiteboardState> | null {
    return findActiveObjectByType<WhiteboardState>(WHITEBOARD_OBJECT_TYPE);
  }

  function findActiveMarkdownBoardObject(): MediaObjectInstance<MarkdownBoardState> | null {
    return findActiveObjectByType<MarkdownBoardState>(MARKDOWN_BOARD_OBJECT_TYPE);
  }

  function findActiveRemoteBrowserObject(): MediaObjectInstance<RemoteBrowserObjectState> | null {
    return findActiveObjectByType<RemoteBrowserObjectState>(REMOTE_BROWSER_OBJECT_TYPE);
  }

  function findActivePdfPresentationObject(): MediaObjectInstance<PdfPresentationState> | null {
    return findActiveObjectByType<PdfPresentationState>(PDF_PRESENTATION_OBJECT_TYPE);
  }

  function findActiveImageViewerObject(): MediaObjectInstance<ImageViewerState> | null {
    return findActiveObjectByType<ImageViewerState>(IMAGE_VIEWER_OBJECT_TYPE);
  }

  function findActiveVideoPlayerObject(): MediaObjectInstance<VideoPlayerState> | null {
    return findActiveObjectByType<VideoPlayerState>(VIDEO_PLAYER_OBJECT_TYPE);
  }

  function findRemoteBrowserObjectNeedingLiveKitRoom(): MediaObjectInstance<RemoteBrowserObjectState> | null {
    return findPhysicalRemoteBrowserObjectNeedingLiveKitRoom(context.roomMediaObjects, mediaSurfaceViews);
  }

  function currentWhiteboardObject(): MediaObjectInstance<WhiteboardState> | null {
    return activeWhiteboardObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveWhiteboardObject();
  }

  function currentMarkdownBoardObject(): MediaObjectInstance<MarkdownBoardState> | null {
    return activeMarkdownBoardObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveMarkdownBoardObject();
  }

  function currentRemoteBrowserObject(): MediaObjectInstance<RemoteBrowserObjectState> | null {
    return activeRemoteBrowserObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveRemoteBrowserObject();
  }

  function currentPdfPresentationObject(): MediaObjectInstance<PdfPresentationState> | null {
    return activePdfPresentationObjectForSurface(context.selectedMediaSurfaceId) ?? findActivePdfPresentationObject();
  }

  function currentImageViewerObject(): MediaObjectInstance<ImageViewerState> | null {
    return activeImageViewerObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveImageViewerObject();
  }

  function currentVideoPlayerObject(): MediaObjectInstance<VideoPlayerState> | null {
    return activeVideoPlayerObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveVideoPlayerObject();
  }

  function activeWhiteboardObjects(): Array<MediaObjectInstance<WhiteboardState>> {
    if (!context.roomMediaObjects) {
      return [];
    }
    const objects: Array<MediaObjectInstance<WhiteboardState>> = [];
    for (const surfaceId of Object.keys(context.roomMediaObjects.surfaces)) {
      const object = activeWhiteboardObjectForSurface(surfaceId);
      if (object) {
        objects.push(object);
      }
    }
    return objects;
  }

  function activeMarkdownBoardObjects(): Array<MediaObjectInstance<MarkdownBoardState>> {
    if (!context.roomMediaObjects) {
      return [];
    }
    const objects: Array<MediaObjectInstance<MarkdownBoardState>> = [];
    for (const surfaceId of Object.keys(context.roomMediaObjects.surfaces)) {
      const object = activeMarkdownBoardObjectForSurface(surfaceId);
      if (object) {
        objects.push(object);
      }
    }
    return objects;
  }

  function activeRemoteBrowserObjects(): Array<MediaObjectInstance<RemoteBrowserObjectState>> {
    if (!context.roomMediaObjects) {
      return [];
    }
    const objects: Array<MediaObjectInstance<RemoteBrowserObjectState>> = [];
    for (const surfaceId of Object.keys(context.roomMediaObjects.surfaces)) {
      const object = activeRemoteBrowserObjectForSurface(surfaceId);
      if (object) {
        objects.push(object);
      }
    }
    return objects;
  }

  function activePdfPresentationObjects(): Array<MediaObjectInstance<PdfPresentationState>> {
    if (!context.roomMediaObjects) {
      return [];
    }
    const objects: Array<MediaObjectInstance<PdfPresentationState>> = [];
    for (const surfaceId of Object.keys(context.roomMediaObjects.surfaces)) {
      const object = activePdfPresentationObjectForSurface(surfaceId);
      if (object) objects.push(object);
    }
    return objects;
  }

  return {
    activeMediaObjectForSurface,
    activeMediaObjectIdForSurface,
    activeScreenShareObjectForSurface,
    activeWhiteboardObjectForSurface,
    activeMarkdownBoardObjectForSurface,
    activeRemoteBrowserObjectForSurface,
    activePdfPresentationObjectForSurface,
    activeImageViewerObjectForSurface,
    activeVideoPlayerObjectForSurface,
    findActiveScreenShareObject,
    findLocalActiveScreenShareObject,
    findActiveWhiteboardObject,
    findActiveMarkdownBoardObject,
    findActiveRemoteBrowserObject,
    findActivePdfPresentationObject,
    findActiveImageViewerObject,
    findActiveVideoPlayerObject,
    findRemoteBrowserObjectNeedingLiveKitRoom,
    currentWhiteboardObject,
    currentMarkdownBoardObject,
    currentRemoteBrowserObject,
    currentPdfPresentationObject,
    currentImageViewerObject,
    currentVideoPlayerObject,
    activeWhiteboardObjects,
    activeMarkdownBoardObjects,
    activeRemoteBrowserObjects,
    activePdfPresentationObjects
  };
}
