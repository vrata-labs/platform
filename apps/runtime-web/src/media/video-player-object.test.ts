import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_PLAYER_OBJECT_TYPE,
  type MediaObjectInstance,
  type VideoPlayerState
} from "@vrata/shared-types";
import { createVideoPlayerObjectRuntime } from "./video-player-object.js";

function installFakeVideoDocument(): () => void {
  const previousDocument = globalThis.document;
  const context = {
    drawImage: () => undefined,
    fillRect: () => undefined
  } as unknown as CanvasRenderingContext2D;
  const video = {
    currentTime: 0,
    load: () => undefined,
    loop: false,
    muted: true,
    onerror: null,
    onloadedmetadata: null,
    pause: () => undefined,
    paused: true,
    playbackRate: 1,
    play: async () => undefined,
    readyState: 0,
    removeAttribute: () => undefined,
    videoHeight: 0,
    videoWidth: 0
  } as unknown as HTMLVideoElement;
  const fakeDocument = {
    createElement: (tagName: string) => tagName === "canvas"
      ? { width: 0, height: 0, getContext: () => context }
      : video
  } as unknown as Document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  return () => {
    if (previousDocument) {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  };
}

function createVideoObject(): MediaObjectInstance<VideoPlayerState> {
  return {
    objectId: "video-1",
    type: VIDEO_PLAYER_OBJECT_TYPE,
    roomId: "room-1",
    surfaceId: "debug-main",
    ownerParticipantId: "host-1",
    state: {
      status: "active",
      documentId: "document-1",
      filename: "clip.mp4",
      checksum: `sha256:${"a".repeat(64)}`,
      contentType: "video/mp4",
      widthPx: 640,
      heightPx: 360,
      durationMs: 5000,
      playbackState: "paused",
      positionMs: 0,
      anchorServerTimeMs: null,
      loop: false,
      fitMode: "contain",
      lastInputEventId: null
    },
    status: "active",
    revision: 1,
    createdAtMs: 0,
    updatedAtMs: 0
  };
}

test("video runtime ignores late metadata after close disposes the pending generation", async () => {
  const restoreDocument = installFakeVideoDocument();
  try {
    const appliedTextures: unknown[] = [];
    const runtime = createVideoPlayerObjectRuntime({
      surfaceId: "debug-main",
      widthPx: 1920,
      heightPx: 1080,
      loadContent: async () => new Blob(["video"], { type: "video/mp4" }),
      getAudioEnabled: () => false,
      applyTexture: (texture) => { appliedTextures.push(texture); }
    });
    let disposed = false;
    runtime.texture.addEventListener("dispose", () => { disposed = true; });

    runtime.sync(createVideoObject());
    for (let attempt = 0; attempt < 5 && !runtime.video.onloadedmetadata; attempt += 1) {
      await Promise.resolve();
    }
    const staleMetadataHandler = runtime.video.onloadedmetadata;
    assert.equal(typeof staleMetadataHandler, "function");

    runtime.close();
    staleMetadataHandler?.call(runtime.video, new Event("loadedmetadata"));
    await Promise.resolve();

    assert.equal(disposed, true);
    assert.deepEqual(appliedTextures, []);
  } finally {
    restoreDocument();
  }
});
