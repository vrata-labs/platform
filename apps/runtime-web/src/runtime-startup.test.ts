import test from "node:test";
import assert from "node:assert/strict";

import { getRuntimeIssue } from "./runtime-errors.js";
import { createRuntimeUiState } from "./runtime-state.js";
import { applyPassiveMediaRecovery, applyPostBootControls, shouldStartPassiveMedia } from "./runtime-startup.js";

test("applyPostBootControls sets joined status and disables controls by flags", () => {
  const joinAudioButton = { disabled: false } as HTMLButtonElement;
  const muteButton = { disabled: false } as HTMLButtonElement;
  const startShareButton = { disabled: false } as HTMLButtonElement;
  let status = "";
  let audioDisabled = false;

  applyPostBootControls({
    displayName: "Tester",
    runtimeFlags: { audioJoin: false, screenShare: false },
    shareMockEnabled: false,
    elements: { joinAudioButton, muteButton, startShareButton },
    setStatus(message) {
      status = message;
    },
    setAudioStateDisabled() {
      audioDisabled = true;
    }
  });

  assert.equal(status, "Joined as Tester");
  assert.equal(joinAudioButton.disabled, true);
  assert.equal(startShareButton.disabled, true);
  assert.equal(muteButton.disabled, true);
  assert.equal(audioDisabled, true);
});

test("shouldStartPassiveMedia rejects mic-denied path", () => {
  assert.equal(shouldStartPassiveMedia({ audioJoin: true, screenShare: false, audioFault: "mic_denied" }), false);
  assert.equal(shouldStartPassiveMedia({ audioJoin: false, screenShare: true, audioFault: "none" }), true);
});

test("applyPassiveMediaRecovery marks degraded audio state", () => {
  const next = applyPassiveMediaRecovery({
    runtimeUiState: createRuntimeUiState(),
    issue: getRuntimeIssue("livekit_failed")
  });
  assert.equal(next.audioState, "degraded");
  assert.equal(next.lastRecoveryAction, "media_passive_connect_failed");
});
