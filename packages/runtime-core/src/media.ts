export type MediaConnectionState = "idle" | "connecting" | "connected" | "failed";

export interface MediaTokenResponse {
  token: string;
  expiresInSeconds: number;
  livekitUrl: string;
}

export interface VoiceSettings {
  audioJoinRequired: boolean;
  spatialAudioEnabled: boolean;
  muteOnJoin: boolean;
}

export interface SpatialAudioConfig {
  mode: "stereo" | "hrtf";
  distanceModel: "linear" | "inverse" | "exponential";
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
}

export interface MediaSessionState {
  participantId: string;
  roomId: string;
  connectionState: MediaConnectionState;
  settings: VoiceSettings;
  spatialAudio: SpatialAudioConfig;
}

export interface ScreenSharePlan {
  enabled: boolean;
  surfaceId: string;
}

export function createVoiceSettings(enabled: boolean): VoiceSettings {
  return {
    audioJoinRequired: true,
    spatialAudioEnabled: enabled,
    muteOnJoin: false
  };
}

export function createSpatialAudioConfig(enabled: boolean): SpatialAudioConfig {
  return {
    mode: enabled ? "hrtf" : "stereo",
    distanceModel: "inverse",
    refDistance: 1,
    maxDistance: 25,
    rolloffFactor: 1
  };
}

export function createMediaSessionState(
  roomId: string,
  participantId: string,
  spatialAudioEnabled: boolean
): MediaSessionState {
  return {
    roomId,
    participantId,
    connectionState: "idle",
    settings: createVoiceSettings(spatialAudioEnabled),
    spatialAudio: createSpatialAudioConfig(spatialAudioEnabled)
  };
}

export function updateMediaConnectionState(
  state: MediaSessionState,
  connectionState: MediaConnectionState
): MediaSessionState {
  return {
    ...state,
    connectionState
  };
}

export function createScreenSharePlan(enabled: boolean, surfaceId = "main-screen"): ScreenSharePlan {
  return {
    enabled,
    surfaceId
  };
}
