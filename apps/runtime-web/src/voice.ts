export interface VoiceUiState {
  joinAudioLabel: string;
  muteLabel: string;
  connectionLabel: string;
}

export function createVoiceUiState(): VoiceUiState {
  return {
    joinAudioLabel: "Join Audio",
    muteLabel: "Mute",
    connectionLabel: "idle"
  };
}

export function describeSpatialAudio(enabled: boolean): string {
  return enabled ? "spatial-audio:on" : "spatial-audio:off";
}
