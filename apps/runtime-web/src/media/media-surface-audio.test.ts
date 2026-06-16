import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultRoomMediaObjectsState } from "@vrata/shared-types";

import { isScreenShareAudioSource, shouldPublishMediaSurfaceAudio } from "../media-surface-audio.js";

test("shouldPublishMediaSurfaceAudio reads per-surface policy", () => {
  const mediaObjects = createDefaultRoomMediaObjectsState("room-1");
  assert.equal(shouldPublishMediaSurfaceAudio(mediaObjects, "debug-main"), false);

  mediaObjects.surfaces["debug-main"]!.mediaAudioEnabled = true;
  assert.equal(shouldPublishMediaSurfaceAudio(mediaObjects, "debug-main"), true);
  assert.equal(shouldPublishMediaSurfaceAudio(mediaObjects, "missing"), false);
});

test("isScreenShareAudioSource identifies screen-share audio publications", () => {
  assert.equal(isScreenShareAudioSource("screen_share_audio"), true);
  assert.equal(isScreenShareAudioSource("microphone"), false);
  assert.equal(isScreenShareAudioSource(undefined), false);
});
