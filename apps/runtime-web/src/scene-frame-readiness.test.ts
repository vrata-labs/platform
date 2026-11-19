import assert from "node:assert/strict";
import { test } from "node:test";
import { createSceneFrameReadiness } from "./scene-frame-readiness.js";

test("fallback frames neither block readiness nor satisfy a later bundle's first frame", () => {
  const sceneFrame = createSceneFrameReadiness();
  assert.equal(sceneFrame.ready, true);
  assert.equal(sceneFrame.frameRendered(false), false);
  assert.equal(sceneFrame.firstFrameAtMs, null);

  sceneFrame.sceneAttached();
  assert.equal(sceneFrame.ready, false);
  assert.equal(sceneFrame.firstFrameAtMs, null);
});

test("the first completed bundle frame opens the gate once, but a lost context does not", () => {
  let now = 100;
  const sceneFrame = createSceneFrameReadiness(() => now);
  sceneFrame.sceneAttached();
  assert.equal(sceneFrame.frameRendered(true), false);
  assert.equal(sceneFrame.ready, false);

  now = 4200;
  assert.equal(sceneFrame.frameRendered(false), true);
  assert.equal(sceneFrame.ready, true);
  assert.equal(sceneFrame.firstFrameAtMs, 4200);
  now = 4300;
  assert.equal(sceneFrame.frameRendered(false), false);
  assert.equal(sceneFrame.firstFrameAtMs, 4200);
});
