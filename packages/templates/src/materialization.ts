import type { RoomTemplateDefaults, RoomTemplateVersionContractV1, RoomTemplateVersionSnapshotV1 } from "@vrata/shared-types";
import { resolveLockedRoomTemplateAssetUrl } from "./asset-lock.js";
import { validateRoomTemplateVersionContract } from "./version-contract.js";

export function referenceTemplateContract(snapshot: RoomTemplateVersionSnapshotV1): RoomTemplateVersionContractV1 | undefined {
  if (snapshot.defaults === undefined && snapshot.scene === undefined && snapshot.assetLock === undefined) return undefined;
  const { roomConfig: _roomConfig, ...version } = snapshot as RoomTemplateVersionSnapshotV1 & { roomConfig?: unknown };
  if (validateRoomTemplateVersionContract(version).length > 0) throw new Error("invalid_reference_template_snapshot");
  return structuredClone(version) as RoomTemplateVersionContractV1;
}

export interface TemplateRoomOverrides {
  roomType?: "standard" | "personal";
  visibility?: "public" | "unlisted" | "private";
  guestAllowed?: boolean;
  ownerParticipantId?: string | null;
  sceneBundleUrl?: string;
  features?: Partial<RoomTemplateDefaults["features"]>;
  theme?: Partial<RoomTemplateDefaults["theme"]>;
  avatarConfig?: Partial<RoomTemplateDefaults["avatarConfig"]>;
}

export function materializeReferenceTemplate(
  contract: RoomTemplateVersionContractV1,
  input: TemplateRoomOverrides,
  options: { mirrorBaseUrl?: string; allowLoopbackHttp?: boolean } = {}
): Omit<RoomTemplateDefaults, "surfaces" | "settings"> & { sceneBundleUrl: string } {
  for (const key of ["features", "theme", "avatarConfig"] as const) {
    const value = input[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`invalid_template_override:${key}`);
  }
  if (input.roomType !== undefined && input.roomType !== contract.defaults.roomType) throw new Error("template_room_type_conflict");
  if (contract.defaults.roomType === "personal") {
    if (typeof input.ownerParticipantId !== "string" || !/^[A-Za-z0-9._:-]{3,128}$/.test(input.ownerParticipantId)) throw new Error("missing_personal_room_owner");
    if (input.visibility !== undefined && input.visibility !== "private") throw new Error("personal_room_must_be_private");
    if (input.guestAllowed !== undefined && input.guestAllowed !== false) throw new Error("personal_room_guest_access_forbidden");
  }
  if (input.visibility !== undefined && !["public", "unlisted", "private"].includes(input.visibility)) throw new Error("invalid_room_visibility");
  if (input.guestAllowed !== undefined && typeof input.guestAllowed !== "boolean") throw new Error("invalid_guest_allowed");
  const sceneBundleUrl = resolveLockedRoomTemplateAssetUrl(contract.assetLock, contract.assetLock.sceneManifest.path, options);
  if (input.sceneBundleUrl !== undefined && input.sceneBundleUrl !== sceneBundleUrl) throw new Error("reference_scene_override_not_allowed");
  const defaults = contract.defaults;
  const features = { ...defaults.features };
  for (const key of ["voice", "spatialAudio", "screenShare"] as const) {
    const value = input.features?.[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") throw new Error(`invalid_room_feature:${key}`);
      features[key] = value;
    }
  }
  const theme = { ...defaults.theme };
  for (const key of ["primaryColor", "accentColor"] as const) {
    const value = input.theme?.[key];
    if (value !== undefined) {
      if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error(`invalid_room_theme:${key}`);
      theme[key] = value;
    }
  }
  const avatarConfig = { ...defaults.avatarConfig };
  for (const key of ["avatarsEnabled", "avatarFallbackCapsulesEnabled", "avatarSeatsEnabled"] as const) {
    const value = input.avatarConfig?.[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") throw new Error(`invalid_avatar_config:${key}`);
      avatarConfig[key] = value;
    }
  }
  if (input.avatarConfig?.avatarCatalogUrl !== undefined) {
    if (typeof input.avatarConfig.avatarCatalogUrl !== "string") throw new Error("invalid_avatar_config:avatarCatalogUrl");
    avatarConfig.avatarCatalogUrl = input.avatarConfig.avatarCatalogUrl;
  }
  if (input.avatarConfig?.avatarQualityProfile !== undefined) {
    if (!["mobile-lite", "desktop-standard", "xr"].includes(input.avatarConfig.avatarQualityProfile)) throw new Error("invalid_avatar_config:avatarQualityProfile");
    avatarConfig.avatarQualityProfile = input.avatarConfig.avatarQualityProfile;
  }
  return { roomType: defaults.roomType, visibility: input.visibility ?? defaults.visibility, guestAllowed: input.guestAllowed ?? defaults.guestAllowed, features, theme, avatarConfig, sceneBundleUrl };
}
