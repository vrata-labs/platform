export type RoomTemplateStatus = "active" | "deprecated";

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
