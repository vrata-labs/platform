import type { TestContext } from "node:test";
import type { MediaObjectInstance, PdfPresentationState, ImageViewerState, VideoPlayerState } from "@vrata/shared-types";
import { createDocumentSurfaceView, type DocumentSurfaceViewContext } from "../document-surface-view.js";
import type { PdfPresentationDebugSnapshot } from "../media/pdf-presentation-object.js";
import { DocumentTestElement, installDocumentTestDom } from "./document-ui-dom.js";

export function createDocumentSurfaceViewHarness(t: TestContext) {
  const dom = installDocumentTestDom(t);
  const state = {
    pdf: null as MediaObjectInstance<PdfPresentationState> | null,
    image: null as MediaObjectInstance<ImageViewerState> | null,
    video: null as MediaObjectInstance<VideoPlayerState> | null,
    canPresent: true,
    snapshot: {
      surfaceId: "object-surface", objectId: "pdf-object", documentId: "previous",
      page: 2, pageCount: 4, displayMode: "normal", loadState: "ready", renderState: "ready",
      lastRenderMs: 12, renderedThumbnailCount: 4, errorCode: null, errorDetail: null
    } as PdfPresentationDebugSnapshot
  };
  const events: Array<{ name: string; args: unknown[] }> = [];
  const log = (name: string, ...args: unknown[]) => { events.push({ name, args }); };
  const runtime = {
    async renderThumbnail(page: number, canvas: HTMLCanvasElement) { log("thumbnail", page, canvas); return true; },
    createDebugSnapshot() { log("snapshot"); return state.snapshot; }
  };
  const context = {
    participantId: "participant", roomStateServerOffsetMs: 0, selectedMediaSurfaceId: "surface",
    presentationActionInFlight: false as boolean,
    currentPdfPresentationObject() { log("pdf"); return state.pdf; },
    currentImageViewerObject() { log("image"); return state.image; },
    currentVideoPlayerObject() { log("video"); return state.video; },
    canPresentDocuments() { return state.canPresent; },
    async goToPresentationPage(page: number) { log("page", page); },
    getPdfPresentationRuntime(surfaceId: string) { log("runtime", surfaceId); return runtime; },
    debugState: { pdfPresentation: { ...state.snapshot } },
    presentationControlsEl: new DocumentTestElement(), presentationPrevButton: new DocumentTestElement(),
    presentationNextButton: new DocumentTestElement(), presentationPageLabel: new DocumentTestElement(),
    presentationLargeButton: new DocumentTestElement(), presentationStopButton: new DocumentTestElement(),
    presentationThumbnailsEl: new DocumentTestElement(), presentationStatusEl: new DocumentTestElement(),
    documentMediaControlsEl: new DocumentTestElement(), documentMediaTitleEl: new DocumentTestElement(),
    documentMediaPlayButton: new DocumentTestElement(), documentMediaFitButton: new DocumentTestElement(),
    documentMediaLoopLabel: new DocumentTestElement(), documentMediaLoopInput: new DocumentTestElement(),
    documentMediaStopButton: new DocumentTestElement(), documentMediaSeekInput: new DocumentTestElement(),
    documentMediaTimeEl: new DocumentTestElement(), documentMediaStatusEl: new DocumentTestElement()
  } satisfies DocumentSurfaceViewContext;
  const view = createDocumentSurfaceView(context);
  return { dom, context, state, events, view,
    calls: (name: string) => events.filter((event) => event.name === name).map((event) => event.args) };
}
