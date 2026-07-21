export interface DocumentMediaProbe {
  kind: "image" | "video";
  widthPx: number;
  heightPx: number;
  durationMs?: number;
}

const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const videoTypes = new Set(["video/mp4", "video/webm"]);

function waitForMediaEvent(target: HTMLElement, successEvent: string, failureEvent: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      target.removeEventListener(successEvent, onSuccess);
      target.removeEventListener(failureEvent, onFailure);
      if (error) reject(error); else resolve();
    };
    const onSuccess = () => finish();
    const onFailure = () => finish(new Error("media_decode_failed"));
    const timeout = window.setTimeout(() => finish(new Error("media_probe_timeout")), timeoutMs);
    target.addEventListener(successEvent, onSuccess, { once: true });
    target.addEventListener(failureEvent, onFailure, { once: true });
  });
}

export async function probeDocumentMedia(file: File): Promise<DocumentMediaProbe | null> {
  if (!imageTypes.has(file.type) && !videoTypes.has(file.type)) return null;
  const url = URL.createObjectURL(file);
  try {
    if (imageTypes.has(file.type)) {
      const image = new Image();
      image.src = url;
      await waitForMediaEvent(image, "load", "error");
      return { kind: "image", widthPx: image.naturalWidth, heightPx: image.naturalHeight };
    }
    const video = document.createElement("video");
    if (!video.canPlayType(file.type)) throw new Error("unsupported_video_codec");
    video.preload = "metadata";
    video.src = url;
    await waitForMediaEvent(video, "loadedmetadata", "error");
    if (!Number.isFinite(video.duration) && file.type === "video/webm") {
      video.currentTime = Number.MAX_SAFE_INTEGER;
      await waitForMediaEvent(video, "durationchange", "error");
      video.currentTime = 0;
    }
    const durationMs = Math.round(video.duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs < 1) throw new Error("video_duration_invalid");
    return { kind: "video", widthPx: video.videoWidth, heightPx: video.videoHeight, durationMs };
  } finally {
    URL.revokeObjectURL(url);
  }
}
