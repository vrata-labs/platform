import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKDOWN_BOARD_OBJECT_TYPE,
  REMOTE_BROWSER_OBJECT_TYPE,
  WHITEBOARD_OBJECT_TYPE
} from "@vrata/shared-types";
import { allocatePlannedMediaCanvasRuntimes, planMediaCanvasRuntimeAllocations, releaseMediaCanvasRuntime } from "./media-canvas-runtime-plan.js";

const largeSelectedSurface = {
  surfaceId: "large-selected",
  widthPx: 8192,
  heightPx: 4096,
  allowedObjectTypes: [WHITEBOARD_OBJECT_TYPE, MARKDOWN_BOARD_OBJECT_TYPE, REMOTE_BROWSER_OBJECT_TYPE]
};

test("large selected surface without an active object allocates no media canvas runtime", () => {
  const allocations = planMediaCanvasRuntimeAllocations([{
    ...largeSelectedSurface,
    activeObjectType: null
  }]);
  let canvasAllocations = 0;
  allocatePlannedMediaCanvasRuntimes(allocations, {
    whiteboard: () => { canvasAllocations += 1; },
    "markdown-board": () => { canvasAllocations += 1; },
    "remote-browser": () => { canvasAllocations += 1; }
  });

  assert.deepEqual(allocations, []);
  assert.equal(canvasAllocations, 0);
});

test("active canvas media type allocates only its own runtime", () => {
  const cases = [
    [WHITEBOARD_OBJECT_TYPE, "whiteboard"],
    [MARKDOWN_BOARD_OBJECT_TYPE, "markdown-board"],
    [REMOTE_BROWSER_OBJECT_TYPE, "remote-browser"]
  ] as const;
  for (const [activeObjectType, kind] of cases) {
    const allocations = planMediaCanvasRuntimeAllocations([{
      ...largeSelectedSurface,
      activeObjectType
    }]);
    const runtimeAllocations: string[] = [];
    allocatePlannedMediaCanvasRuntimes(allocations, {
      whiteboard: () => { runtimeAllocations.push("whiteboard"); },
      "markdown-board": () => { runtimeAllocations.push("markdown-board"); },
      "remote-browser": () => { runtimeAllocations.push("remote-browser"); }
    });

    assert.deepEqual(allocations, [{
      surfaceId: largeSelectedSurface.surfaceId,
      widthPx: largeSelectedSurface.widthPx,
      heightPx: largeSelectedSurface.heightPx,
      kind
    }]);
    assert.deepEqual(runtimeAllocations, [kind]);
  }
});

test("whiteboard to markdown transition preserves the newly active texture", () => {
  const whiteboardTexture = { id: "whiteboard" };
  const markdownTexture = { id: "markdown" };
  const material: { map: typeof whiteboardTexture | typeof markdownTexture | null } = { map: markdownTexture };
  let disposed = false;

  releaseMediaCanvasRuntime({
    currentTexture: material.map,
    ownsTexture: (texture) => texture === whiteboardTexture,
    clearOwnedTexture: () => { material.map = null; },
    dispose: () => { disposed = true; }
  });

  assert.equal(disposed, true);
  assert.equal(material.map, markdownTexture);
});

test("markdown and remote-browser cleanup preserve a newly rendered whiteboard texture", () => {
  const whiteboardTexture = { id: "whiteboard" };
  const staleTextures = [{ id: "markdown" }, { id: "remote-browser" }];
  for (const staleTexture of staleTextures) {
    const material: { map: typeof whiteboardTexture | typeof staleTexture | null } = { map: whiteboardTexture };
    let clearCount = 0;
    let disposeCount = 0;

    releaseMediaCanvasRuntime({
      currentTexture: material.map,
      ownsTexture: (texture) => texture === staleTexture,
      clearOwnedTexture: () => { clearCount += 1; material.map = null; },
      dispose: () => { disposeCount += 1; }
    });

    assert.equal(clearCount, 0, staleTexture.id);
    assert.equal(disposeCount, 1, staleTexture.id);
    assert.equal(material.map, whiteboardTexture, staleTexture.id);
  }
});
