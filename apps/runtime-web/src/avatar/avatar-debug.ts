export interface AvatarDiagnostics {
  state: "idle" | "loading" | "loaded" | "failed";
  catalogId: string | null;
  packUrl: string | null;
  packFormat: string | null;
  presetCount: number;
  selectedAvatarId: string | null;
  inputMode: string | null;
  locomotionState: string | null;
  locomotionTransitioned: boolean;
  qualityMode: string | null;
  skatingMetric: number;
  footLockStrength: number;
  footingCorrectionActive: boolean;
  visibilityState: string | null;
  solveState: string | null;
  animationState: string | null;
  bodyLean: number;
  activeControllerCount: number;
  controllerProfile: string | null;
  xrInputProfile: string | null;
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
    inputMode: null,
    locomotionState: null,
    locomotionTransitioned: false,
    qualityMode: null,
    skatingMetric: 0,
    footLockStrength: 0,
    footingCorrectionActive: false,
    visibilityState: null,
    solveState: null,
    animationState: null,
    bodyLean: 0,
    activeControllerCount: 0,
    controllerProfile: null,
    xrInputProfile: null,
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
  inputMode?: string | null;
  locomotionState?: string | null;
  locomotionTransitioned?: boolean;
  qualityMode?: string | null;
  skatingMetric?: number;
  footLockStrength?: number;
  footingCorrectionActive?: boolean;
  visibilityState?: string | null;
  solveState?: string | null;
  animationState?: string | null;
  bodyLean?: number;
  activeControllerCount?: number;
  controllerProfile?: string | null;
  xrInputProfile?: string | null;
}): AvatarDiagnostics {
  return {
    ...createEmptyAvatarDiagnostics(),
    state: "loaded",
    catalogId: input.catalogId,
    packUrl: input.packUrl,
    packFormat: input.packFormat,
    presetCount: input.presetCount,
    selectedAvatarId: input.selectedAvatarId,
    inputMode: input.inputMode ?? null,
    locomotionState: input.locomotionState ?? null,
    locomotionTransitioned: input.locomotionTransitioned ?? false,
    qualityMode: input.qualityMode ?? null,
    skatingMetric: input.skatingMetric ?? 0,
    footLockStrength: input.footLockStrength ?? 0,
    footingCorrectionActive: input.footingCorrectionActive ?? false,
    visibilityState: input.visibilityState ?? null,
    solveState: input.solveState ?? null,
    animationState: input.animationState ?? null,
    bodyLean: input.bodyLean ?? 0,
    activeControllerCount: input.activeControllerCount ?? 0,
    controllerProfile: input.controllerProfile ?? null,
    xrInputProfile: input.xrInputProfile ?? null,
    fallbackActive: false,
    fallbackReason: null,
    sandboxEntryPoint: input.sandboxEntryPoint,
    validatorSummary: input.validatorSummary
  };
}
