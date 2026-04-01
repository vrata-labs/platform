export type AvatarInputMode = "desktop" | "mobile" | "vr-controller" | "vr-hand";

export interface AvatarReliableState {
  participantId: string;
  avatarId: string;
  recipeVersion: 1;
  inputMode: AvatarInputMode;
  seated: boolean;
  seatId?: string;
  muted: boolean;
  audioActive: boolean;
  updatedAt: string;
}

export type AvatarQualityProfile = "mobile-lite" | "desktop-standard" | "xr";

export interface AvatarManifestConfig {
  avatarsEnabled: boolean;
  avatarCatalogUrl?: string;
  avatarQualityProfile: AvatarQualityProfile;
  avatarFallbackCapsulesEnabled: boolean;
  avatarSeatsEnabled?: boolean;
}

export interface AvatarCatalogPreset {
  avatarId: string;
  label: string;
  recipeId: string;
  thumbnailUrl?: string;
  validation: {
    triangleCount: number;
    materialCount: number;
    textureCount: number;
    morphTargets: string[];
    animationClips: string[];
    skeletonSignature: string;
  };
}

export interface AvatarCatalogV1 {
  schemaVersion: 1;
  catalogId: string;
  assetVersion: string;
  rig: "humanoid-v1";
  packUrl: string;
  packFormat: "glb-v1" | "procedural-debug-v1";
  presets: AvatarCatalogPreset[];
}
