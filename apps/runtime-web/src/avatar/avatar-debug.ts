export interface AvatarDiagnostics {
  state: "idle" | "loading" | "loaded" | "failed";
  catalogId: string | null;
  packUrl: string | null;
  packFormat: string | null;
  presetCount: number;
  selectedAvatarId: string | null;
  fallbackActive: boolean;
  fallbackReason: string | null;
  sandboxEntryPoint: string | null;
  validatorSummary: string[];
}

export function createEmptyAvatarDiagnostics(): AvatarDiagnostics {
  return {
    state: "idle",
    catalogId: null,
    packUrl: null,
    packFormat: null,
    presetCount: 0,
    selectedAvatarId: null,
    fallbackActive: false,
    fallbackReason: null,
    sandboxEntryPoint: null,
    validatorSummary: []
  };
}

export function createAvatarLoadingDiagnostics(sandboxEntryPoint: string): AvatarDiagnostics {
  return {
    ...createEmptyAvatarDiagnostics(),
    state: "loading",
    sandboxEntryPoint
  };
}

export function createAvatarFailedDiagnostics(sandboxEntryPoint: string, reason: string): AvatarDiagnostics {
  return {
    ...createEmptyAvatarDiagnostics(),
    state: "failed",
    fallbackActive: true,
    fallbackReason: reason,
    sandboxEntryPoint
  };
}

export function createAvatarLoadedDiagnostics(input: {
  sandboxEntryPoint: string;
  selectedAvatarId: string | null;
  catalogId: string | null;
  packUrl: string | null;
  packFormat: string | null;
  presetCount: number;
  validatorSummary: string[];
}): AvatarDiagnostics {
  return {
    ...createEmptyAvatarDiagnostics(),
    state: "loaded",
    catalogId: input.catalogId,
    packUrl: input.packUrl,
    packFormat: input.packFormat,
    presetCount: input.presetCount,
    selectedAvatarId: input.selectedAvatarId,
    fallbackActive: false,
    fallbackReason: null,
    sandboxEntryPoint: input.sandboxEntryPoint,
    validatorSummary: input.validatorSummary
  };
}
