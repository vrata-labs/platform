import type { createDocumentLibraryRuntime } from "./document-library-runtime.js";
import type { createDocumentSurfaceActions } from "./document-surface-actions.js";
import type { createDocumentSurfaceView } from "./document-surface-view.js";
import type { createMediaObjectQueries } from "./media/media-object-queries.js";

type LibraryActions = Pick<ReturnType<typeof createDocumentLibraryRuntime>,
  "renderDocumentsUi" | "uploadSelectedDocument" | "downloadSelectedDocument" | "deleteSelectedDocument" | "loadRoomDocuments"
>;
type SurfaceActions = Pick<ReturnType<typeof createDocumentSurfaceActions>,
  "selectDocumentForSurface" | "goToPresentationPage" | "togglePresentationDisplayMode" |
  "stopCurrentPresentation" | "toggleDocumentMediaPlayback" | "toggleDocumentMediaFit" |
  "patchCurrentDocumentMedia" | "stopCurrentDocumentMedia"
>;
type DocumentQueries = Pick<ReturnType<typeof createMediaObjectQueries>, "currentPdfPresentationObject">;
type DocumentMediaControls = Pick<ReturnType<typeof createDocumentSurfaceView>,
  "documentMediaInputEventId" | "beginDocumentMediaSeek" | "endDocumentMediaSeek" | "readDocumentMediaSeek" |
  "cancelDocumentMediaSeek" | "resetCancelledDocumentMediaSeek"
>;
type Button = Pick<HTMLButtonElement, "addEventListener">;
const rangeSeekKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

export interface DocumentControlBindingsContext extends LibraryActions, SurfaceActions, DocumentQueries, DocumentMediaControls {
  roomId: string;
  selectedDocumentId: string;
  documentSelect: Pick<HTMLSelectElement, "addEventListener" | "value">;
  documentUploadButton: Button;
  documentDownloadButton: Button;
  documentSurfaceButton: Button;
  documentDeleteButton: Button;
  documentRefreshButton: Button;
  presentationPrevButton: Button;
  presentationNextButton: Button;
  presentationLargeButton: Button;
  presentationStopButton: Button;
  documentMediaPlayButton: Button;
  documentMediaFitButton: Button;
  documentMediaLoopInput: Pick<HTMLInputElement, "addEventListener" | "checked">;
  documentMediaSeekInput: Pick<HTMLInputElement, "addEventListener">;
  documentMediaStopButton: Button;
}

export function bindDocumentControls(context: DocumentControlBindingsContext): void {
  const {
    roomId, documentSelect, documentUploadButton, documentDownloadButton,
    documentSurfaceButton, documentDeleteButton, presentationPrevButton,
    presentationNextButton, presentationLargeButton, presentationStopButton,
    documentMediaPlayButton, documentMediaFitButton, documentMediaLoopInput,
    documentMediaSeekInput, documentMediaStopButton, renderDocumentsUi,
    uploadSelectedDocument, downloadSelectedDocument, selectDocumentForSurface,
    deleteSelectedDocument, documentRefreshButton, loadRoomDocuments, currentPdfPresentationObject, goToPresentationPage,
    togglePresentationDisplayMode, stopCurrentPresentation,
    toggleDocumentMediaPlayback, toggleDocumentMediaFit,
    patchCurrentDocumentMedia, documentMediaInputEventId, stopCurrentDocumentMedia,
    beginDocumentMediaSeek, endDocumentMediaSeek, cancelDocumentMediaSeek, resetCancelledDocumentMediaSeek, readDocumentMediaSeek
  } = context;

  documentSelect.addEventListener("change", () => {
    context.selectedDocumentId = documentSelect.value;
    if (context.selectedDocumentId) {
      localStorage.setItem(`vrata.documents.selected.${roomId}`, context.selectedDocumentId);
    } else {
      localStorage.removeItem(`vrata.documents.selected.${roomId}`);
    }
    renderDocumentsUi();
  });

  documentUploadButton.addEventListener("click", () => {
    void uploadSelectedDocument();
  });

  documentDownloadButton.addEventListener("click", () => {
    void downloadSelectedDocument();
  });

  documentSurfaceButton.addEventListener("click", () => {
    void selectDocumentForSurface();
  });

  documentDeleteButton.addEventListener("click", () => {
    void deleteSelectedDocument();
  });
  documentRefreshButton.addEventListener("click", () => { void loadRoomDocuments(); });

  presentationPrevButton.addEventListener("click", () => {
    const object = currentPdfPresentationObject();
    if (object) void goToPresentationPage(object.state.currentPage - 1);
  });

  presentationNextButton.addEventListener("click", () => {
    const object = currentPdfPresentationObject();
    if (object) void goToPresentationPage(object.state.currentPage + 1);
  });

  presentationLargeButton.addEventListener("click", () => {
    void togglePresentationDisplayMode();
  });

  presentationStopButton.addEventListener("click", () => {
    void stopCurrentPresentation();
  });

  documentMediaPlayButton.addEventListener("click", () => {
    void toggleDocumentMediaPlayback();
  });

  documentMediaFitButton.addEventListener("click", () => {
    void toggleDocumentMediaFit();
  });

  documentMediaLoopInput.addEventListener("change", () => {
    void patchCurrentDocumentMedia({ type: "set-loop", loop: documentMediaLoopInput.checked, inputEventId: documentMediaInputEventId("loop") });
  });

  documentMediaSeekInput.addEventListener("pointerdown", (event) => {
    // A touch on the range can be non-primary if another finger is down elsewhere.
    if (event.button === 0) beginDocumentMediaSeek(event.pointerId);
  });
  // Disabling or hiding the range can redirect release before it captures the pointer.
  window.addEventListener("pointerup", (event) => endDocumentMediaSeek(event.pointerId, commitDocumentMediaSeek), true);
  window.addEventListener("pointercancel", (event) => endDocumentMediaSeek(event.pointerId), true);
  window.addEventListener("blur", cancelDocumentMediaSeek);
  documentMediaSeekInput.addEventListener("lostpointercapture", (event) => endDocumentMediaSeek(event.pointerId));
  documentMediaSeekInput.addEventListener("keydown", (event) => {
    // The window may have lost both focus and the pointer's release event.
    if (rangeSeekKeys.has(event.key)) resetCancelledDocumentMediaSeek();
  });
  documentMediaSeekInput.addEventListener("change", commitDocumentMediaSeek);

  function commitDocumentMediaSeek(): void {
    const positionMs = readDocumentMediaSeek();
    if (positionMs !== null) {
      void patchCurrentDocumentMedia({ type: "seek", positionMs, inputEventId: documentMediaInputEventId("seek") });
    }
  }

  documentMediaStopButton.addEventListener("click", () => {
    void stopCurrentDocumentMedia();
  });
}
