import type { RoomRecord, RoomVisibility } from "./storage.js";

export function isRoomVisibility(input: unknown): input is RoomVisibility {
  return input === "public" || input === "unlisted" || input === "private";
}

export function sanitizeRoomVisibility(input: unknown, fallback: RoomVisibility = "public"): RoomVisibility {
  return isRoomVisibility(input) ? input : fallback;
}

export function normalizeParticipantId(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const value = input.trim();
  return /^[A-Za-z0-9._:-]{3,128}$/.test(value) ? value : null;
}

export function validateRoomInput(input: Partial<RoomRecord>, templateIds: Set<string>, tenantIds: Set<string>): string | null {
  if (input.roomId !== undefined && (typeof input.roomId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.roomId) || input.roomId.length < 3 || input.roomId.length > 64)) {
    return "invalid_room_slug";
  }
  if (!input.name || input.name.trim().length < 3 || input.name.trim().length > 80) {
    return "invalid_room_name";
  }
  if (!input.templateId || !templateIds.has(input.templateId)) {
    return "invalid_template";
  }
  if (!input.tenantId || !tenantIds.has(input.tenantId)) {
    return "invalid_tenant";
  }
  if (input.visibility !== undefined && !isRoomVisibility(input.visibility)) {
    return "invalid_room_visibility";
  }
  if (input.roomType !== undefined && input.roomType !== "standard" && input.roomType !== "personal") {
    return "invalid_room_type";
  }
  if (input.roomType === "personal" && !normalizeParticipantId(input.ownerParticipantId)) {
    return "missing_personal_room_owner";
  }
  return null;
}

export type RoomPayloadInput = Partial<RoomRecord> & {
  avatarsEnabled?: boolean;
  avatarCatalogUrl?: string;
  avatarQualityProfile?: "mobile-lite" | "desktop-standard" | "xr";
  avatarFallbackCapsulesEnabled?: boolean;
  avatarSeatsEnabled?: boolean;
};

export function normalizeRoomAvatarOverrides(input: RoomPayloadInput): RoomPayloadInput {
  const legacyAvatarConfig: Partial<NonNullable<RoomRecord["avatarConfig"]>> = {
    avatarsEnabled: input.avatarsEnabled,
    avatarCatalogUrl: input.avatarCatalogUrl,
    avatarQualityProfile: input.avatarQualityProfile,
    avatarFallbackCapsulesEnabled: input.avatarFallbackCapsulesEnabled,
    avatarSeatsEnabled: input.avatarSeatsEnabled
  };

  const hasLegacyAvatarField = Object.values(legacyAvatarConfig).some((value) => value !== undefined);

  const normalized: RoomPayloadInput = { ...input };
  delete normalized.avatarsEnabled;
  delete normalized.avatarCatalogUrl;
  delete normalized.avatarQualityProfile;
  delete normalized.avatarFallbackCapsulesEnabled;
  delete normalized.avatarSeatsEnabled;
  if (typeof input.roomId === "string") {
    normalized.roomId = input.roomId.trim() || undefined;
  }
  if (hasLegacyAvatarField) {
    normalized.avatarConfig = {
      ...legacyAvatarConfig,
      ...input.avatarConfig
    } as RoomRecord["avatarConfig"];
  }
  return normalized;
}

export function normalizeRoomPayload(input: RoomPayloadInput, mode: "create" | "patch"): Partial<RoomRecord> {
  const normalized = normalizeRoomAvatarOverrides(input);
  delete normalized.templateVersion;
  delete normalized.templateSnapshot;
  if (input.roomType === "personal") {
    normalized.visibility = "private";
    normalized.guestAllowed = false;
    normalized.templateId = input.templateId ?? "personal-workspace-basic";
  }
  const shouldMaterializeVisibility = mode === "create"
    || input.visibility !== undefined
    || input.roomType !== undefined
    || input.guestAllowed !== undefined;
  if (shouldMaterializeVisibility) {
    normalized.visibility = input.visibility === undefined || isRoomVisibility(input.visibility)
      ? sanitizeRoomVisibility(normalized.visibility ?? input.visibility, input.guestAllowed === false || input.roomType === "personal" ? "private" : "public")
      : input.visibility;
  } else {
    delete normalized.visibility;
  }

  return normalized;
}
