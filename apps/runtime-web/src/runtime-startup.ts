import type { RuntimeIssue } from "./runtime-errors.js";
import type { RuntimeUiState } from "./runtime-state.js";

export interface RuntimeStartupElements {
  joinAudioButton: HTMLButtonElement;
  muteButton: HTMLButtonElement;
  startShareButton: HTMLButtonElement;
}

export function applyPostBootControls(input: {
  displayName: string;
  runtimeFlags: {
    audioJoin: boolean;
    screenShare: boolean;
  };
  shareMockEnabled: boolean;
  elements: RuntimeStartupElements;
  setStatus(message: string): void;
  setAudioStateDisabled(): void;
}): void {
  input.setStatus(`Joined as ${input.displayName}`);
  input.elements.startShareButton.disabled = !input.runtimeFlags.screenShare && !input.shareMockEnabled;
  input.elements.joinAudioButton.disabled = !input.runtimeFlags.audioJoin;
  if (!input.runtimeFlags.audioJoin) {
    input.elements.muteButton.disabled = true;
    input.setAudioStateDisabled();
  }
}

export function shouldStartPassiveMedia(input: {
  audioJoin: boolean;
  screenShare: boolean;
  audioFault?: string;
}): boolean {
  return (input.audioJoin || input.screenShare)
    && input.audioFault !== "mic_denied"
    && input.audioFault !== "no_audio_device";
}

export function applyPassiveMediaRecovery(input: {
  runtimeUiState: RuntimeUiState;
  issue: RuntimeIssue;
}): RuntimeUiState {
  return {
    ...input.runtimeUiState,
    audioState: "degraded",
    lastRecoveryAction: "media_passive_connect_failed"
  };
}
