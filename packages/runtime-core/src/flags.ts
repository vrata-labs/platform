export interface RuntimeFeatureFlags {
  spatialAudio: boolean;
  enterVr: boolean;
  screenShare: boolean;
  avatarsEnabled: boolean;
  avatarFallbackCapsulesEnabled: boolean;
}

export function createFeatureFlags(overrides?: Partial<RuntimeFeatureFlags>): RuntimeFeatureFlags {
  return {
    spatialAudio: true,
    enterVr: true,
    screenShare: false,
    avatarsEnabled: false,
    avatarFallbackCapsulesEnabled: true,
    ...overrides
  };
}
