import test from "node:test";
import assert from "node:assert/strict";

import { applyRuntimeIssueState, clearRuntimeIssueState, createRuntimeUiState } from "./runtime-state.js";

test("applyRuntimeIssueState stores degraded mode and retry count", () => {
  const state = applyRuntimeIssueState(createRuntimeUiState(), {
    statusLine: "Audio service unavailable; room continues in presence-only mode",
    issueCode: "livekit_failed",
    issueSeverity: "error",
    degradedMode: "presence_only",
    audioState: "degraded",
    lastRecoveryAction: "fallback_presence_only",
    incrementRetry: true
  });

  assert.equal(state.issueCode, "livekit_failed");
  assert.equal(state.degradedMode, "presence_only");
  assert.equal(state.retryCount, 1);
});

test("clearRuntimeIssueState clears active issue details", () => {
  const withIssue = applyRuntimeIssueState(createRuntimeUiState(), {
    statusLine: "Realtime sync unavailable; using API fallback",
    issueCode: "room_state_failed",
    issueSeverity: "error",
    degradedMode: "api_fallback",
    roomStateMode: "fallback",
    lastRecoveryAction: "fallback_api"
  });

  const cleared = clearRuntimeIssueState(withIssue, "Joined as Guest");
  assert.equal(cleared.issueCode, null);
  assert.equal(cleared.degradedMode, "none");
  assert.equal(cleared.lastRecoveryAction, "cleared");
});
