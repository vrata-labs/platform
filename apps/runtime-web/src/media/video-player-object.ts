import * as THREE from "three";
import type { MediaObjectInstance, VideoPlayerState } from "@vrata/shared-types";
import { mediaDrawRect } from "./image-viewer-object.js";
import { planVideoPlaybackCorrection, resolveVideoTargetSeconds } from "./video-playback-clock.js";

export function createVideoPlayerObjectRuntime(options: {
  surfaceId: string;
  widthPx: number;
  heightPx: number;
  loadContent: (documentId: string) => Promise<Blob>;
  getAudioEnabled: () => boolean;
  applyTexture: (texture: THREE.Texture | null) => void;
  onStatus?: (message: string, errorCode: string | null) => void;
}) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(1280, Math.max(640, options.widthPx));
  canvas.height = Math.min(720, Math.max(360, options.heightPx));
  const canvasContext = canvas.getContext("2d", { alpha: false });
  if (!canvasContext) throw new Error("video_canvas_context_unavailable");
  const context = canvasContext;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const video = document.createElement("video");
  video.preload = "auto";
  video.playsInline = true;
  video.muted = true;
  let objectUrl: string | null = null;
  let loadedDocumentId: string | null = null;
  let loadPromise: Promise<void> | null = null;
  let state: VideoPlayerState | null = null;
  let objectId: string | null = null;
  let generation = 0;
  let lastDrawTime = -1;
  let driftMs = 0;
  let correctionMode: "none" | "rate" | "seek" = "none";
  let errorCode: string | null = null;
  let statusSignature = "";

  async function ensureLoaded(nextState: VideoPlayerState): Promise<void> {
    if (loadedDocumentId === nextState.documentId && video.readyState >= 1) return;
    if (loadedDocumentId === nextState.documentId && loadPromise) return loadPromise;
    generation += 1;
    const currentGeneration = generation;
    loadedDocumentId = nextState.documentId;
    loadPromise = (async () => {
      const blob = await options.loadContent(nextState.documentId!);
      if (generation !== currentGeneration) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      video.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { video.onloadedmetadata = null; video.onerror = null; if (error) reject(error); else resolve(); };
        video.onloadedmetadata = () => finish();
        video.onerror = () => finish(new Error("video_decode_failed"));
      });
      options.applyTexture(texture);
    })();
    try { await loadPromise; } finally { if (generation === currentGeneration) loadPromise = null; }
  }

  function sync(object: MediaObjectInstance<VideoPlayerState>): void {
    objectId = object.objectId;
    state = object.state;
    if (state.status !== "active" || !state.documentId) return;
    void ensureLoaded(state).catch((error) => {
      errorCode = error instanceof Error ? error.message : "video_load_failed";
      options.onStatus?.(`Video failed: ${errorCode}`, errorCode);
    });
  }

  function update(serverNowMs: number): void {
    if (!state || state.status !== "active" || video.readyState < 2) return;
    const target = resolveVideoTargetSeconds(state, serverNowMs);
    const correction = planVideoPlaybackCorrection(video.currentTime, target, state.playbackState === "paused");
    driftMs = correction.driftMs;
    correctionMode = correction.mode;
    video.loop = state.loop;
    video.muted = !options.getAudioEnabled();
    if (correction.seekToSeconds !== null && Math.abs(video.currentTime - correction.seekToSeconds) > 0.01) video.currentTime = correction.seekToSeconds;
    video.playbackRate = correction.playbackRate;
    const atEnd = !state.loop && target >= state.durationMs / 1000 - 0.02;
    if (state.playbackState === "playing" && !atEnd) {
      if (video.paused) void video.play().catch(() => { errorCode = "autoplay_blocked"; });
    } else if (!video.paused) {
      video.pause();
    }
    if (video.currentTime !== lastDrawTime && video.videoWidth > 0) {
      lastDrawTime = video.currentTime;
      context.fillStyle = "#111827";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const rect = mediaDrawRect(video.videoWidth, video.videoHeight, canvas.width, canvas.height, state.fitMode);
      context.drawImage(video, rect.x, rect.y, rect.width, rect.height);
      texture.needsUpdate = true;
    }
    const nextStatusSignature = `${state.playbackState}:${state.filename}:${errorCode}`;
    if (nextStatusSignature !== statusSignature) {
      statusSignature = nextStatusSignature;
      options.onStatus?.(`${state.playbackState === "playing" ? "Playing" : "Paused"} ${state.filename ?? "video"}`, errorCode);
    }
  }

  function clear(): void {
    generation += 1;
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    loadedDocumentId = null;
    state = null;
    objectId = null;
    statusSignature = "";
  }

  return {
    texture,
    video,
    sync,
    update,
    clear,
    close: () => { clear(); texture.dispose(); },
    ownsTexture: (candidate: THREE.Texture | null | undefined) => candidate === texture,
    createDebugSnapshot: () => ({ surfaceId: options.surfaceId, objectId, documentId: state?.documentId ?? null, playbackState: state?.playbackState ?? "paused", actualPositionMs: Math.round(video.currentTime * 1000), driftMs: Math.round(driftMs), correctionMode, muted: video.muted, errorCode })
  };
}
