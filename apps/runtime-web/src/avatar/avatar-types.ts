export type AvatarInputMode = "desktop" | "mobile" | "vr-controller" | "vr-hand";

export type AvatarQualityProfile = "mobile-lite" | "desktop-standard" | "xr";

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

export interface CompactPoseFrame {
  seq: number;
  sentAtMs: number;
  flags: number;
  root: { x: number; y: number; z: number; yaw: number; vx: number; vz: number };
  head: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };
  leftHand: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; gesture: number };
  rightHand: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; gesture: number };
  locomotion: { mode: number; speed: number; angularVelocity: number };
}

export interface AvatarRecipeV1 {
  schemaVersion: 1;
  avatarId: string;
  rig: "humanoid-v1";
  bodyVariant: string;
  headVariant: string;
  hairVariant: string;
  outfitVariant: string;
  palette: {
    skin: string;
    primary: string;
    accent: string;
  };
  accessories: string[];
}

export interface AvatarRecipeCatalogV1 {
  schemaVersion: 1;
  recipes: AvatarRecipeV1[];
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

export interface RuntimeAvatarConfig {
  avatarsEnabled: boolean;
  avatarCatalogUrl?: string;
  avatarQualityProfile: AvatarQualityProfile;
  avatarFallbackCapsulesEnabled: boolean;
  avatarSeatsEnabled: boolean;
}

export interface LoadedAvatarPreset {
  preset: AvatarCatalogPreset;
  recipe: AvatarRecipeV1;
}

export interface LocalAvatarSnapshotV1 {
  schemaVersion: 1;
  avatarId: string;
  inputMode: AvatarInputMode;
  visibilityState: "full-body" | "upper-body" | "hands-only" | "hidden";
  controllerProfile: string;
  locomotionState: string;
  animationState: string;
  fallbackReason: string | null;
  root: { x: number; y: number; z: number; yaw: number };
  head: { x: number; y: number; z: number };
  leftHand: { x: number; y: number; z: number; visible: boolean };
  rightHand: { x: number; y: number; z: number; visible: boolean };
  updatedAt: string;
}
