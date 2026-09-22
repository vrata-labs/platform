import type { IncomingMessage } from "node:http";
import type { Storage } from "./storage.js";

import { defaultManifest, type RoomManifest } from "./default-room-manifest.js";
import { isDevRoleQueryAllowed } from "./feature-flags.js";
import { getDefaultRoomStateUrl } from "./public-endpoints.js";
import { sanitizeRoomVisibility } from "./room-input.js";
import { isRoomDisabled } from "./room-session-control.js";
import { referenceTemplateContract } from "@vrata/templates";

export function createRoomManifestBuilder(storagePromise: Promise<Pick<Storage, "getRoom" | "getTemplateVersion" | "listAssets">>) {
  async function buildManifest(roomId: string, request?: IncomingMessage): Promise<RoomManifest> {
    const storage = await storagePromise;
    const room = await storage.getRoom(roomId);
    if (!room) {
      const templateVersion = await storage.getTemplateVersion("meeting-room-basic", "0.1.0");
      if (!templateVersion) throw new Error("template_version_not_found:meeting-room-basic");
      return defaultManifest(roomId, request, templateVersion);
    }
    const roomAssets = (await storage.listAssets()).filter((asset) => room.assetIds.includes(asset.assetId));
    const contract = referenceTemplateContract(room.templateSnapshot);
    return {
      schemaVersion: 1,
      tenantId: room.tenantId,
      roomId: room.roomId,
      roomType: room.roomType ?? "standard",
      ownerParticipantId: room.ownerParticipantId ?? null,
      template: room.templateId,
      templateVersion: room.templateVersion,
      templateSnapshot: room.templateSnapshot,
      sceneBundle: room.sceneBundleUrl ? { url: room.sceneBundleUrl, ...(contract ? { integrity: { manifestSha256: contract.assetLock.sceneManifest.sha256, assetSha256: contract.assetLock.sceneAsset.sha256 } } : {}) } : undefined,
      realtime: {
        roomStateUrl: getDefaultRoomStateUrl(request)
      },
      theme: room.theme ?? {
        primaryColor: "#5fc8ff",
        accentColor: "#163354"
      },
      assets: roomAssets.map((asset) => ({
        assetId: asset.assetId,
        kind: asset.kind,
        url: asset.url,
        processedUrl: asset.processedUrl,
        validationStatus: asset.validationStatus
      })),
      features: room.features,
      avatars: {
        avatarsEnabled: room.avatarConfig?.avatarsEnabled ?? true,
        avatarCatalogUrl: room.avatarConfig?.avatarCatalogUrl,
        avatarQualityProfile: room.avatarConfig?.avatarQualityProfile ?? "desktop-standard",
        avatarPoseBinaryEnabled: process.env.FEATURE_AVATAR_POSE_BINARY !== "false",
        avatarLipsyncEnabled: process.env.FEATURE_AVATAR_LIPSYNC === "true",
        avatarLegIkEnabled: process.env.FEATURE_AVATAR_LEG_IK === "true",
        avatarFallbackCapsulesEnabled: room.avatarConfig?.avatarFallbackCapsulesEnabled ?? true,
        avatarSeatsEnabled: room.avatarConfig?.avatarSeatsEnabled ?? true,
        avatarCustomizationEnabled: process.env.FEATURE_AVATAR_CUSTOMIZATION === "true"
      },
      quality: { default: "desktop-standard", mobile: "mobile-lite", xr: "xr" },
      access: { joinMode: "link", guestAllowed: room.guestAllowed ?? true, roleQueryAllowed: isDevRoleQueryAllowed(), visibility: sanitizeRoomVisibility(room.visibility), disabled: isRoomDisabled(room) }
    };
  }

  return buildManifest;
}
