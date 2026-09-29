import type { MediaObjectInstance, PdfPresentationState, VideoPlayerState } from "@vrata/shared-types";
import type { createMediaObjectQueries } from "./media/media-object-queries.js";
import type { createPdfPresentationObjectRuntime } from "./media/pdf-presentation-object.js";
import type { createRuntimeDebugState } from "./runtime-debug-state.js";

type DocumentQueries = Pick<ReturnType<typeof createMediaObjectQueries>,
  "currentPdfPresentationObject" | "currentImageViewerObject" | "currentVideoPlayerObject"
>;

export interface DocumentSurfaceViewContext extends DocumentQueries {
  participantId: string;
  readonly roomStateServerOffsetMs: number;
  readonly selectedMediaSurfaceId: string;
  readonly presentationActionInFlight: boolean;
  canPresentDocuments: () => boolean;
  goToPresentationPage: (page: number) => Promise<void>;
  getPdfPresentationRuntime: (surfaceId: string) => Pick<ReturnType<typeof createPdfPresentationObjectRuntime>, "renderThumbnail" | "createDebugSnapshot">;
  debugState: Pick<ReturnType<typeof createRuntimeDebugState>, "pdfPresentation">;
  presentationControlsEl: Pick<HTMLElement, "hidden">;
  presentationPrevButton: Pick<HTMLButtonElement, "disabled">;
  presentationNextButton: Pick<HTMLButtonElement, "disabled">;
  presentationPageLabel: Pick<HTMLElement, "textContent">;
  presentationLargeButton: Pick<HTMLButtonElement, "disabled" | "textContent" | "setAttribute">;
  presentationStopButton: Pick<HTMLButtonElement, "disabled">;
  presentationThumbnailsEl: Pick<HTMLElement, "replaceChildren" | "append" | "querySelectorAll">;
  presentationStatusEl: Pick<HTMLElement, "textContent">;
  documentMediaControlsEl: Pick<HTMLElement, "hidden">;
  documentMediaTitleEl: Pick<HTMLElement, "textContent">;
  documentMediaPlayButton: Pick<HTMLButtonElement, "hidden" | "disabled" | "textContent">;
  documentMediaFitButton: Pick<HTMLButtonElement, "disabled" | "textContent">;
  documentMediaLoopLabel: Pick<HTMLElement, "hidden">;
  documentMediaLoopInput: Pick<HTMLInputElement, "disabled" | "checked">;
  documentMediaStopButton: Pick<HTMLButtonElement, "disabled">;
  documentMediaSeekInput: Pick<HTMLInputElement, "hidden" | "disabled" | "max" | "value">;
  documentMediaTimeEl: Pick<HTMLElement, "hidden" | "textContent">;
  documentMediaStatusEl: Pick<HTMLElement, "textContent">;
}

export function createDocumentSurfaceView(context: DocumentSurfaceViewContext) {
  const {
    participantId, currentPdfPresentationObject, currentImageViewerObject,
    currentVideoPlayerObject, canPresentDocuments, goToPresentationPage,
    getPdfPresentationRuntime, debugState, presentationControlsEl,
    presentationPrevButton, presentationNextButton, presentationPageLabel,
    presentationLargeButton, presentationStopButton, presentationThumbnailsEl,
    presentationStatusEl, documentMediaControlsEl, documentMediaTitleEl,
    documentMediaPlayButton, documentMediaFitButton, documentMediaLoopLabel,
    documentMediaLoopInput, documentMediaStopButton, documentMediaSeekInput,
    documentMediaTimeEl, documentMediaStatusEl
  } = context;

  let presentationThumbnailSignature = "";

  function presentationInputEventId(kind: string): string {
    return `${participantId}:pdf-presentation:${kind}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  }

  function documentMediaInputEventId(kind: string): string {
    return `${participantId}:document-media:${kind}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  }

  function formatMediaTime(milliseconds: number): string {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function currentVideoPositionMs(state: VideoPlayerState): number {
    const elapsed = state.playbackState === "playing" && state.anchorServerTimeMs !== null
      ? Math.max(0, Date.now() + context.roomStateServerOffsetMs - state.anchorServerTimeMs)
      : 0;
    const position = state.positionMs + elapsed;
    return state.loop && state.durationMs > 0 ? position % state.durationMs : Math.min(position, state.durationMs);
  }

  function renderDocumentMediaControls(): void {
    const image = currentImageViewerObject();
    const video = currentVideoPlayerObject();
    const object = video ?? image;
    const active = Boolean(object?.state.status === "active" && object.state.documentId);
    documentMediaControlsEl.hidden = !active;
    if (!object || !active) {
      documentMediaStatusEl.textContent = "Media idle";
      return;
    }
    const canPresent = canPresentDocuments() && !context.presentationActionInFlight;
    const state = object.state;
    documentMediaTitleEl.textContent = `${video ? "Video" : "Image"}: ${state.filename ?? "media"}`;
    documentMediaFitButton.disabled = !canPresent;
    documentMediaFitButton.textContent = state.fitMode === "contain" ? "Cover" : "Contain";
    documentMediaStopButton.disabled = !canPresent;
    documentMediaPlayButton.hidden = !video;
    documentMediaLoopLabel.hidden = !video;
    documentMediaSeekInput.hidden = !video;
    documentMediaTimeEl.hidden = !video;
    documentMediaPlayButton.disabled = !canPresent || !video;
    documentMediaLoopInput.disabled = !canPresent || !video;
    documentMediaSeekInput.disabled = !canPresent || !video;
    if (video) {
      const positionMs = currentVideoPositionMs(video.state);
      documentMediaPlayButton.textContent = video.state.playbackState === "playing" ? "Pause" : "Play";
      documentMediaLoopInput.checked = video.state.loop;
      documentMediaSeekInput.max = String(video.state.durationMs);
      documentMediaSeekInput.value = String(Math.round(positionMs));
      documentMediaTimeEl.textContent = `${formatMediaTime(positionMs)} / ${formatMediaTime(video.state.durationMs)}`;
    }
  }

  function renderPresentationThumbnails(object: MediaObjectInstance<PdfPresentationState>): void {
    const signature = `${object.objectId}:${object.state.documentId}:${object.state.pageCount}`;
    if (signature !== presentationThumbnailSignature) {
      presentationThumbnailSignature = signature;
      presentationThumbnailsEl.replaceChildren();
      const thumbnailCount = Math.min(object.state.pageCount, 50);
      const runtime = getPdfPresentationRuntime(object.surfaceId);
      for (let page = 1; page <= thumbnailCount; page += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "presentation-thumbnail";
        button.dataset.page = String(page);
        button.disabled = !canPresentDocuments();
        button.setAttribute("aria-label", `Show page ${page}`);
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 48;
        const label = document.createElement("span");
        label.textContent = String(page);
        button.append(canvas, label);
        button.addEventListener("click", () => void goToPresentationPage(page));
        presentationThumbnailsEl.append(button);
        void runtime.renderThumbnail(page, canvas);
      }
    }
    for (const button of Array.from(presentationThumbnailsEl.querySelectorAll<HTMLButtonElement>(".presentation-thumbnail"))) {
      button.disabled = !canPresentDocuments() || context.presentationActionInFlight;
      if (Number(button.dataset.page) === object.state.currentPage) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }

  function renderPresentationControls(): void {
    const object = currentPdfPresentationObject();
    const active = Boolean(object?.state.status === "active" && object.state.documentId);
    presentationControlsEl.hidden = !active;
    if (!object || !active) {
      presentationThumbnailSignature = "";
      presentationThumbnailsEl.replaceChildren();
      presentationStatusEl.textContent = "Presentation idle";
      debugState.pdfPresentation = {
        surfaceId: context.selectedMediaSurfaceId,
        objectId: null,
        documentId: null,
        page: 1,
        pageCount: 0,
        displayMode: "normal",
        loadState: "idle",
        renderState: "idle",
        lastRenderMs: null,
        renderedThumbnailCount: 0,
        errorCode: null,
        errorDetail: null
      };
      return;
    }
    const canPresent = canPresentDocuments() && !context.presentationActionInFlight;
    presentationPageLabel.textContent = `Page ${object.state.currentPage} / ${object.state.pageCount}`;
    presentationPrevButton.disabled = !canPresent || object.state.currentPage <= 1;
    presentationNextButton.disabled = !canPresent || object.state.currentPage >= object.state.pageCount;
    presentationLargeButton.disabled = !canPresent;
    presentationLargeButton.setAttribute("aria-pressed", String(object.state.displayMode === "large"));
    presentationLargeButton.textContent = object.state.displayMode === "large" ? "Normal mode" : "Large mode";
    presentationStopButton.disabled = !canPresent;
    renderPresentationThumbnails(object);
    const runtimeDebug = getPdfPresentationRuntime(object.surfaceId).createDebugSnapshot();
    debugState.pdfPresentation = runtimeDebug;
    if (runtimeDebug.renderState === "ready") {
      presentationStatusEl.textContent = `Presenting ${object.state.filename ?? "PDF"}, page ${object.state.currentPage} of ${object.state.pageCount}`;
    }
  }

  return {
    presentationInputEventId,
    documentMediaInputEventId,
    renderDocumentMediaControls,
    renderPresentationControls
  };
}
