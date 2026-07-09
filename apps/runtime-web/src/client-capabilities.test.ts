import test from "node:test";
import assert from "node:assert/strict";

import { detectBrowserMediaCapabilities } from "./media-capabilities.js";
import { formatClientCompatibilityStatus, resolveClientCompatibility } from "./client-capabilities.js";

const fullMedia = detectBrowserMediaCapabilities({
  isSecureContext: true,
  mediaDevices: {
    enumerateDevices() {},
    getDisplayMedia() {},
    getUserMedia() {}
  },
  rtcPeerConnection() {}
});

test("resolveClientCompatibility accepts desktop with full browser support", () => {
  const summary = resolveClientCompatibility({
    resolvedJoinMode: "desktop",
    media: fullMedia,
    xr: { available: true, canEnterVr: true },
    enterVrFeatureEnabled: true,
    webGlAvailable: true,
    webSocketAvailable: true,
    touchInputAvailable: false
  });

  assert.equal(summary.resolvedJoinMode, "desktop");
  assert.equal(summary.entryBlocked, false);
  assert.equal(summary.degradedMode, "none");
  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.xr.enterVrVisible, true);
  assert.equal(formatClientCompatibilityStatus(summary), "Compatibility: desktop mode ready");
});

test("resolveClientCompatibility keeps mobile entry available without optional media APIs", () => {
  const limitedMedia = detectBrowserMediaCapabilities({
    isSecureContext: true,
    mediaDevices: {
      enumerateDevices() {}
    },
    rtcPeerConnection() {}
  });
  const summary = resolveClientCompatibility({
    resolvedJoinMode: "mobile",
    media: limitedMedia,
    xr: { available: false, canEnterVr: false },
    enterVrFeatureEnabled: true,
    webGlAvailable: true,
    webSocketAvailable: true,
    touchInputAvailable: true
  });

  assert.equal(summary.resolvedJoinMode, "mobile");
  assert.equal(summary.entryBlocked, false);
  assert.equal(summary.degradedMode, "media_limited");
  assert.deepEqual(summary.warnings, ["audio_input_unavailable", "screen_share_unavailable", "xr_unavailable"]);
  assert.match(formatClientCompatibilityStatus(summary), /mobile mode, degraded: microphone unavailable, screen share unavailable, VR unavailable/);
});

test("resolveClientCompatibility marks VR mock mode without requiring real WebXR", () => {
  const summary = resolveClientCompatibility({
    resolvedJoinMode: "vr",
    media: fullMedia,
    xr: { available: false, canEnterVr: false },
    enterVrFeatureEnabled: true,
    webGlAvailable: true,
    webSocketAvailable: true,
    touchInputAvailable: false,
    xrMockEnabled: true
  });

  assert.equal(summary.resolvedJoinMode, "vr");
  assert.equal(summary.modeSource, "xr_mock");
  assert.equal(summary.xr.enterVrVisible, false);
  assert.equal(summary.xr.mocked, true);
  assert.equal(summary.warnings.includes("xr_unavailable"), false);
});

test("resolveClientCompatibility blocks only when WebGL is unavailable", () => {
  const summary = resolveClientCompatibility({
    resolvedJoinMode: "desktop",
    media: fullMedia,
    xr: { available: false, canEnterVr: false },
    enterVrFeatureEnabled: true,
    webGlAvailable: false,
    webSocketAvailable: true,
    touchInputAvailable: false
  });

  assert.equal(summary.entryBlocked, true);
  assert.equal(summary.degradedMode, "webgl_unavailable");
  assert.deepEqual(summary.warnings, ["webgl_unavailable", "xr_unavailable"]);
});
