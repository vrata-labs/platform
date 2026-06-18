import test from "node:test";
import assert from "node:assert/strict";

import {
  createRemoteBrowserObjectRuntime,
  remoteBrowserMediaDrawRegion,
  shouldCompositeRemoteBrowserMediaFrame
} from "./remote-browser-object.js";
import {
  REMOTE_BROWSER_OBJECT_TYPE,
  type MediaObjectInstance,
  type RemoteBrowserObjectState
} from "@vrata/shared-types";

function installFakeCanvasDocument(): () => void {
  const previousDocument = globalThis.document;
  const context = {
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    drawImage: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4) })
  } as unknown as CanvasRenderingContext2D;
  const fakeDocument = {
    createElement: (tagName: string) => {
      if (tagName === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => context
        };
      }
      return {};
    },
    body: { appendChild: () => undefined }
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

function createRuntimeObject(state: Partial<RemoteBrowserObjectState> = {}): MediaObjectInstance<RemoteBrowserObjectState> {
  return {
    objectId: "remote-browser-1",
    type: REMOTE_BROWSER_OBJECT_TYPE,
    roomId: "room-1",
    surfaceId: "debug-main",
    ownerParticipantId: "host-1",
    state: {
      status: "idle",
      ownerParticipantId: "host-1",
      surfaceId: "debug-main",
      lastInputEventId: null,
      ...state
    },
    status: "active",
    revision: 1,
    createdAtMs: 0,
    updatedAtMs: 0
  };
}

function createTestRuntime(appliedTextures: unknown[]) {
  return createRemoteBrowserObjectRuntime({
    apiBaseUrl: "http://localhost:4000",
    roomId: "room-1",
    participantId: "host-1",
    surfaceId: "debug-main",
    widthPx: 1920,
    heightPx: 1080,
    getPermissions: () => [],
    getLatestObject: () => null,
    patchObject: async () => ({ accepted: true, permission: "remote-browser.input", role: "host" }),
    applyTexture: (texture) => { appliedTextures.push(texture); },
    onBlocked: () => undefined
  });
}

test("remote browser runtime does not publish its texture while idle", () => {
  const restoreDocument = installFakeCanvasDocument();
  try {
    const appliedTextures: unknown[] = [];
    const runtime = createTestRuntime(appliedTextures);

    runtime.sync(null);
    runtime.close();

    assert.equal(appliedTextures.length, 0);
  } finally {
    restoreDocument();
  }
});

test("remote browser runtime publishes its texture when a browser object is active", () => {
  const restoreDocument = installFakeCanvasDocument();
  try {
    const appliedTextures: unknown[] = [];
    const runtime = createTestRuntime(appliedTextures);

    runtime.sync(createRuntimeObject());

    assert(appliedTextures.includes(runtime.texture));
  } finally {
    restoreDocument();
  }
});

test("remoteBrowserMediaDrawRegion maps page video bounds to canvas bounds", () => {
  const region = remoteBrowserMediaDrawRegion({
    sourceRect: { x: 44, y: 308, width: 832, height: 468, viewportWidth: 1280, viewportHeight: 720 },
    canvasWidth: 1280,
    canvasHeight: 720,
    mediaWidth: 1920,
    mediaHeight: 1080
  });
  assert(region);
  assert.deepEqual({ ...region, sh: Math.round(region.sh * 1000) / 1000 }, {
    sx: 0,
    sy: 0,
    sw: 1920,
    sh: 950.769,
    dx: 44,
    dy: 308,
    dw: 832,
    dh: 412
  });
});

test("remoteBrowserMediaDrawRegion scales bounds across canvas sizes", () => {
  assert.deepEqual(remoteBrowserMediaDrawRegion({
    sourceRect: { x: 320, y: 180, width: 640, height: 360, viewportWidth: 1280, viewportHeight: 720 },
    canvasWidth: 640,
    canvasHeight: 360,
    mediaWidth: 1280,
    mediaHeight: 720
  }), {
    sx: 0,
    sy: 0,
    sw: 1280,
    sh: 720,
    dx: 160,
    dy: 90,
    dw: 320,
    dh: 180
  });
});

test("remoteBrowserMediaDrawRegion ignores invalid or offscreen bounds", () => {
  assert.equal(remoteBrowserMediaDrawRegion({
    sourceRect: { x: 0, y: 0, width: 0, height: 360, viewportWidth: 1280, viewportHeight: 720 },
    canvasWidth: 1280,
    canvasHeight: 720,
    mediaWidth: 1280,
    mediaHeight: 720
  }), null);
  assert.equal(remoteBrowserMediaDrawRegion({
    sourceRect: { x: 1400, y: 0, width: 100, height: 100, viewportWidth: 1280, viewportHeight: 720 },
    canvasWidth: 1280,
    canvasHeight: 720,
    mediaWidth: 1280,
    mediaHeight: 720
  }), null);
});

test("remote browser media composite pauses while screenshot overlays are preserved", () => {
  assert.equal(shouldCompositeRemoteBrowserMediaFrame({
    mediaVisualActive: false,
    mediaCompositeHoldUntilMs: 0,
    nowMs: 1000
  }), false);
  assert.equal(shouldCompositeRemoteBrowserMediaFrame({
    mediaVisualActive: true,
    mediaCompositeHoldUntilMs: 1500,
    nowMs: 1000
  }), false);
  assert.equal(shouldCompositeRemoteBrowserMediaFrame({
    mediaVisualActive: true,
    mediaCompositeHoldUntilMs: 1500,
    nowMs: 1500
  }), true);
});
