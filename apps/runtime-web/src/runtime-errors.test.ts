import test from "node:test";
import assert from "node:assert/strict";

import { classifyMediaError, createFaultError, getRuntimeIssue, shouldRetryConnection } from "./runtime-errors.js";

test("classifyMediaError maps NotAllowedError to mic_denied", () => {
  const issue = classifyMediaError(createFaultError("NotAllowedError", "user blocked microphone"));
  assert.equal(issue.code, "mic_denied");
  assert.equal(issue.retryable, false);
});

test("classifyMediaError maps NotFoundError to no_audio_device", () => {
  const issue = classifyMediaError(createFaultError("NotFoundError", "device missing"));
  assert.equal(issue.code, "no_audio_device");
});

test("shouldRetryConnection only retries transport issues", () => {
  assert.equal(shouldRetryConnection("livekit_failed"), true);
  assert.equal(shouldRetryConnection("room_state_failed"), true);
  assert.equal(shouldRetryConnection("xr_unavailable"), false);
});

test("runtime issue catalog exposes user-facing copy", () => {
  const issue = getRuntimeIssue("xr_unavailable");
  assert.match(issue.userMessage, /VR unavailable/);
});
