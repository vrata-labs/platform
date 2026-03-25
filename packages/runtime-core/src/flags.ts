export interface RuntimeFeatureFlags {
  spatialAudio: boolean;
  enterVr: boolean;
  screenShare: boolean;
}

export function createFeatureFlags(overrides?: Partial<RuntimeFeatureFlags>): RuntimeFeatureFlags {
  return {
    spatialAudio: true,
    enterVr: true,
    screenShare: false,
    ...overrides
  };
}
