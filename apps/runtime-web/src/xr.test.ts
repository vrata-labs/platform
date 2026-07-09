import test from "node:test";
import assert from "node:assert/strict";

import {
  createXrRendererWiringDebug,
  detectXrSupport,
  getEnterVrVisibility,
  markXrSessionEnded,
  markXrSessionFailed,
  markXrSessionStarted,
  shouldSyncXrTransform,
  recordXrTransformSync
} from "./xr.js";

test("detectXrSupport hides enter vr without navigator.xr", () => {
  const support = detectXrSupport({ navigatorXr: undefined, immersiveVrSupported: false });
  assert.equal(getEnterVrVisibility(support, true), false);
});

test("createXrRendererWiringDebug exposes enabled renderer wiring", () => {
  const debug = createXrRendererWiringDebug({
    featureEnabled: true,
    support: { available: true, canEnterVr: true },
    rendererXrEnabled: true,
    animationLoopConfigured: true,
    presenting: false
  });

  assert.equal(debug.sessionState, "idle");
  assert.equal(debug.enterVrVisible, true);
  assert.equal(debug.rendererXrEnabled, true);
  assert.equal(debug.animationLoop, "xr_compatible");
  assert.equal(debug.cameraRig, "local_pose_controller");
  assert.equal(debug.transformSync, "room_state_presence");
});

test("createXrRendererWiringDebug marks feature-disabled XR as disabled", () => {
  const debug = createXrRendererWiringDebug({
    featureEnabled: false,
    support: { available: true, canEnterVr: true },
    rendererXrEnabled: true,
    animationLoopConfigured: true,
    presenting: false
  });

  assert.equal(debug.sessionState, "disabled");
  assert.equal(debug.enterVrVisible, false);
});

test("xr session transitions preserve enter failure details", () => {
  const initial = createXrRendererWiringDebug({
    featureEnabled: true,
    support: { available: true, canEnterVr: true },
    rendererXrEnabled: true,
    animationLoopConfigured: true,
    presenting: false
  });
  const active = markXrSessionStarted(initial, 1000);
  const ended = markXrSessionEnded(active, 2000);
  const failed = markXrSessionFailed(ended, new DOMException("blocked by browser", "NotAllowedError"), 3000);

  assert.equal(active.sessionState, "active");
  assert.equal(active.sessionStartedAtMs, 1000);
  assert.equal(ended.sessionState, "idle");
  assert.equal(ended.sessionEndedAtMs, 2000);
  assert.equal(failed.sessionState, "failed");
  assert.equal(failed.lastErrorCode, "NotAllowedError");
  assert.equal(failed.lastErrorMessage, "blocked by browser");
});

test("shouldSyncXrTransform throttles active XR transform publishing", () => {
  assert.equal(shouldSyncXrTransform({ presenting: false, nowMs: 100, lastSyncAtMs: 0 }), false);
  assert.equal(shouldSyncXrTransform({ presenting: true, nowMs: 100, lastSyncAtMs: 0 }), true);
  assert.equal(shouldSyncXrTransform({ presenting: true, nowMs: 140, lastSyncAtMs: 100, minIntervalMs: 80 }), false);
  assert.equal(shouldSyncXrTransform({ presenting: true, nowMs: 180, lastSyncAtMs: 100, minIntervalMs: 80 }), true);
  assert.equal(shouldSyncXrTransform({ presenting: true, nowMs: 120, lastSyncAtMs: 100, minIntervalMs: 80, force: true }), true);
});

test("recordXrTransformSync updates XR transform diagnostics", () => {
  const initial = createXrRendererWiringDebug({
    featureEnabled: true,
    support: { available: true, canEnterVr: true },
    rendererXrEnabled: true,
    animationLoopConfigured: true,
    presenting: true
  });
  const next = recordXrTransformSync(initial, 1200);

  assert.equal(next.lastTransformSyncAtMs, 1200);
  assert.equal(next.transformSyncCount, 1);
});
