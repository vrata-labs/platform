export interface RuntimeFeatureFlags {
  spatialAudio: boolean;
  enterVr: boolean;
  screenShare: boolean;
  avatarsEnabled: boolean;
  avatarPoseBinaryEnabled: boolean;
  avatarLipsyncEnabled: boolean;
  avatarLegIkEnabled: boolean;
  avatarSeatingEnabled: boolean;
  avatarCustomizationEnabled: boolean;
  avatarFallbackCapsulesEnabled: boolean;
}

export function createFeatureFlags(overrides?: Partial<RuntimeFeatureFlags>): RuntimeFeatureFlags {
  return {
    spatialAudio: true,
    enterVr: true,
    screenShare: false,
    avatarsEnabled: true,
    avatarPoseBinaryEnabled: true,
    avatarLipsyncEnabled: false,
    avatarLegIkEnabled: false,
    avatarSeatingEnabled: false,
    avatarCustomizationEnabled: false,
    avatarFallbackCapsulesEnabled: true,
    ...overrides
  };
}
