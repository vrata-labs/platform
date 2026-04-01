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
