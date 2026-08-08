export type RoomTemplateStatus = "active" | "deprecated";
export type RoomTemplateLayout = "personal-workspace" | "meeting" | "presentation";
export type RoomTemplateNoteScope = "shared" | "private";
export type RoomTemplateSurfacePurpose = "workspace" | "collaboration" | "presentation";

export interface RoomTemplateSurfaceAspectRatio {
  width: number;
  height: number;
  maxRelativeError: number;
}

export interface RoomTemplateSurface {
  surfaceId: string;
  label: string;
  purpose: RoomTemplateSurfacePurpose;
  allowedObjectTypes: string[];
  aspectRatio?: RoomTemplateSurfaceAspectRatio;
}

export interface RoomTemplateSceneContract {
  schemaVersion: 1;
  templateId: string;
  templateVersion: string;
  sceneId: string;
  sceneVersion: string;
  surfaces: RoomTemplateSurface[];
  seats: {
    minimum: number;
    maximum: number;
  };
}

export interface RoomTemplateAssetFileLock {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface RoomTemplateAssetLock {
  repository: string;
  commitSha: string;
  sceneReleaseId: string;
  releaseManifest: RoomTemplateAssetFileLock;
  sceneManifest: RoomTemplateAssetFileLock;
  sceneAsset: RoomTemplateAssetFileLock;
  preview: RoomTemplateAssetFileLock;
}

export interface RoomTemplateSettings {
  layout: RoomTemplateLayout;
  notes: {
    enabled: boolean;
    defaultScope: RoomTemplateNoteScope;
  };
  audio: {
    enabled: boolean;
    spatial: boolean;
    joinMutedByDefault: boolean;
    participantLayout: "owner-focused" | "round-table" | "audience";
  };
  presentation: {
    enabled: boolean;
    surfaceId?: string;
  };
}

export interface RoomTemplateDefaults {
  roomType: "standard" | "personal";
  visibility: "public" | "unlisted" | "private";
  guestAllowed: boolean;
  features: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
  theme: {
    primaryColor: string;
    accentColor: string;
  };
  avatarConfig: {
    avatarsEnabled: boolean;
    avatarCatalogUrl: string;
    avatarQualityProfile: "mobile-lite" | "desktop-standard" | "xr";
    avatarFallbackCapsulesEnabled: boolean;
    avatarSeatsEnabled: boolean;
  };
  surfaces: RoomTemplateSurface[];
  settings: RoomTemplateSettings;
}

export interface RoomTemplateVersionContractV1 {
  schemaVersion: 1;
  templateId: string;
  version: string;
  label: string;
  description: string;
  assetSlots: string[];
  defaults: RoomTemplateDefaults;
  scene: RoomTemplateSceneContract;
  assetLock: RoomTemplateAssetLock;
}

export interface RoomTemplateCatalogRecord {
  templateId: string;
  label: string;
  assetSlots: string[];
  currentVersion: string;
  status: RoomTemplateStatus;
}

export interface RoomTemplateVersionSnapshotV1 {
  schemaVersion: 1;
  templateId: string;
  version: string;
  label: string;
  assetSlots: string[];
}

export interface RoomTemplateSnapshotV1 extends RoomTemplateVersionSnapshotV1 {
  roomConfig: {
    roomType: "standard" | "personal";
    visibility: "public" | "unlisted" | "private";
    guestAllowed: boolean;
    sceneBundleUrl: string | null;
    features: {
      voice: boolean;
      spatialAudio: boolean;
      screenShare: boolean;
    };
    theme: {
      primaryColor: string;
      accentColor: string;
    };
    avatarConfig: {
      avatarsEnabled: boolean;
      avatarCatalogUrl?: string;
      avatarQualityProfile: "mobile-lite" | "desktop-standard" | "xr";
      avatarFallbackCapsulesEnabled: boolean;
      avatarSeatsEnabled?: boolean;
    };
  };
}
