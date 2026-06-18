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
