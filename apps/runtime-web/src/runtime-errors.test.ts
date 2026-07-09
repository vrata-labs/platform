import test from "node:test";
import assert from "node:assert/strict";

import { classifyMediaError, classifyScreenShareError, createFaultError, getRuntimeIssue, shouldRetryConnection } from "./runtime-errors.js";

test("classifyMediaError maps NotAllowedError to mic_denied", () => {
  const issue = classifyMediaError(createFaultError("NotAllowedError", "user blocked microphone"));
  assert.equal(issue.code, "mic_denied");
  assert.equal(issue.retryable, false);
});

test("classifyMediaError maps NotFoundError to no_audio_device", () => {
  const issue = classifyMediaError(createFaultError("NotFoundError", "device missing"));
  assert.equal(issue.code, "no_audio_device");
});

test("classifyMediaError maps unsupported capture to audio_unsupported", () => {
  const issue = classifyMediaError(createFaultError("NotSupportedError", "audio_unsupported:get_user_media_missing"));
  assert.equal(issue.code, "audio_unsupported");
});

test("classifyMediaError maps LiveKit transport failures to media_network_blocked", () => {
  const issue = classifyMediaError(createFaultError("ConnectionError", "websocket connection failed"));
  assert.equal(issue.code, "media_network_blocked");
  assert.match(issue.userMessage, /scene can load/);
});

test("classifyScreenShareError maps unsupported and denied paths", () => {
  assert.equal(
    classifyScreenShareError(createFaultError("NotSupportedError", "screen_share_unsupported:getDisplayMedia missing")).code,
    "screen_share_unsupported"
  );
  assert.equal(
    classifyScreenShareError(createFaultError("NotAllowedError", "user denied screen share")).code,
    "screen_share_denied"
  );
  assert.equal(
    classifyScreenShareError(createFaultError("TimeoutError", "ICE transport timed out")).code,
    "media_network_blocked"
  );
});

test("shouldRetryConnection only retries transport issues", () => {
  assert.equal(shouldRetryConnection("livekit_failed"), true);
  assert.equal(shouldRetryConnection("media_network_blocked"), true);
  assert.equal(shouldRetryConnection("room_state_failed"), true);
  assert.equal(shouldRetryConnection("audio_unsupported"), false);
  assert.equal(shouldRetryConnection("screen_share_unsupported"), false);
  assert.equal(shouldRetryConnection("xr_unavailable"), false);
  assert.equal(shouldRetryConnection("xr_enter_failed"), false);
});

test("runtime issue catalog exposes user-facing copy", () => {
  const issue = getRuntimeIssue("xr_unavailable");
  assert.match(issue.userMessage, /VR unavailable/);
  assert.match(getRuntimeIssue("xr_enter_failed").userMessage, /VR session could not start/);
});
