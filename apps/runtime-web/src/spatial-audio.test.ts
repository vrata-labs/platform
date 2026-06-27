import test from "node:test";
import assert from "node:assert/strict";

import { createSpatialAudioSettings, resolveSpatialAudioMode } from "./spatial-audio.js";

test("createSpatialAudioSettings returns stable defaults", () => {
  const settings = createSpatialAudioSettings();
  assert.equal(settings.panningModel, "HRTF");
  assert.equal(settings.distanceModel, "inverse");
  assert.equal(settings.refDistance, 1);
  assert.equal(settings.maxDistance, 25);
});

test("resolveSpatialAudioMode reports disabled query fallback", () => {
  const state = resolveSpatialAudioMode({
    queryEnabled: false,
    featureEnabled: true,
    roomEnabled: true,
    audioContextAvailable: true,
    pannerNodeCount: 1
  });

  assert.deepEqual(state, {
    enabled: false,
    fallback: true,
    mode: "disabled",
    fallbackReason: "query_disabled"
  });
});

test("resolveSpatialAudioMode reports active spatial graph", () => {
  const state = resolveSpatialAudioMode({
    queryEnabled: true,
    featureEnabled: true,
    roomEnabled: true,
    audioContextAvailable: true,
    pannerNodeCount: 2
  });

  assert.deepEqual(state, {
    enabled: true,
    fallback: false,
    mode: "spatial",
    fallbackReason: null
  });
});

test("resolveSpatialAudioMode preserves Web Audio fallback reason", () => {
  const state = resolveSpatialAudioMode({
    queryEnabled: true,
    featureEnabled: true,
    roomEnabled: true,
    audioContextAvailable: false,
    pannerNodeCount: 0,
    fallbackReason: "audio_context_unavailable"
  });

  assert.deepEqual(state, {
    enabled: true,
    fallback: true,
    mode: "fallback",
    fallbackReason: "audio_context_unavailable"
  });
});
