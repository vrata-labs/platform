import * as THREE from "three";
import type { RuntimeMediaSurfaceView } from "./media-surface-view.js";

export type SurfaceTextureSample = { clip: { sx: number; sy: number; sw: number; sh: number }; samples: Array<[number, number, number]> };

export function sampleTextureImage(image: unknown, center: { u: number; v: number }, size: { width: number; height: number }): SurfaceTextureSample | null {
  if (!(image instanceof HTMLCanvasElement) && !(image instanceof HTMLVideoElement) && !(image instanceof HTMLImageElement) && !(typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap)) {
    return null;
  }
  const imageWidth = image instanceof HTMLVideoElement
    ? image.videoWidth
    : image instanceof HTMLImageElement
      ? image.naturalWidth || image.width
      : image.width;
  const imageHeight = image instanceof HTMLVideoElement
    ? image.videoHeight
    : image instanceof HTMLImageElement
      ? image.naturalHeight || image.height
      : image.height;
  if (imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }

  const scratch = document.createElement("canvas");
  scratch.width = imageWidth;
  scratch.height = imageHeight;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  try {
    context.drawImage(image, 0, 0, imageWidth, imageHeight);
  } catch {
    return null;
  }

  const clampedU = Math.max(0, Math.min(1, center.u));
  const clampedV = Math.max(0, Math.min(1, center.v));
  const sw = Math.max(1, Math.floor(imageWidth * Math.max(0.001, Math.min(1, size.width))));
  const sh = Math.max(1, Math.floor(imageHeight * Math.max(0.001, Math.min(1, size.height))));
  const sx = Math.max(0, Math.min(imageWidth - sw, Math.floor(clampedU * imageWidth - sw / 2)));
  const sy = Math.max(0, Math.min(imageHeight - sh, Math.floor((1 - clampedV) * imageHeight - sh / 2)));
  const data = context.getImageData(sx, sy, sw, sh).data;
  const samples: Array<[number, number, number]> = [];
  for (let sampleIndex = 0; sampleIndex < 128; sampleIndex += 1) {
    const x = Math.min(sw - 1, Math.floor(((sampleIndex % 16) + 0.5) * sw / 16));
    const y = Math.min(sh - 1, Math.floor((Math.floor(sampleIndex / 16) + 0.5) * sh / 8));
    const pixelIndex = (y * sw + x) * 4;
    samples.push([data[pixelIndex] ?? 0, data[pixelIndex + 1] ?? 0, data[pixelIndex + 2] ?? 0]);
  }
  return { clip: { sx, sy, sw, sh }, samples };
}

export function createMediaSurfaceTextureController({
  mediaSurfaceViews,
  retainedDisplayTextures
}: {
  mediaSurfaceViews: ReadonlyMap<string, RuntimeMediaSurfaceView>;
  retainedDisplayTextures: ReadonlySet<THREE.Texture>;
}) {
  const debugTextureIds = new WeakMap<THREE.Texture, number>();
  let nextDebugTextureId = 1;

  function applySurfaceTexture(surfaceId: string, texture: THREE.Texture | null): void {
    const material = mediaSurfaceViews.get(surfaceId)?.object.material;
    if (!(material instanceof THREE.MeshBasicMaterial)) {
      return;
    }
    if (material.map === texture) {
      if (texture && material.color.getHex() !== 0xffffff) {
        material.color.setHex(0xffffff);
      }
      return;
    }
    if (material.map && material.map !== texture && !retainedDisplayTextures.has(material.map)) {
      material.map.dispose();
    }
    material.color.setHex(0xffffff);
    material.map = texture;
    material.needsUpdate = true;
  }

  function getSurfaceTextureDebugId(surfaceId: string): number | null {
    const material = mediaSurfaceViews.get(surfaceId)?.object.material;
    const texture = material instanceof THREE.MeshBasicMaterial ? material.map : null;
    if (!texture) {
      return null;
    }
    const existing = debugTextureIds.get(texture);
    if (existing) {
      return existing;
    }
    const next = nextDebugTextureId;
    nextDebugTextureId += 1;
    debugTextureIds.set(texture, next);
    return next;
  }

  function findSurfaceWithTexture(predicate: (texture: THREE.Texture | null) => boolean): RuntimeMediaSurfaceView | null {
    for (const surface of mediaSurfaceViews.values()) {
      const material = surface.object.material;
      if (material instanceof THREE.MeshBasicMaterial && predicate(material.map)) {
        return surface;
      }
    }
    return null;
  }

  function clearSurfaceTextureWhere(predicate: (texture: THREE.Texture | null) => boolean): void {
    for (const surface of mediaSurfaceViews.values()) {
      const material = surface.object.material;
      if (material instanceof THREE.MeshBasicMaterial && predicate(material.map)) {
        applySurfaceTexture(surface.surfaceId, null);
      }
    }
  }

  function sampleMediaSurfaceTexture(surfaceId: string, center: { u: number; v: number }, size: { width: number; height: number }): SurfaceTextureSample | null {
    const material = mediaSurfaceViews.get(surfaceId)?.object.material;
    const image = material instanceof THREE.MeshBasicMaterial ? material.map?.image : null;
    return sampleTextureImage(image, center, size);
  }

  return {
    applySurfaceTexture,
    getSurfaceTextureDebugId,
    findSurfaceWithTexture,
    clearSurfaceTextureWhere,
    sampleMediaSurfaceTexture
  };
}
