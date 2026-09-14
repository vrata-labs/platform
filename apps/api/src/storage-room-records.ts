import { createHash } from "node:crypto";

import type { RoomTemplateSnapshotV1, RoomTemplateVersionSnapshotV1 } from "@vrata/shared-types";

import type {
  RoomAvatarConfig,
  RoomFeatures,
  RoomPersonalState,
  RoomRecord,
  RoomSessionControlState,
  RoomStatus,
  RoomType,
  RoomVisibility
} from "./storage-contracts.js";
import { isoString } from "./storage-row-mappers.js";

export type RoomRecordWithoutTemplateMetadata = Omit<RoomRecord, "templateVersion" | "templateSnapshot">;

export function defaultAvatarConfig(input?: Partial<RoomAvatarConfig>): RoomAvatarConfig {
  return {
    avatarsEnabled: input?.avatarsEnabled ?? true,
    avatarCatalogUrl: input?.avatarCatalogUrl ?? "/assets/avatars/catalog.v1.json",
    avatarQualityProfile: input?.avatarQualityProfile ?? "desktop-standard",
    avatarFallbackCapsulesEnabled: input?.avatarFallbackCapsulesEnabled ?? true,
    avatarSeatsEnabled: input?.avatarSeatsEnabled ?? true
  };
}

export function defaultRoomType(input?: RoomType): RoomType {
  return input === "personal" ? "personal" : "standard";
}

export function defaultRoomVisibility(input?: RoomVisibility, roomType?: RoomType): RoomVisibility {
  return input === "private" || input === "unlisted" ? input : roomType === "personal" ? "private" : "public";
}

export function defaultGuestAllowed(input: boolean | undefined, roomType?: RoomType): boolean {
  return input ?? roomType !== "personal";
}

export function defaultRoomStatus(input?: RoomStatus): RoomStatus {
  return input === "disabled" ? "disabled" : "active";
}

export function defaultSessionControl(input?: Partial<RoomSessionControlState> | null): RoomSessionControlState {
  return {
    hostParticipantId: input?.hostParticipantId ?? null,
    presenterParticipantId: input?.presenterParticipantId ?? null,
    presenterGrantedAt: input?.presenterGrantedAt ?? null,
    presenterGrantedBy: input?.presenterGrantedBy ?? null,
    presenterRevokedAt: input?.presenterRevokedAt ?? null,
    presenterRevokedBy: input?.presenterRevokedBy ?? null,
    lockedAt: input?.lockedAt ?? null,
    lockedBy: input?.lockedBy ?? null,
    endedAt: input?.endedAt ?? null,
    endedBy: input?.endedBy ?? null,
    removedParticipants: input?.removedParticipants ?? {}
  };
}

export function defaultPersonalState(input?: Partial<RoomPersonalState> | null): RoomPersonalState {
  if (!input?.lastPose) {
    return {};
  }
  return {
    lastPose: {
      position: {
        x: input.lastPose.position.x,
        y: input.lastPose.position.y,
        z: input.lastPose.position.z
      },
      yaw: input.lastPose.yaw,
      pitch: input.lastPose.pitch,
      updatedAt: input.lastPose.updatedAt,
      updatedBy: input.lastPose.updatedBy ?? null
    }
  };
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("template_snapshot_not_json_serializable");
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
}

export function templateVersionContentHash(snapshot: RoomTemplateVersionSnapshotV1): string {
  return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

export interface StoredTemplateVersionRow {
  template_id: string;
  version: string;
  snapshot: unknown;
  content_hash: string;
}

export function parseStoredTemplateVersion(row: StoredTemplateVersionRow): RoomTemplateVersionSnapshotV1 {
  let value = row.snapshot;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new Error(`invalid_template_version_snapshot:${row.template_id}@${row.version}`);
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid_template_version_snapshot:${row.template_id}@${row.version}`);
  }
  const snapshot = value as Partial<RoomTemplateVersionSnapshotV1>;
  if (
    snapshot.schemaVersion !== 1
    || typeof snapshot.templateId !== "string"
    || typeof snapshot.version !== "string"
    || typeof snapshot.label !== "string"
    || !Array.isArray(snapshot.assetSlots)
    || snapshot.assetSlots.some((slot) => typeof slot !== "string")
  ) {
    throw new Error(`invalid_template_version_snapshot:${row.template_id}@${row.version}`);
  }
  if (snapshot.templateId !== row.template_id || snapshot.version !== row.version) {
    throw new Error(`template_version_identity_mismatch:${row.template_id}@${row.version}`);
  }

  const typedSnapshot = snapshot as RoomTemplateVersionSnapshotV1;
  if (templateVersionContentHash(typedSnapshot) !== row.content_hash) {
    throw new Error(`template_version_content_hash_mismatch:${row.template_id}@${row.version}`);
  }
  return structuredClone(typedSnapshot);
}

function createRoomTemplateSnapshot(
  room: RoomRecordWithoutTemplateMetadata,
  versionSnapshot: RoomTemplateVersionSnapshotV1
): RoomTemplateSnapshotV1 {
  const avatarConfig = defaultAvatarConfig(room.avatarConfig);
  return {
    ...structuredClone(versionSnapshot),
    roomConfig: {
      roomType: defaultRoomType(room.roomType),
      visibility: defaultRoomVisibility(room.visibility, room.roomType),
      guestAllowed: defaultGuestAllowed(room.guestAllowed, room.roomType),
      sceneBundleUrl: room.sceneBundleUrl ?? null,
      features: { ...room.features },
      theme: {
        primaryColor: room.theme?.primaryColor ?? "#5fc8ff",
        accentColor: room.theme?.accentColor ?? "#163354"
      },
      avatarConfig
    }
  };
}

export function bindRoomTemplateMetadata(
  room: RoomRecordWithoutTemplateMetadata,
  versionSnapshot: RoomTemplateVersionSnapshotV1
): RoomRecord {
  return {
    ...room,
    templateVersion: versionSnapshot.version,
    templateSnapshot: createRoomTemplateSnapshot(room, versionSnapshot)
  };
}

export function mapRoomRow(row: {
  room_id: string;
  tenant_id: string;
  template_id: string;
  template_version?: string | null;
  template_snapshot?: RoomTemplateSnapshotV1 | null;
  template_version_template_id?: string | null;
  template_version_resolved?: string | null;
  template_version_snapshot?: unknown;
  template_version_content_hash?: string | null;
  name: string;
  room_type?: RoomType;
  owner_participant_id?: string | null;
  status?: RoomStatus;
  disabled_at?: string | Date | null;
  disabled_by?: string | null;
  visibility?: RoomVisibility;
  scene_bundle_url: string | null;
  features: RoomFeatures;
  asset_ids: string[];
  theme: { primaryColor: string; accentColor: string };
  guest_allowed: boolean;
  avatar_config: Partial<RoomAvatarConfig>;
  session_control: Partial<RoomSessionControlState> | null;
  personal_state?: Partial<RoomPersonalState> | null;
}): RoomRecord {
  const roomType = defaultRoomType(row.room_type);
  const room: RoomRecordWithoutTemplateMetadata = {
    roomId: row.room_id,
    tenantId: row.tenant_id,
    templateId: row.template_id,
    name: row.name,
    roomType,
    ownerParticipantId: row.owner_participant_id ?? null,
    status: defaultRoomStatus(row.status),
    disabledAt: isoString(row.disabled_at),
    disabledBy: row.disabled_by ?? null,
    visibility: defaultRoomVisibility(row.visibility, roomType),
    sceneBundleUrl: row.scene_bundle_url ?? undefined,
    features: row.features,
    assetIds: row.asset_ids,
    theme: row.theme,
    guestAllowed: defaultGuestAllowed(row.guest_allowed, roomType),
    avatarConfig: defaultAvatarConfig(row.avatar_config),
    sessionControl: defaultSessionControl(row.session_control),
    personalState: defaultPersonalState(row.personal_state)
  };
  if (
    !row.template_version_template_id
    || !row.template_version_resolved
    || row.template_version_snapshot === undefined
    || row.template_version_snapshot === null
    || !row.template_version_content_hash
  ) {
    throw new Error(`template_version_not_found:${row.template_id}`);
  }
  const versionSnapshot = parseStoredTemplateVersion({
    template_id: row.template_version_template_id,
    version: row.template_version_resolved,
    snapshot: row.template_version_snapshot,
    content_hash: row.template_version_content_hash
  });
  return bindRoomTemplateMetadata(room, versionSnapshot);
}
