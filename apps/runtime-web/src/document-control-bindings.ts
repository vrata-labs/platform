import type { createDocumentLibraryRuntime } from "./document-library-runtime.js";
import type { createDocumentSurfaceActions } from "./document-surface-actions.js";
import type { createDocumentSurfaceView } from "./document-surface-view.js";
import type { createMediaObjectQueries } from "./media/media-object-queries.js";

type LibraryActions = Pick<ReturnType<typeof createDocumentLibraryRuntime>,
  "renderDocumentsUi" | "uploadSelectedDocument" | "downloadSelectedDocument" | "deleteSelectedDocument"
>;
type SurfaceActions = Pick<ReturnType<typeof createDocumentSurfaceActions>,
  "selectDocumentForSurface" | "goToPresentationPage" | "togglePresentationDisplayMode" |
  "stopCurrentPresentation" | "toggleDocumentMediaPlayback" | "toggleDocumentMediaFit" |
  "patchCurrentDocumentMedia" | "stopCurrentDocumentMedia"
>;
type DocumentQueries = Pick<ReturnType<typeof createMediaObjectQueries>, "currentPdfPresentationObject">;
type DocumentIds = Pick<ReturnType<typeof createDocumentSurfaceView>, "documentMediaInputEventId">;
type Button = Pick<HTMLButtonElement, "addEventListener">;

export interface DocumentControlBindingsContext extends LibraryActions, SurfaceActions, DocumentQueries, DocumentIds {
  roomId: string;
  selectedDocumentId: string;
  documentSelect: Pick<HTMLSelectElement, "addEventListener" | "value">;
  documentUploadButton: Button;
  documentDownloadButton: Button;
  documentSurfaceButton: Button;
  documentDeleteButton: Button;
  presentationPrevButton: Button;
  presentationNextButton: Button;
  presentationLargeButton: Button;
  presentationStopButton: Button;
  documentMediaPlayButton: Button;
  documentMediaFitButton: Button;
  documentMediaLoopInput: Pick<HTMLInputElement, "addEventListener" | "checked">;
  documentMediaSeekInput: Pick<HTMLInputElement, "addEventListener" | "value">;
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
    deleteSelectedDocument, currentPdfPresentationObject, goToPresentationPage,
    togglePresentationDisplayMode, stopCurrentPresentation,
    toggleDocumentMediaPlayback, toggleDocumentMediaFit,
    patchCurrentDocumentMedia, documentMediaInputEventId, stopCurrentDocumentMedia
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

  documentMediaSeekInput.addEventListener("change", () => {
    void patchCurrentDocumentMedia({ type: "seek", positionMs: Number(documentMediaSeekInput.value), inputEventId: documentMediaInputEventId("seek") });
  });

  documentMediaStopButton.addEventListener("click", () => {
    void stopCurrentDocumentMedia();
  });
}
