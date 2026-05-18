import test from "node:test";
import assert from "node:assert/strict";

import { remoteBrowserMediaDrawRegion } from "./remote-browser-object.js";

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
