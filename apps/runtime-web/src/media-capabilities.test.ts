import test from "node:test";
import assert from "node:assert/strict";

import { detectBrowserMediaCapabilities, formatUnsupportedMediaCapabilities } from "./media-capabilities.js";

test("detectBrowserMediaCapabilities accepts full WebRTC capture support", () => {
  const capabilities = detectBrowserMediaCapabilities({
    isSecureContext: true,
    mediaDevices: {
      enumerateDevices() {},
      getDisplayMedia() {},
      getUserMedia() {}
    },
    rtcPeerConnection() {}
  });

  assert.equal(capabilities.audioInput.supported, true);
  assert.equal(capabilities.screenShare.supported, true);
  assert.equal(formatUnsupportedMediaCapabilities(capabilities), "");
});

test("detectBrowserMediaCapabilities reports missing mobile capture APIs", () => {
  const capabilities = detectBrowserMediaCapabilities({
    isSecureContext: true,
    mediaDevices: {
      enumerateDevices() {}
    },
    rtcPeerConnection() {}
  });

  assert.equal(capabilities.audioInput.supported, false);
  assert.equal(capabilities.audioInput.reason, "get_user_media_missing");
  assert.equal(capabilities.screenShare.supported, false);
  assert.equal(capabilities.screenShare.reason, "get_display_media_missing");
  assert.match(formatUnsupportedMediaCapabilities(capabilities), /Microphone unsupported: getUserMedia missing/);
  assert.match(formatUnsupportedMediaCapabilities(capabilities), /Screen share unsupported: getDisplayMedia missing/);
});

test("detectBrowserMediaCapabilities reports insecure contexts before capture APIs", () => {
  const capabilities = detectBrowserMediaCapabilities({
    isSecureContext: false,
    mediaDevices: {
      enumerateDevices() {},
      getDisplayMedia() {},
      getUserMedia() {}
    },
    rtcPeerConnection() {}
  });

  assert.equal(capabilities.audioInput.reason, "insecure_context");
  assert.equal(capabilities.screenShare.reason, "insecure_context");
});
