import * as THREE from "three";
import type { ImageViewerState, MediaObjectInstance } from "@vrata/shared-types";

export function mediaDrawRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number, fitMode: "contain" | "cover") {
  const scale = fitMode === "cover"
    ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
    : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

export function createImageViewerObjectRuntime(options: {
  surfaceId: string;
  widthPx: number;
  heightPx: number;
  loadContent: (documentId: string) => Promise<Blob>;
  applyTexture: (texture: THREE.Texture | null) => void;
  onStatus?: (message: string, errorCode: string | null) => void;
}) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(2560, Math.max(640, options.widthPx));
  canvas.height = Math.min(1440, Math.max(360, options.heightPx));
  const canvasContext = canvas.getContext("2d", { alpha: false });
  if (!canvasContext) throw new Error("image_canvas_context_unavailable");
  const context = canvasContext;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  let generation = 0;
  let signature = "";
  let objectId: string | null = null;
  let documentId: string | null = null;
  let renderState: "idle" | "loading" | "ready" | "failed" = "idle";
  let errorCode: string | null = null;

  async function render(state: ImageViewerState, currentGeneration: number): Promise<void> {
    try {
      renderState = "loading";
      options.onStatus?.("Loading image...", null);
      const bitmap = await createImageBitmap(await options.loadContent(state.documentId!));
      if (generation !== currentGeneration) { bitmap.close(); return; }
      context.fillStyle = "#111827";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const rect = mediaDrawRect(bitmap.width, bitmap.height, canvas.width, canvas.height, state.fitMode);
      context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
      bitmap.close();
      texture.needsUpdate = true;
      options.applyTexture(texture);
      renderState = "ready";
      errorCode = null;
      options.onStatus?.(`Showing ${state.filename ?? "image"}`, null);
    } catch (error) {
      if (generation !== currentGeneration) return;
      renderState = "failed";
      errorCode = error instanceof Error && error.message.includes("content") ? "media_content_failed" : "image_decode_failed";
      options.onStatus?.(`Image failed: ${errorCode}`, errorCode);
    }
  }

  function sync(object: MediaObjectInstance<ImageViewerState>): void {
    objectId = object.objectId;
    documentId = object.state.documentId;
    if (object.state.status !== "active" || !documentId) return;
    const nextSignature = `${documentId}:${object.state.checksum}:${object.state.fitMode}`;
    if (signature === nextSignature) return;
    signature = nextSignature;
    generation += 1;
    void render(object.state, generation);
  }

  function clear(): void {
    generation += 1;
    signature = "";
    objectId = null;
    documentId = null;
    renderState = "idle";
  }

  return {
    texture,
    sync,
    clear,
    close: () => { clear(); texture.dispose(); },
    ownsTexture: (candidate: THREE.Texture | null | undefined) => candidate === texture,
    createDebugSnapshot: () => ({ surfaceId: options.surfaceId, objectId, documentId, renderState, errorCode })
  };
}
