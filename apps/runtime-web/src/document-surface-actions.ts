import {
  PDF_PRESENTATION_OBJECT_TYPE,
  IMAGE_VIEWER_OBJECT_TYPE,
  VIDEO_PLAYER_OBJECT_TYPE,
  type MediaObjectInstance,
  type PdfPresentationState,
  type ImageViewerState,
  type VideoPlayerState,
  type PdfPresentationPatch,
  type ImageViewerPatch,
  type VideoPlayerPatch
} from "@vrata/shared-types";
import type * as RuntimeApi from "./index.js";
import type { createMediaObjectQueries } from "./media/media-object-queries.js";
import type { MediaSurfaceCommandClient } from "./media/media-surface-commands.js";

type DocumentObjectQueries = Pick<ReturnType<typeof createMediaObjectQueries>,
  | "activeMediaObjectForSurface"
  | "activePdfPresentationObjectForSurface"
  | "activeImageViewerObjectForSurface"
  | "activeVideoPlayerObjectForSurface"
  | "currentPdfPresentationObject"
  | "currentImageViewerObject"
  | "currentVideoPlayerObject"
>;

export interface DocumentSurfaceActionsContext extends DocumentObjectQueries {
  apiBaseUrl: string;
  roomId: string;
  participantId: string;
  // These bindings are read or written again after asynchronous operations.
  readonly selectedMediaSurfaceId: string;
  readonly roomStateAccessToken: string;
  roomDocuments: RuntimeApi.RuntimeDocumentRecord[];
  presentationActionInFlight: boolean;
  selectedDocument: () => RuntimeApi.RuntimeDocumentRecord | null;
  canPresentDocuments: () => boolean;
  setDocumentStatus: (message: string, errorCode?: string | null) => void;
  documentErrorCode: (error: unknown) => string;
  presentationInputEventId: (kind: string) => string;
  documentMediaInputEventId: (kind: string) => string;
  renderDocumentsUi: (message?: string) => void;
  renderPresentationControls: () => void;
  renderDocumentMediaControls: () => void;
  documentStatusEl: Pick<HTMLElement, "textContent">;
  presentationStatusEl: Pick<HTMLElement, "textContent">;
  documentMediaStatusEl: Pick<HTMLElement, "textContent">;
  debugState: { pdfPresentation: { errorCode: string | null } };
  selectRoomDocumentSurface: typeof RuntimeApi.selectRoomDocumentSurface;
  mediaSurfaceCommands: Pick<MediaSurfaceCommandClient,
    | "createPdfPresentationObjectOnSurface"
    | "createImageViewerObjectOnSurface"
    | "createVideoPlayerObjectOnSurface"
    | "patchPdfPresentationObject"
    | "patchImageViewerObject"
    | "patchVideoPlayerObject"
    | "stopPdfPresentationObject"
    | "stopImageViewerObject"
    | "stopVideoPlayerObject"
  >;
}

export function createDocumentSurfaceActions(context: DocumentSurfaceActionsContext) {
  const {
    apiBaseUrl,
    roomId,
    participantId,
    selectedDocument,
    canPresentDocuments,
    setDocumentStatus,
    activeMediaObjectForSurface,
    activePdfPresentationObjectForSurface,
    activeImageViewerObjectForSurface,
    activeVideoPlayerObjectForSurface,
    currentPdfPresentationObject,
    currentImageViewerObject,
    currentVideoPlayerObject,
    mediaSurfaceCommands,
    selectRoomDocumentSurface,
    presentationInputEventId,
    documentMediaInputEventId,
    renderDocumentsUi,
    documentErrorCode,
    documentStatusEl,
    renderPresentationControls,
    presentationStatusEl,
    debugState,
    renderDocumentMediaControls,
    documentMediaStatusEl
  } = context;

  async function selectDocumentForSurface(): Promise<void> {
    const selected = selectedDocument();
    if (!selected) return;
    const kind = selected.metadata?.kind;
    if (!canPresentDocuments() || !kind || !["pdf", "image", "video"].includes(kind)) {
      setDocumentStatus("Presentable document and presenter role required", "document_not_presentable");
      return;
    }
    context.presentationActionInFlight = true;
    let createdObject: { objectId: string; surfaceId: string; kind: "pdf" | "image" | "video" } | null = null;
    let metadataLinked = false;
    let previousDocumentId: string | null = null;
    try {
      setDocumentStatus("Selecting document for surface...");
      const occupied = activeMediaObjectForSurface(context.selectedMediaSurfaceId);
      let mediaObject: MediaObjectInstance<PdfPresentationState | ImageViewerState | VideoPlayerState> | null = kind === "pdf"
        ? activePdfPresentationObjectForSurface(context.selectedMediaSurfaceId)
        : kind === "image" ? activeImageViewerObjectForSurface(context.selectedMediaSurfaceId) : activeVideoPlayerObjectForSurface(context.selectedMediaSurfaceId);
      if (occupied && !mediaObject) {
        throw new Error("surface-occupied");
      }
      if (!mediaObject) {
        const createResult = kind === "pdf"
          ? await mediaSurfaceCommands.createPdfPresentationObjectOnSurface(context.selectedMediaSurfaceId)
          : kind === "image" ? await mediaSurfaceCommands.createImageViewerObjectOnSurface(context.selectedMediaSurfaceId) : await mediaSurfaceCommands.createVideoPlayerObjectOnSurface(context.selectedMediaSurfaceId);
        if (!createResult.accepted || !createResult.objectId) {
          throw new Error(createResult.blockedReason ?? "document_media_create_rejected");
        }
        createdObject = { objectId: createResult.objectId, surfaceId: context.selectedMediaSurfaceId, kind };
        const idleState: PdfPresentationState | ImageViewerState | VideoPlayerState = kind === "pdf"
          ? { status: "idle" as const, documentId: null, filename: null, checksum: null, pageCount: 0, currentPage: 1, displayMode: "normal" as const, lastInputEventId: null }
          : kind === "image"
            ? { status: "idle" as const, documentId: null, filename: null, checksum: null, contentType: null, widthPx: 0, heightPx: 0, fitMode: "contain" as const, lastInputEventId: null }
            : { status: "idle" as const, documentId: null, filename: null, checksum: null, contentType: null, widthPx: 0, heightPx: 0, durationMs: 0, playbackState: "paused" as const, positionMs: 0, anchorServerTimeMs: null, loop: false, fitMode: "contain" as const, lastInputEventId: null };
        mediaObject = {
          objectId: createResult.objectId,
          type: kind === "pdf" ? PDF_PRESENTATION_OBJECT_TYPE : kind === "image" ? IMAGE_VIEWER_OBJECT_TYPE : VIDEO_PLAYER_OBJECT_TYPE,
          roomId,
          surfaceId: context.selectedMediaSurfaceId,
          ownerParticipantId: participantId,
          state: idleState,
          status: "active",
          revision: createResult.revision ?? 0,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now()
        };
      } else {
        previousDocumentId = mediaObject.state.documentId;
      }
      if (!mediaObject) throw new Error("document_media_object_missing");
      const updated = await selectRoomDocumentSurface(apiBaseUrl, roomId, selected.documentId, context.selectedMediaSurfaceId, context.roomStateAccessToken);
      metadataLinked = true;
      context.roomDocuments = context.roomDocuments.map((item) => item.documentId === updated.documentId
        ? updated
        : item.linkedSurfaceId === context.selectedMediaSurfaceId ? { ...item, linkedSurfaceId: null } : item);
      const patchResult = kind === "pdf"
        ? await mediaSurfaceCommands.patchPdfPresentationObject(mediaObject.objectId, mediaObject.surfaceId, mediaObject.revision, {
          type: "select-document",
          documentId: updated.documentId,
          filename: updated.filename,
          checksum: updated.checksum,
          pageCount: updated.metadata?.pageCount ?? selected.metadata?.pageCount ?? 0,
          inputEventId: presentationInputEventId("select-document")
        })
        : kind === "image"
          ? await mediaSurfaceCommands.patchImageViewerObject(mediaObject.objectId, mediaObject.surfaceId, mediaObject.revision, {
            type: "select-image",
            documentId: updated.documentId,
            filename: updated.filename,
            checksum: updated.checksum,
            contentType: updated.contentType as "image/png" | "image/jpeg" | "image/webp",
            widthPx: updated.metadata?.widthPx ?? 0,
            heightPx: updated.metadata?.heightPx ?? 0,
            inputEventId: documentMediaInputEventId("select-image")
          })
          : await mediaSurfaceCommands.patchVideoPlayerObject(mediaObject.objectId, mediaObject.surfaceId, mediaObject.revision, {
            type: "select-video",
            documentId: updated.documentId,
            filename: updated.filename,
            checksum: updated.checksum,
            contentType: updated.contentType as "video/mp4" | "video/webm",
            widthPx: updated.metadata?.widthPx ?? 0,
            heightPx: updated.metadata?.heightPx ?? 0,
            durationMs: updated.metadata?.durationMs ?? 0,
            inputEventId: documentMediaInputEventId("select-video")
          });
      if (!patchResult.accepted) {
        throw new Error(patchResult.blockedReason ?? "presentation_select_rejected");
      }
      renderDocumentsUi(`Document selected for surface: ${updated.filename}`);
    } catch (error) {
      if (createdObject) {
        const stopPromise = createdObject.kind === "pdf"
          ? mediaSurfaceCommands.stopPdfPresentationObject(createdObject.objectId, createdObject.surfaceId)
          : createdObject.kind === "image"
            ? mediaSurfaceCommands.stopImageViewerObject(createdObject.objectId, createdObject.surfaceId)
            : mediaSurfaceCommands.stopVideoPlayerObject(createdObject.objectId, createdObject.surfaceId);
        await stopPromise.catch(() => undefined);
      }
      if (metadataLinked) {
        await selectRoomDocumentSurface(apiBaseUrl, roomId, selected.documentId, null, context.roomStateAccessToken).catch(() => undefined);
        context.roomDocuments = context.roomDocuments.map((item) => item.documentId === selected.documentId ? { ...item, linkedSurfaceId: null } : item);
        if (previousDocumentId && previousDocumentId !== selected.documentId) {
          const restored = await selectRoomDocumentSurface(apiBaseUrl, roomId, previousDocumentId, context.selectedMediaSurfaceId, context.roomStateAccessToken).catch(() => null);
          if (restored) {
            context.roomDocuments = context.roomDocuments.map((item) => item.documentId === restored.documentId ? restored : item);
          }
        }
      }
      console.warn("document_surface_select_failed", error);
      setDocumentStatus(`Document surface selection failed: ${documentErrorCode(error)}`, documentErrorCode(error));
    } finally {
      context.presentationActionInFlight = false;
      renderDocumentsUi(documentStatusEl.textContent || undefined);
    }
  }

  async function patchCurrentPresentation(patch: PdfPresentationPatch): Promise<void> {
    const object = currentPdfPresentationObject();
    if (!object || !canPresentDocuments() || context.presentationActionInFlight) return;
    context.presentationActionInFlight = true;
    renderPresentationControls();
    try {
      const result = await mediaSurfaceCommands.patchPdfPresentationObject(object.objectId, object.surfaceId, object.revision, patch);
      if (!result.accepted) throw new Error(result.blockedReason ?? "presentation_patch_rejected");
    } catch (error) {
      presentationStatusEl.textContent = `Presentation control failed: ${documentErrorCode(error)}`;
      debugState.pdfPresentation.errorCode = documentErrorCode(error);
    } finally {
      context.presentationActionInFlight = false;
      renderPresentationControls();
    }
  }

  async function goToPresentationPage(page: number): Promise<void> {
    await patchCurrentPresentation({ type: "go-to-page", page, inputEventId: presentationInputEventId("page") });
  }

  async function togglePresentationDisplayMode(): Promise<void> {
    const object = currentPdfPresentationObject();
    if (!object) return;
    await patchCurrentPresentation({
      type: "set-display-mode",
      displayMode: object.state.displayMode === "large" ? "normal" : "large",
      inputEventId: presentationInputEventId("display-mode")
    });
  }

  async function stopCurrentPresentation(): Promise<void> {
    const object = currentPdfPresentationObject();
    if (!object || !canPresentDocuments() || context.presentationActionInFlight) return;
    context.presentationActionInFlight = true;
    try {
      const result = await mediaSurfaceCommands.stopPdfPresentationObject(object.objectId, object.surfaceId);
      if (!result.accepted) throw new Error(result.blockedReason ?? "presentation_stop_rejected");
      if (object.state.documentId) {
        const updated = await selectRoomDocumentSurface(apiBaseUrl, roomId, object.state.documentId, null, context.roomStateAccessToken);
        context.roomDocuments = context.roomDocuments.map((item) => item.documentId === updated.documentId ? updated : item);
      }
      setDocumentStatus("Presentation stopped");
    } catch (error) {
      setDocumentStatus(`Presentation stop failed: ${documentErrorCode(error)}`, documentErrorCode(error));
    } finally {
      context.presentationActionInFlight = false;
      renderDocumentsUi(documentStatusEl.textContent || undefined);
    }
  }

  async function patchCurrentDocumentMedia(patch: ImageViewerPatch | VideoPlayerPatch): Promise<void> {
    const video = currentVideoPlayerObject();
    const image = video ? null : currentImageViewerObject();
    const object = video ?? image;
    if (!object || !canPresentDocuments() || context.presentationActionInFlight) return;
    context.presentationActionInFlight = true;
    renderDocumentMediaControls();
    try {
      const result = video
        ? await mediaSurfaceCommands.patchVideoPlayerObject(video.objectId, video.surfaceId, video.revision, patch as VideoPlayerPatch)
        : await mediaSurfaceCommands.patchImageViewerObject(image!.objectId, image!.surfaceId, image!.revision, patch as ImageViewerPatch);
      if (!result.accepted) throw new Error(result.blockedReason ?? "document_media_patch_rejected");
    } catch (error) {
      documentMediaStatusEl.textContent = `Media control failed: ${documentErrorCode(error)}`;
    } finally {
      context.presentationActionInFlight = false;
      renderDocumentMediaControls();
    }
  }

  async function toggleDocumentMediaPlayback(): Promise<void> {
    const video = currentVideoPlayerObject();
    if (!video) return;
    await patchCurrentDocumentMedia({
      type: video.state.playbackState === "playing" ? "pause" : "play",
      inputEventId: documentMediaInputEventId("playback")
    });
  }

  async function toggleDocumentMediaFit(): Promise<void> {
    const object = currentVideoPlayerObject() ?? currentImageViewerObject();
    if (!object) return;
    await patchCurrentDocumentMedia({
      type: "set-fit-mode",
      fitMode: object.state.fitMode === "contain" ? "cover" : "contain",
      inputEventId: documentMediaInputEventId("fit")
    });
  }

  async function stopCurrentDocumentMedia(): Promise<void> {
    const video = currentVideoPlayerObject();
    const image = video ? null : currentImageViewerObject();
    const object = video ?? image;
    if (!object || !canPresentDocuments() || context.presentationActionInFlight) return;
    context.presentationActionInFlight = true;
    try {
      const result = video
        ? await mediaSurfaceCommands.stopVideoPlayerObject(video.objectId, video.surfaceId)
        : await mediaSurfaceCommands.stopImageViewerObject(image!.objectId, image!.surfaceId);
      if (!result.accepted) throw new Error(result.blockedReason ?? "document_media_stop_rejected");
      if (object.state.documentId) {
        const updated = await selectRoomDocumentSurface(apiBaseUrl, roomId, object.state.documentId, null, context.roomStateAccessToken);
        context.roomDocuments = context.roomDocuments.map((item) => item.documentId === updated.documentId ? updated : item);
      }
      setDocumentStatus("Media stopped");
    } catch (error) {
      setDocumentStatus(`Media stop failed: ${documentErrorCode(error)}`, documentErrorCode(error));
    } finally {
      context.presentationActionInFlight = false;
      renderDocumentsUi(documentStatusEl.textContent || undefined);
    }
  }

  return {
    selectDocumentForSurface,
    patchCurrentPresentation,
    goToPresentationPage,
    togglePresentationDisplayMode,
    stopCurrentPresentation,
    patchCurrentDocumentMedia,
    toggleDocumentMediaPlayback,
    toggleDocumentMediaFit,
    stopCurrentDocumentMedia
  };
}
