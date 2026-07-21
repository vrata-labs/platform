import assert from "node:assert/strict";
import test from "node:test";
import type { VideoPlayerState } from "@vrata/shared-types";
import { planVideoPlaybackCorrection, resolveVideoTargetSeconds } from "./video-playback-clock.js";

const state: VideoPlayerState = {
  status: "active",
  documentId: "document-1",
  filename: "clip.mp4",
  checksum: `sha256:${"a".repeat(64)}`,
  contentType: "video/mp4",
  widthPx: 640,
  heightPx: 360,
  durationMs: 5000,
  playbackState: "playing",
  positionMs: 1000,
  anchorServerTimeMs: 10_000,
  loop: false,
  fitMode: "contain",
  lastInputEventId: "input-1"
};

test("video target follows authoritative server time and loops", () => {
  assert.equal(resolveVideoTargetSeconds(state, 11_500), 2.5);
  assert.equal(resolveVideoTargetSeconds({ ...state, loop: true, positionMs: 4500 }, 11_000), 0.5);
  assert.equal(resolveVideoTargetSeconds({ ...state, playbackState: "paused", positionMs: 2200 }, 99_000), 2.2);
});

test("video correction uses rate for small drift and seek for discontinuities", () => {
  assert.deepEqual(planVideoPlaybackCorrection(1, 1.02, false).mode, "none");
  const rate = planVideoPlaybackCorrection(1, 1.2, false);
  assert.equal(rate.mode, "rate");
  assert.equal(rate.playbackRate > 1, true);
  assert.equal(planVideoPlaybackCorrection(1, 2, false).mode, "seek");
  assert.equal(planVideoPlaybackCorrection(1, 1.2, true).mode, "seek");
});
