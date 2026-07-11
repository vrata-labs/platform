import * as THREE from "three";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

import type { MediaObjectInstance, PdfPresentationState } from "@vrata/shared-types";

type PdfLoadState = "idle" | "loading" | "ready" | "failed";
type PdfRenderState = "idle" | "rendering" | "ready" | "failed";

export interface PdfPresentationRuntimeOptions {
  surfaceId: string;
  widthPx: number;
  heightPx: number;
  loadDocumentBytes: (documentId: string) => Promise<ArrayBuffer>;
  applyTexture: (texture: THREE.Texture | null) => void;
  applyDisplayMode: (mode: PdfPresentationState["displayMode"]) => void;
  onStatus?: (message: string, errorCode: string | null) => void;
}

export interface PdfPresentationDebugSnapshot {
  surfaceId: string;
  objectId: string | null;
  documentId: string | null;
  page: number;
  pageCount: number;
  displayMode: PdfPresentationState["displayMode"];
  loadState: PdfLoadState;
  renderState: PdfRenderState;
  lastRenderMs: number | null;
  renderedThumbnailCount: number;
  errorCode: string | null;
  errorDetail: string | null;
}

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfJsPromise) {
    pdfJsPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

export function fitPdfPageToCanvas(pageWidth: number, pageHeight: number, canvasWidth: number, canvasHeight: number): { scale: number; x: number; y: number; width: number; height: number } {
  const scale = Math.min(canvasWidth / pageWidth, canvasHeight / pageHeight);
  const width = Math.max(1, Math.round(pageWidth * scale));
  const height = Math.max(1, Math.round(pageHeight * scale));
  return {
    scale,
    x: Math.round((canvasWidth - width) / 2),
    y: Math.round((canvasHeight - height) / 2),
    width,
    height
  };
}

function presentationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("presentation_not_active")) return "presentation_not_active";
  if (message.includes("password") || message.includes("encrypted")) return "encrypted_pdf_unsupported";
  if (message.includes("InvalidPDF") || message.includes("Invalid PDF")) return "corrupt_pdf";
  if (message.includes("fetch") || message.includes("content")) return "presentation_content_failed";
  return "pdf_render_failed";
}

export function createPdfPresentationObjectRuntime(options: PdfPresentationRuntimeOptions) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(2560, Math.max(640, options.widthPx));
  canvas.height = Math.min(1440, Math.max(360, options.heightPx));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("pdf_canvas_context_unavailable");
  }
  const displayContext = context;
  displayContext.fillStyle = "#111827";
  displayContext.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  let pdf: PDFDocumentProxy | null = null;
  let loadingTask: PDFDocumentLoadingTask | null = null;
  let loadedDocumentId: string | null = null;
  let loadedChecksum: string | null = null;
  let documentLoadPromise: Promise<PDFDocumentProxy> | null = null;
  let documentLoadKey: string | null = null;
  let renderGeneration = 0;
  let lastSignature = "";
  let objectId: string | null = null;
  let loadState: PdfLoadState = "idle";
  let renderState: PdfRenderState = "idle";
  let lastRenderMs: number | null = null;
  let renderedThumbnailCount = 0;
  let errorCode: string | null = null;
  let errorDetail: string | null = null;
  let lastState: PdfPresentationState | null = null;

  async function ensureDocument(state: PdfPresentationState): Promise<PDFDocumentProxy> {
    const loadKey = `${state.documentId}:${state.checksum}`;
    if (pdf && loadedDocumentId === state.documentId && loadedChecksum === state.checksum) {
      return pdf;
    }
    if (documentLoadPromise && documentLoadKey === loadKey) {
      return documentLoadPromise;
    }
    const previousLoadingTask = loadingTask;
    pdf = null;
    loadingTask = null;
    loadedDocumentId = state.documentId;
    loadedChecksum = state.checksum;
    renderedThumbnailCount = 0;
    loadState = "loading";
    options.onStatus?.("Loading presentation PDF...", null);
    documentLoadKey = loadKey;
    documentLoadPromise = (async () => {
      await previousLoadingTask?.destroy();
      const bytes = await options.loadDocumentBytes(state.documentId!);
      const pdfjs = await loadPdfJs();
      const nextLoadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false });
      loadingTask = nextLoadingTask;
      const loadedPdf = await nextLoadingTask.promise;
      if (documentLoadKey !== loadKey) {
        await nextLoadingTask.destroy();
        throw new Error("stale_pdf_load");
      }
      pdf = loadedPdf;
      loadState = "ready";
      return pdf;
    })();
    try {
      return await documentLoadPromise;
    } finally {
      if (documentLoadKey === loadKey) {
        documentLoadPromise = null;
        documentLoadKey = null;
      }
    }
  }

  async function renderStatePage(state: PdfPresentationState, generation: number): Promise<void> {
    const startedAt = performance.now();
    try {
      renderState = "rendering";
      errorCode = null;
      errorDetail = null;
      const documentProxy = await ensureDocument(state);
      if (generation !== renderGeneration) return;
      const page = await documentProxy.getPage(state.currentPage);
      const unitViewport = page.getViewport({ scale: 1 });
      const fit = fitPdfPageToCanvas(unitViewport.width, unitViewport.height, canvas.width, canvas.height);
      const viewport = page.getViewport({ scale: fit.scale });
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = fit.width;
      pageCanvas.height = fit.height;
      const pageContext = pageCanvas.getContext("2d", { alpha: false });
      if (!pageContext) throw new Error("pdf_page_canvas_context_unavailable");
      await page.render({ canvas: pageCanvas, canvasContext: pageContext, viewport }).promise;
      if (generation !== renderGeneration) return;
      displayContext.fillStyle = "#111827";
      displayContext.fillRect(0, 0, canvas.width, canvas.height);
      displayContext.drawImage(pageCanvas, fit.x, fit.y, fit.width, fit.height);
      texture.needsUpdate = true;
      options.applyTexture(texture);
      renderState = "ready";
      lastRenderMs = Number((performance.now() - startedAt).toFixed(1));
      options.onStatus?.(`Presenting page ${state.currentPage} of ${state.pageCount}`, null);
    } catch (error) {
      if (generation !== renderGeneration) return;
      loadState = pdf ? loadState : "failed";
      renderState = "failed";
      errorCode = presentationErrorCode(error);
      errorDetail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      options.onStatus?.(`Presentation failed: ${errorCode}`, errorCode);
    }
  }

  function sync(object: MediaObjectInstance<PdfPresentationState>): void {
    objectId = object.objectId;
    lastState = object.state;
    options.applyDisplayMode(object.state.displayMode);
    if (object.state.status !== "active" || !object.state.documentId || !object.state.checksum || object.state.pageCount < 1) {
      lastSignature = "";
      renderState = "idle";
      return;
    }
    const signature = `${object.state.documentId}:${object.state.checksum}:${object.state.currentPage}:${object.state.displayMode}`;
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;
    renderGeneration += 1;
    void renderStatePage(object.state, renderGeneration);
  }

  async function renderThumbnail(pageNumber: number, targetCanvas: HTMLCanvasElement): Promise<boolean> {
    const state = lastState;
    if (!state?.documentId || pageNumber < 1 || pageNumber > state.pageCount) return false;
    try {
      const documentProxy = await ensureDocument(state);
      const page = await documentProxy.getPage(pageNumber);
      const unitViewport = page.getViewport({ scale: 1 });
      const width = 128;
      const scale = width / unitViewport.width;
      const viewport = page.getViewport({ scale });
      targetCanvas.width = Math.max(1, Math.round(viewport.width));
      targetCanvas.height = Math.max(1, Math.round(viewport.height));
      const targetContext = targetCanvas.getContext("2d", { alpha: false });
      if (!targetContext) return false;
      await page.render({ canvas: targetCanvas, canvasContext: targetContext, viewport }).promise;
      renderedThumbnailCount += 1;
      return true;
    } catch {
      return false;
    }
  }

  function clear(): void {
    renderGeneration += 1;
    lastSignature = "";
    objectId = null;
    lastState = null;
    renderState = "idle";
    options.applyDisplayMode("normal");
  }

  async function close(): Promise<void> {
    clear();
    await loadingTask?.destroy();
    pdf = null;
    loadingTask = null;
    documentLoadPromise = null;
    documentLoadKey = null;
    texture.dispose();
  }

  function createDebugSnapshot(): PdfPresentationDebugSnapshot {
    return {
      surfaceId: options.surfaceId,
      objectId,
      documentId: lastState?.documentId ?? null,
      page: lastState?.currentPage ?? 1,
      pageCount: lastState?.pageCount ?? 0,
      displayMode: lastState?.displayMode ?? "normal",
      loadState,
      renderState,
      lastRenderMs,
      renderedThumbnailCount,
      errorCode,
      errorDetail
    };
  }

  return {
    texture,
    sync,
    clear,
    close,
    renderThumbnail,
    ownsTexture: (candidate: THREE.Texture | null | undefined) => candidate === texture,
    createDebugSnapshot
  };
}
