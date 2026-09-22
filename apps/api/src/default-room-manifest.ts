import type { IncomingMessage } from "node:http";
import type { RoomTemplateSnapshotV1, RoomTemplateVersionSnapshotV1, SceneBundleIntegrity } from "@vrata/shared-types";
import { getCurrentTemplateVersion } from "@vrata/templates";

import type { RoomType, RoomVisibility } from "./storage.js";
import { isDevRoleQueryAllowed } from "./feature-flags.js";
import { getDefaultRoomStateUrl } from "./public-endpoints.js";

export interface RoomManifest {
  schemaVersion: number;
  tenantId: string;
  roomId: string;
  roomType: RoomType;
  ownerParticipantId?: string | null;
  template: string;
  templateVersion: string;
  templateSnapshot: RoomTemplateSnapshotV1;
  sceneBundle?: {
    url: string;
    integrity?: SceneBundleIntegrity;
  };
  realtime: {
    roomStateUrl: string;
  };
  theme: {
    primaryColor: string;
    accentColor: string;
  };
  assets: Array<{
    assetId: string;
    kind: string;
    url: string;
    processedUrl?: string;
    validationStatus?: "pending" | "validated" | "rejected";
  }>;
  features: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
  avatars: {
    avatarsEnabled: boolean;
    avatarCatalogUrl?: string;
    avatarQualityProfile: "desktop-standard" | "mobile-lite" | "xr";
    avatarPoseBinaryEnabled: boolean;
    avatarLipsyncEnabled: boolean;
    avatarLegIkEnabled: boolean;
    avatarFallbackCapsulesEnabled: boolean;
    avatarSeatsEnabled: boolean;
    avatarCustomizationEnabled: boolean;
  };
  quality: {
    default: "desktop-standard" | "mobile-lite" | "xr";
    mobile: "mobile-lite";
    xr: "xr";
  };
  access: {
    joinMode: "link";
    guestAllowed: boolean;
    roleQueryAllowed: boolean;
    visibility: RoomVisibility;
    disabled?: boolean;
  };
}

export function defaultManifest(roomId: string, request?: IncomingMessage, resolvedTemplateVersion?: RoomTemplateVersionSnapshotV1): RoomManifest {
  const templateVersion = resolvedTemplateVersion ?? getCurrentTemplateVersion("meeting-room-basic");
  if (!templateVersion) throw new Error("missing_seed_template_version:meeting-room-basic@0.1.0");
  return {
    schemaVersion: 1,
    tenantId: "demo-tenant",
    roomId,
    roomType: "standard",
    ownerParticipantId: null,
    template: "meeting-room-basic",
    templateVersion: templateVersion.version,
    templateSnapshot: {
      ...templateVersion,
      roomConfig: {
        roomType: "standard",
        visibility: "public",
        guestAllowed: true,
        sceneBundleUrl: null,
        features: { voice: true, spatialAudio: true, screenShare: true },
        theme: { primaryColor: "#5fc8ff", accentColor: "#163354" },
        avatarConfig: {
          avatarsEnabled: true,
          avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
          avatarQualityProfile: "desktop-standard",
          avatarFallbackCapsulesEnabled: true,
          avatarSeatsEnabled: true
        }
      }
    },
    sceneBundle: undefined,
    realtime: {
      roomStateUrl: getDefaultRoomStateUrl(request)
    },
    theme: {
      primaryColor: "#5fc8ff",
      accentColor: "#163354"
    },
    assets: [],
    features: { voice: true, spatialAudio: true, screenShare: true },
    avatars: {
      avatarsEnabled: true,
      avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
      avatarQualityProfile: "desktop-standard",
      avatarPoseBinaryEnabled: true,
      avatarLipsyncEnabled: false,
      avatarLegIkEnabled: false,
      avatarFallbackCapsulesEnabled: true,
      avatarSeatsEnabled: true,
      avatarCustomizationEnabled: false
    },
    quality: { default: "desktop-standard", mobile: "mobile-lite", xr: "xr" },
    access: { joinMode: "link", guestAllowed: true, roleQueryAllowed: isDevRoleQueryAllowed(), visibility: "public", disabled: false }
  };
}
