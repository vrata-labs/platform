export interface SpatialAudioSettings {
  panningModel: PanningModelType | "HRTF" | "equalpower";
  distanceModel: DistanceModelType | "inverse" | "linear" | "exponential";
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  coneInnerAngle: number;
  coneOuterAngle: number;
  coneOuterGain: number;
}

export type SpatialAudioGraphMode = "disabled" | "idle" | "spatial" | "fallback";

export interface SpatialAudioModeInput {
  queryEnabled: boolean;
  featureEnabled: boolean;
  roomEnabled: boolean;
  audioContextAvailable: boolean;
  pannerNodeCount: number;
  fallbackReason?: string | null;
}

export interface SpatialAudioModeState {
  enabled: boolean;
  fallback: boolean;
  mode: SpatialAudioGraphMode;
  fallbackReason: string | null;
}

export function createSpatialAudioSettings(): SpatialAudioSettings {
  return {
    panningModel: "HRTF",
    distanceModel: "inverse",
    refDistance: 1,
    maxDistance: 25,
    rolloffFactor: 1,
    coneInnerAngle: 360,
    coneOuterAngle: 360,
    coneOuterGain: 0.2
  };
}

export function resolveSpatialAudioMode(input: SpatialAudioModeInput): SpatialAudioModeState {
  if (!input.featureEnabled) {
    return { enabled: false, fallback: true, mode: "disabled", fallbackReason: "feature_disabled" };
  }
  if (!input.roomEnabled) {
    return { enabled: false, fallback: true, mode: "disabled", fallbackReason: "room_disabled" };
  }
  if (!input.queryEnabled) {
    return { enabled: false, fallback: true, mode: "disabled", fallbackReason: "query_disabled" };
  }
  if (input.fallbackReason) {
    return { enabled: true, fallback: true, mode: "fallback", fallbackReason: input.fallbackReason };
  }
  if (input.pannerNodeCount > 0) {
    return { enabled: true, fallback: false, mode: "spatial", fallbackReason: null };
  }
  if (!input.audioContextAvailable) {
    return { enabled: true, fallback: false, mode: "idle", fallbackReason: null };
  }
  return { enabled: true, fallback: false, mode: "idle", fallbackReason: null };
}

export function applySpatialSettings(panner: PannerNode, settings: SpatialAudioSettings): void {
  panner.panningModel = settings.panningModel as PanningModelType;
  panner.distanceModel = settings.distanceModel as DistanceModelType;
  panner.refDistance = settings.refDistance;
  panner.maxDistance = settings.maxDistance;
  panner.rolloffFactor = settings.rolloffFactor;
  panner.coneInnerAngle = settings.coneInnerAngle;
  panner.coneOuterAngle = settings.coneOuterAngle;
  panner.coneOuterGain = settings.coneOuterGain;
}
