import assert from "node:assert/strict";
import test from "node:test";

import { planRemoteBrowserXrPointer } from "./remote-browser-xr-input.js";

test("remote browser XR trigger starts a pointer press on surface hit", () => {
  assert.deepEqual(planRemoteBrowserXrPointer({
    browserActive: true,
    pointerActive: false,
    triggerPressed: true,
    confirmInteraction: true,
    hasHit: true,
    hasLastHit: false
  }), {
    kind: "pointer-down",
    nextPointerActive: true,
    useLastHit: false
  });
});

test("remote browser XR trigger hold moves and release sends pointer up", () => {
  assert.deepEqual(planRemoteBrowserXrPointer({
    browserActive: true,
    pointerActive: true,
    triggerPressed: true,
    confirmInteraction: false,
    hasHit: true,
    hasLastHit: true
  }), {
    kind: "pointer-move",
    nextPointerActive: true,
    useLastHit: false
  });

  assert.deepEqual(planRemoteBrowserXrPointer({
    browserActive: true,
    pointerActive: true,
    triggerPressed: false,
    confirmInteraction: false,
    hasHit: true,
    hasLastHit: true
  }), {
    kind: "pointer-up",
    nextPointerActive: false,
    useLastHit: false
  });
});

test("remote browser XR release falls back to last hit when ray leaves surface", () => {
  assert.deepEqual(planRemoteBrowserXrPointer({
    browserActive: true,
    pointerActive: true,
    triggerPressed: false,
    confirmInteraction: false,
    hasHit: false,
    hasLastHit: true
  }), {
    kind: "pointer-up",
    nextPointerActive: false,
    useLastHit: true
  });
});

test("remote browser XR clears a held pointer when browser deactivates", () => {
  assert.deepEqual(planRemoteBrowserXrPointer({
    browserActive: false,
    pointerActive: true,
    triggerPressed: true,
    confirmInteraction: false,
    hasHit: false,
    hasLastHit: true
  }), {
    kind: "pointer-up",
    nextPointerActive: false,
    useLastHit: true
  });
});
