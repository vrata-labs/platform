import { createHash } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { getTemplateVersion as getSeedTemplateVersion, listTemplateDefinitions } from "@vrata/templates";
import type { RoomTemplateCatalogRecord, RoomTemplateSnapshotV1, RoomTemplateStatus, RoomTemplateVersionSnapshotV1 } from "@vrata/shared-types";

import type { SceneBundleCreateInput, SceneBundleRecord } from "./scene-bundle-storage.js";

export interface TenantRecord {
  tenantId: string;
  name: string;
}

export interface TemplateRecord extends RoomTemplateCatalogRecord {}

export interface AssetRecord {
  assetId: string;
  tenantId: string;
  kind: string;
  url: string;
  validationStatus?: "pending" | "validated" | "rejected";
  processedUrl?: string;
}

export interface RoomFeatures {
  voice: boolean;
  spatialAudio: boolean;
  screenShare: boolean;
}

export interface RoomAvatarConfig {
  avatarsEnabled: boolean;
  avatarCatalogUrl?: string;
  avatarQualityProfile: "mobile-lite" | "desktop-standard" | "xr";
  avatarFallbackCapsulesEnabled: boolean;
  avatarSeatsEnabled?: boolean;
}

export type RoomVisibility = "public" | "unlisted" | "private";
export type RoomStatus = "active" | "disabled";
export type RoomType = "standard" | "personal";

export interface RoomPersonalPoseState {
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface RoomPersonalState {
  lastPose?: RoomPersonalPoseState | null;
}

export interface RoomInviteRecord {
  inviteId: string;
  roomId: string;
  tokenHash: string;
  role: "guest" | "member" | "presenter" | "host" | "admin";
  waitingRoomEnabled: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  createdBy?: string | null;
  revokedBy?: string | null;
}

export interface WaitingRoomRequestRecord {
  requestId: string;
  roomId: string;
  inviteId: string;
  participantId: string;
  displayName: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
}

export type RoomNoteScope = "shared" | "private";

export interface RoomNoteRecord {
  noteId: string;
  roomId: string;
  scope: RoomNoteScope;
  ownerParticipantId?: string | null;
  content: string;
  updatedAt: string | null;
  updatedBy?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
}

export type RoomNoteVersionAction = "save" | "restore" | "delete";

export interface RoomNoteVersionRecord {
  versionId: string;
  noteId: string;
  roomId: string;
  scope: RoomNoteScope;
  ownerParticipantId?: string | null;
  content: string;
  action: RoomNoteVersionAction;
  restoredFromVersionId?: string | null;
  createdAt: string;
  createdBy?: string | null;
}

export interface RoomDocumentRecord {
  documentId: string;
  roomId: string;
  tenantId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  checksum: string;
  metadata?: RoomDocumentMetadata;
  uploadedBy?: string | null;
  uploadedAt: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  linkedSurfaceId?: string | null;
}

export interface RoomDocumentMetadata {
  kind?: "pdf" | "image" | "video";
  pageCount?: number;
  title?: string | null;
  author?: string | null;
  firstPageWidthPt?: number;
  firstPageHeightPt?: number;
  widthPx?: number;
  heightPx?: number;
  durationMs?: number;
  container?: "mp4" | "webm";
  metadataSource?: "server" | "browser";
}

export interface RoomSessionControlState {
  hostParticipantId?: string | null;
  presenterParticipantId?: string | null;
  presenterGrantedAt?: string | null;
  presenterGrantedBy?: string | null;
  presenterRevokedAt?: string | null;
  presenterRevokedBy?: string | null;
  lockedAt?: string | null;
  lockedBy?: string | null;
  endedAt?: string | null;
  endedBy?: string | null;
  removedParticipants?: Record<string, {
    removedAt: string;
    removedBy?: string | null;
    reason?: string | null;
  }>;
}

const DEFAULT_AVATAR_CONFIG_JSON = '{"avatarsEnabled":true,"avatarCatalogUrl":"/assets/avatars/catalog.v1.json","avatarQualityProfile":"desktop-standard","avatarFallbackCapsulesEnabled":true,"avatarSeatsEnabled":true}' as const;
const DEFAULT_SESSION_CONTROL_JSON = '{"hostParticipantId":null,"presenterParticipantId":null,"presenterGrantedAt":null,"presenterGrantedBy":null,"presenterRevokedAt":null,"presenterRevokedBy":null,"lockedAt":null,"lockedBy":null,"endedAt":null,"endedBy":null,"removedParticipants":{}}' as const;
const DEFAULT_PERSONAL_STATE_JSON = '{}' as const;
const POSTGRES_INIT_MAX_ATTEMPTS = 12;
const POSTGRES_INIT_RETRY_DELAY_MS = 1000;
const RETRYABLE_POSTGRES_INIT_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]);
const POSTGRES_INIT_ADVISORY_LOCK_SQL = "select pg_advisory_lock(hashtextextended('vrata:postgres-storage-init:v1', 0))";
const POSTGRES_INIT_ADVISORY_UNLOCK_SQL = "select pg_advisory_unlock(hashtextextended('vrata:postgres-storage-init:v1', 0)) as unlocked";
const TEMPLATE_VERSION_MUTATION_FUNCTION_NAME = "vrata_reject_template_version_mutation";
const TEMPLATE_VERSION_MUTATION_FUNCTION_SOURCE = `begin
  raise exception 'template_versions_are_immutable' using errcode = '55000';
  return null;
end`;

export interface RoomRecord {
  roomId: string;
  tenantId: string;
  templateId: string;
  templateVersion: string;
  templateSnapshot: RoomTemplateSnapshotV1;
  name: string;
  roomType?: RoomType;
  ownerParticipantId?: string | null;
  status?: RoomStatus;
  disabledAt?: string | null;
  disabledBy?: string | null;
  visibility?: RoomVisibility;
  sceneBundleUrl?: string;
  features: RoomFeatures;
  assetIds: string[];
  theme?: {
    primaryColor: string;
    accentColor: string;
  };
  guestAllowed?: boolean;
  avatarConfig?: RoomAvatarConfig;
  sessionControl?: RoomSessionControlState;
  personalState?: RoomPersonalState;
}

type RoomRecordWithoutTemplateMetadata = Omit<RoomRecord, "templateVersion" | "templateSnapshot">;

type InitializableStorage = { init(): Promise<void> };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const maybeCode = (error as { code?: unknown }).code;
  if (typeof maybeCode === "string") return maybeCode;
  const maybeCause = (error as { cause?: unknown }).cause;
  if (!maybeCause || typeof maybeCause !== "object") return undefined;
  const maybeCauseCode = (maybeCause as { code?: unknown }).code;
  return typeof maybeCauseCode === "string" ? maybeCauseCode : undefined;
}

function isRetryablePostgresInitError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && RETRYABLE_POSTGRES_INIT_ERROR_CODES.has(code)) return true;
  return error instanceof Error && /connect (ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)/.test(error.message);
}

export async function initPostgresStorageWithRetry(
  storage: InitializableStorage,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    onRetry?: (error: unknown, attempt: number, maxAttempts: number, retryDelayMs: number) => void;
    wait?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? POSTGRES_INIT_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? POSTGRES_INIT_RETRY_DELAY_MS));
  const wait = options.wait ?? delay;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await storage.init();
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryablePostgresInitError(error)) {
        throw error;
      }
      options.onRetry?.(error, attempt, maxAttempts, retryDelayMs);
      await wait(retryDelayMs);
    }
  }
}

function defaultAvatarConfig(input?: Partial<RoomAvatarConfig>): RoomAvatarConfig {
  return {
    avatarsEnabled: input?.avatarsEnabled ?? true,
    avatarCatalogUrl: input?.avatarCatalogUrl ?? "/assets/avatars/catalog.v1.json",
    avatarQualityProfile: input?.avatarQualityProfile ?? "desktop-standard",
    avatarFallbackCapsulesEnabled: input?.avatarFallbackCapsulesEnabled ?? true,
    avatarSeatsEnabled: input?.avatarSeatsEnabled ?? true
  };
}

function defaultRoomType(input?: RoomType): RoomType {
  return input === "personal" ? "personal" : "standard";
}

function defaultRoomVisibility(input?: RoomVisibility, roomType?: RoomType): RoomVisibility {
  return input === "private" || input === "unlisted" ? input : roomType === "personal" ? "private" : "public";
}

function defaultGuestAllowed(input: boolean | undefined, roomType?: RoomType): boolean {
  return input ?? roomType !== "personal";
}

function defaultRoomStatus(input?: RoomStatus): RoomStatus {
  return input === "disabled" ? "disabled" : "active";
}

function defaultSessionControl(input?: Partial<RoomSessionControlState> | null): RoomSessionControlState {
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

function defaultPersonalState(input?: Partial<RoomPersonalState> | null): RoomPersonalState {
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

function stableJson(value: unknown): string {
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

function normalizePostgresDefinition(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizePostgresConstraintDefinition(value: string): string {
  return normalizePostgresDefinition(value).replace(/ not valid$/, "");
}

function isExpectedTemplateVersionTriggerDefinition(value: string): boolean {
  const normalized = normalizePostgresDefinition(value).replaceAll('"', "");
  return /^create trigger template_versions_immutable before delete or update on (?:[a-z_][a-z0-9_]*\.)?template_versions for each row execute function (?:[a-z_][a-z0-9_]*\.)?vrata_reject_template_version_mutation\(\);?$/.test(normalized);
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function templateVersionContentHash(snapshot: RoomTemplateVersionSnapshotV1): string {
  return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

interface StoredTemplateVersionRow {
  template_id: string;
  version: string;
  snapshot: unknown;
  content_hash: string;
}

function parseStoredTemplateVersion(row: StoredTemplateVersionRow): RoomTemplateVersionSnapshotV1 {
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

function bindRoomTemplateMetadata(
  room: RoomRecordWithoutTemplateMetadata,
  versionSnapshot: RoomTemplateVersionSnapshotV1
): RoomRecord {
  return {
    ...room,
    templateVersion: versionSnapshot.version,
    templateSnapshot: createRoomTemplateSnapshot(room, versionSnapshot)
  };
}

function isoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function mapRoomInviteRow(row: {
  invite_id: string;
  room_id: string;
  token_hash: string;
  role: RoomInviteRecord["role"];
  waiting_room_enabled: boolean;
  created_at: string | Date;
  expires_at: string | Date;
  revoked_at?: string | Date | null;
  created_by?: string | null;
  revoked_by?: string | null;
}): RoomInviteRecord {
  return {
    inviteId: row.invite_id,
    roomId: row.room_id,
    tokenHash: row.token_hash,
    role: row.role,
    waitingRoomEnabled: row.waiting_room_enabled,
    createdAt: isoString(row.created_at) ?? new Date().toISOString(),
    expiresAt: isoString(row.expires_at) ?? new Date().toISOString(),
    revokedAt: isoString(row.revoked_at),
    createdBy: row.created_by ?? null,
    revokedBy: row.revoked_by ?? null
  };
}

function mapWaitingRoomRequestRow(row: {
  request_id: string;
  room_id: string;
  invite_id: string;
  participant_id: string;
  display_name: string;
  status: WaitingRoomRequestRecord["status"];
  created_at: string | Date;
  decided_at?: string | Date | null;
  decided_by?: string | null;
}): WaitingRoomRequestRecord {
  return {
    requestId: row.request_id,
    roomId: row.room_id,
    inviteId: row.invite_id,
    participantId: row.participant_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: isoString(row.created_at) ?? new Date().toISOString(),
    decidedAt: isoString(row.decided_at),
    decidedBy: row.decided_by ?? null
  };
}

function mapRoomNoteRow(row: {
  note_id: string;
  room_id: string;
  scope: RoomNoteScope;
  owner_participant_id?: string | null;
  content: string;
  updated_at: string | Date;
  updated_by?: string | null;
  deleted_at?: string | Date | null;
  deleted_by?: string | null;
}): RoomNoteRecord {
  return {
    noteId: row.note_id,
    roomId: row.room_id,
    scope: row.scope,
    ownerParticipantId: row.owner_participant_id ?? null,
    content: row.content,
    updatedAt: isoString(row.updated_at) ?? new Date().toISOString(),
    updatedBy: row.updated_by ?? null,
    deletedAt: isoString(row.deleted_at),
    deletedBy: row.deleted_by ?? null
  };
}

function mapRoomNoteVersionRow(row: {
  version_id: string;
  note_id: string;
  room_id: string;
  scope: RoomNoteScope;
  owner_participant_id?: string | null;
  content: string;
  action: RoomNoteVersionAction;
  restored_from_version_id?: string | null;
  created_at: string | Date;
  created_by?: string | null;
}): RoomNoteVersionRecord {
  return {
    versionId: row.version_id,
    noteId: row.note_id,
    roomId: row.room_id,
    scope: row.scope,
    ownerParticipantId: row.owner_participant_id ?? null,
    content: row.content,
    action: row.action,
    restoredFromVersionId: row.restored_from_version_id ?? null,
    createdAt: isoString(row.created_at) ?? new Date().toISOString(),
    createdBy: row.created_by ?? null
  };
}

function roomNoteId(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null): string {
  return scope === "shared" ? `${roomId}:shared` : `${roomId}:private:${ownerParticipantId ?? ""}`;
}

function mapRoomDocumentRow(row: {
  document_id: string;
  room_id: string;
  tenant_id: string;
  filename: string;
  content_type: string;
  size_bytes: string | number;
  storage_key: string;
  checksum: string;
  uploaded_by?: string | null;
  uploaded_at: string | Date;
  deleted_at?: string | Date | null;
  deleted_by?: string | null;
  linked_surface_id?: string | null;
  metadata?: RoomDocumentMetadata | null;
}): RoomDocumentRecord {
  return {
    documentId: row.document_id,
    roomId: row.room_id,
    tenantId: row.tenant_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    storageKey: row.storage_key,
    checksum: row.checksum,
    metadata: row.metadata ?? {},
    uploadedBy: row.uploaded_by ?? null,
    uploadedAt: isoString(row.uploaded_at) ?? new Date().toISOString(),
    deletedAt: isoString(row.deleted_at),
    deletedBy: row.deleted_by ?? null,
    linkedSurfaceId: row.linked_surface_id ?? null
  };
}

function mapRoomRow(row: {
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

export interface RuntimeDiagnosticRecord {
  reportId?: string;
  requestId?: string;
  participantId: string;
  displayName: string;
  mode: "desktop" | "mobile" | "vr";
  userAgent: string;
  locomotionMode: string;
  audioState: string;
  localPosition: { x: number; z: number };
  xrAxes: { moveX: number; moveY: number; turnX: number; turnY?: number };
  remoteAvatarCount: number;
  remoteTargets: Array<{ id: string; x: number; z: number }>;
  lastPresenceSyncAt: number;
  lastPresenceRefreshAt: number;
  issueCode?: string | null;
  issueSeverity?: string | null;
  degradedMode?: string;
  retryCount?: number;
  lastRecoveryAction?: string;
  featureFlags?: Record<string, unknown>;
  faultInjection?: Record<string, unknown>;
  avatarDebug?: {
    state?: string;
    catalogId?: string | null;
    packUrl?: string | null;
    packFormat?: string | null;
    presetCount?: number;
    selectedAvatarId?: string | null;
    fallbackActive?: boolean;
    fallbackReason?: string | null;
    sandboxEntryPoint?: string | null;
    validatorSummary?: string[];
  };
  sceneDebug?: {
    bundleUrl?: string | null;
    state?: string;
    failureReason?: string | null;
    loadStage?: string | null;
    assetBytesLoaded?: number | null;
    assetBytesExpected?: number | null;
    label?: string;
    source?: string;
    assetUrl?: string | null;
    assetType?: string | null;
    spawnPointId?: string | null;
    spawnApplied?: boolean;
    loadMs?: number;
    objectCount?: number;
    meshCount?: number;
    materialCount?: number;
    texturedMaterialCount?: number;
    geometryCount?: number;
    triangleEstimate?: number;
    textureCount?: number;
    materialSamples?: Array<{
      name: string;
      meshCount: number;
      hasMap: boolean;
      hasNormalMap: boolean;
      hasAoMap: boolean;
      color?: { r: number; g: number; b: number } | null;
      mapSource?: string | null;
    }>;
    missingAssetCount?: number;
    missingAssets?: string[];
    boundingBox?: {
      min: { x: number; y: number; z: number };
      max: { x: number; y: number; z: number };
      size: { x: number; y: number; z: number };
      center: { x: number; y: number; z: number };
    };
    camera?: {
      world: { x: number; y: number; z: number };
      forward: { x: number; y: number; z: number };
    };
    screenshot?: {
      width: number;
      height: number;
      centerPixel: { r: number; g: number; b: number; a: number };
      averageColor: { r: number; g: number; b: number; a: number };
      darkPixelRatio: number;
      pixelSamples: Array<{ x: number; y: number; r: number; g: number; b: number; a: number }>;
      dataUrl?: string;
    };
  };
  note?: string;
  createdAt: string;
}

export interface XrTelemetryEventRecord {
  participantId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const XR_TELEMETRY_EVENT_LIMIT = 1000;

export interface Storage {
  listTenants(): Promise<TenantRecord[]>;
  createTenant(input: Partial<TenantRecord>): Promise<TenantRecord>;
  updateTenant(tenantId: string, input: Partial<TenantRecord>): Promise<TenantRecord | null>;
  deleteTenant(tenantId: string): Promise<boolean>;
  listTemplates(): Promise<TemplateRecord[]>;
  getTemplateVersion(templateId: string, version?: string): Promise<RoomTemplateVersionSnapshotV1 | null>;
  listAssets(): Promise<AssetRecord[]>;
  listRooms(): Promise<RoomRecord[]>;
  getRoom(roomId: string): Promise<RoomRecord | null>;
  createRoom(input: Partial<RoomRecord>): Promise<RoomRecord>;
  updateRoom(roomId: string, input: Partial<RoomRecord>, expectedTemplateBinding?: ExpectedRoomTemplateBinding): Promise<RoomRecord | null>;
  deleteRoom(roomId: string): Promise<boolean>;
  createRoomInvite(input: Omit<RoomInviteRecord, "inviteId" | "createdAt" | "revokedAt" | "revokedBy"> & { inviteId?: string; createdAt?: string }): Promise<RoomInviteRecord>;
  listRoomInvites(roomId: string): Promise<RoomInviteRecord[]>;
  getRoomInvite(inviteId: string): Promise<RoomInviteRecord | null>;
  getRoomInviteByTokenHash(tokenHash: string): Promise<RoomInviteRecord | null>;
  revokeRoomInvite(roomId: string, inviteId: string, revokedAt: string, revokedBy?: string | null): Promise<RoomInviteRecord | null>;
  createWaitingRoomRequest(input: Omit<WaitingRoomRequestRecord, "requestId" | "createdAt" | "status" | "decidedAt" | "decidedBy"> & { requestId?: string; createdAt?: string; status?: WaitingRoomRequestRecord["status"] }): Promise<WaitingRoomRequestRecord>;
  listWaitingRoomRequests(roomId: string): Promise<WaitingRoomRequestRecord[]>;
  getWaitingRoomRequest(requestId: string): Promise<WaitingRoomRequestRecord | null>;
  getWaitingRoomRequestForInviteParticipant(inviteId: string, participantId: string): Promise<WaitingRoomRequestRecord | null>;
  updateWaitingRoomRequest(roomId: string, requestId: string, input: Partial<Pick<WaitingRoomRequestRecord, "status" | "decidedAt" | "decidedBy">>): Promise<WaitingRoomRequestRecord | null>;
  getRoomNote(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null): Promise<RoomNoteRecord | null>;
  upsertRoomNote(input: Pick<RoomNoteRecord, "roomId" | "scope" | "content"> & { ownerParticipantId?: string | null; updatedBy?: string | null }): Promise<RoomNoteRecord>;
  deleteRoomNote(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null, deletedBy?: string | null): Promise<RoomNoteRecord | null>;
  listRoomNotes(roomId: string, includeDeleted?: boolean): Promise<RoomNoteRecord[]>;
  listRoomNoteVersions(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null, limit?: number): Promise<RoomNoteVersionRecord[]>;
  restoreRoomNoteVersion(roomId: string, scope: RoomNoteScope, ownerParticipantId: string | null | undefined, versionId: string, updatedBy?: string | null): Promise<{ note: RoomNoteRecord; version: RoomNoteVersionRecord } | null>;
  listRoomDocuments(roomId: string, includeDeleted?: boolean): Promise<RoomDocumentRecord[]>;
  getRoomDocument(roomId: string, documentId: string): Promise<RoomDocumentRecord | null>;
  createRoomDocument(input: Omit<RoomDocumentRecord, "uploadedAt" | "deletedAt" | "deletedBy" | "linkedSurfaceId"> & { uploadedAt?: string; linkedSurfaceId?: string | null }): Promise<RoomDocumentRecord>;
  markRoomDocumentDeleted(roomId: string, documentId: string, deletedAt: string, deletedBy?: string | null): Promise<RoomDocumentRecord | null>;
  updateRoomDocumentSurface(roomId: string, documentId: string, linkedSurfaceId: string | null): Promise<RoomDocumentRecord | null>;
  createAsset(input: Partial<AssetRecord>): Promise<AssetRecord>;
  updateAsset(assetId: string, input: Partial<AssetRecord>): Promise<AssetRecord | null>;
  deleteAsset(assetId: string): Promise<boolean>;
  addDiagnostic(roomId: string, payload: RuntimeDiagnosticRecord): Promise<void>;
  getDiagnostics(roomId: string): Promise<RuntimeDiagnosticRecord[]>;
  addXrTelemetry(roomId: string, participantId: string, payload: Record<string, unknown>): Promise<void>;
  getXrTelemetry(roomId: string): Promise<XrTelemetryEventRecord[]>;
  listSceneBundles(): Promise<SceneBundleRecord[]>;
  getSceneBundle(bundleId: string): Promise<SceneBundleRecord | null>;
  createSceneBundle(input: SceneBundleCreateInput & { publicUrl: string; provider: SceneBundleRecord["provider"] }): Promise<SceneBundleRecord>;
  updateSceneBundle(bundleId: string, input: SceneBundleUpdateInput): Promise<SceneBundleRecord | null>;
  listSceneBundleVersions(bundleId: string): Promise<SceneBundleRecord[]>;
  setCurrentSceneBundleVersion(bundleId: string, version: string): Promise<SceneBundleRecord | null>;
}

export interface ExpectedRoomTemplateBinding {
  templateId: string;
  templateVersion: string;
}

export type SceneBundleUpdateInput = Partial<SceneBundleCreateInput> & {
  publicUrl?: string;
  provider?: SceneBundleRecord["provider"];
  status?: SceneBundleRecord["status"];
  isCurrent?: boolean;
};

const seedTemplateDefinitions = listTemplateDefinitions();
const defaultTemplates: TemplateRecord[] = seedTemplateDefinitions.map((definition) => ({
  templateId: definition.id,
  label: definition.label,
  assetSlots: [...definition.assetSlots],
  currentVersion: definition.version,
  status: definition.status
}));
const defaultTemplateVersions = seedTemplateDefinitions.map((definition) => {
  const snapshot = getSeedTemplateVersion(definition.id, definition.version);
  if (!snapshot) throw new Error(`missing_seed_template_version:${definition.id}@${definition.version}`);
  return snapshot;
});
const seedTemplateOrder = new Map(seedTemplateDefinitions.map((definition, index) => [definition.id, index]));

function sortTemplateRecords<T extends { templateId: string }>(records: T[]): T[] {
  return records.sort((left, right) => {
    const leftIndex = seedTemplateOrder.get(left.templateId) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = seedTemplateOrder.get(right.templateId) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.templateId < right.templateId ? -1 : left.templateId > right.templateId ? 1 : 0;
  });
}

function normalizeStoredTemplateStatus(templateId: string, status: string | null): RoomTemplateStatus {
  if (status === null || status === "active") return "active";
  if (status === "deprecated") return "deprecated";
  throw new Error(`unsupported_template_status:${templateId}:${status}`);
}

function templateVersionKey(templateId: string, version: string): string {
  return `${templateId}::${version}`;
}

function createDefaultDemoRoom(): RoomRecord {
  const versionSnapshot = defaultTemplateVersions.find((snapshot) => snapshot.templateId === "meeting-room-basic");
  if (!versionSnapshot) throw new Error("missing_seed_template_version:meeting-room-basic@0.1.0");
  return bindRoomTemplateMetadata({
    roomId: "demo-room",
    tenantId: "demo-tenant",
    templateId: "meeting-room-basic",
    name: "Demo Room",
    roomType: "standard",
    ownerParticipantId: null,
    status: "active",
    disabledAt: null,
    disabledBy: null,
    visibility: "public",
    sceneBundleUrl: undefined,
    features: { voice: true, spatialAudio: true, screenShare: true },
    assetIds: [],
    theme: {
      primaryColor: "#5fc8ff",
      accentColor: "#163354"
    },
    guestAllowed: true,
    avatarConfig: defaultAvatarConfig(),
    sessionControl: defaultSessionControl(),
    personalState: defaultPersonalState()
  }, versionSnapshot);
}

export class MemoryStorage implements Storage {
  private tenants = new Map<string, TenantRecord>([["demo-tenant", { tenantId: "demo-tenant", name: "Demo Tenant" }]]);
  private templates = new Map<string, TemplateRecord>(defaultTemplates.map((item) => [item.templateId, structuredClone(item)]));
  private templateVersions = new Map<string, RoomTemplateVersionSnapshotV1>(defaultTemplateVersions.map((item) => [templateVersionKey(item.templateId, item.version), structuredClone(item)]));
  private assets = new Map<string, AssetRecord>();
  private roomDocuments = new Map<string, RoomDocumentRecord>();
  private rooms = new Map<string, RoomRecord>([
    ["demo-room", createDefaultDemoRoom()]
  ]);
  private diagnostics = new Map<string, RuntimeDiagnosticRecord[]>();
  private xrTelemetry = new Map<string, XrTelemetryEventRecord[]>();
  private sceneBundles = new Map<string, SceneBundleRecord>();
  private roomInvites = new Map<string, RoomInviteRecord>();
  private waitingRoomRequests = new Map<string, WaitingRoomRequestRecord>();
  private roomNotes = new Map<string, RoomNoteRecord>();
  private roomNoteVersions = new Map<string, RoomNoteVersionRecord[]>();

  private sceneBundleKey(bundleId: string, version: string): string {
    return `${bundleId}::${version}`;
  }

  private requireTemplateVersion(templateId: string, version?: string): RoomTemplateVersionSnapshotV1 {
    const template = this.templates.get(templateId);
    const resolvedVersion = version ?? template?.currentVersion;
    const snapshot = resolvedVersion ? this.templateVersions.get(templateVersionKey(templateId, resolvedVersion)) : undefined;
    if (!snapshot) throw new Error(`template_version_not_found:${templateId}`);
    return structuredClone(snapshot);
  }

  async listTenants(): Promise<TenantRecord[]> { return Array.from(this.tenants.values()); }
  async createTenant(input: Partial<TenantRecord>): Promise<TenantRecord> {
    const tenant = { tenantId: input.tenantId ?? crypto.randomUUID(), name: input.name ?? "New Tenant" };
    this.tenants.set(tenant.tenantId, tenant);
    return tenant;
  }
  async updateTenant(tenantId: string, input: Partial<TenantRecord>): Promise<TenantRecord | null> {
    const existing = this.tenants.get(tenantId);
    if (!existing) return null;
    const updated = { ...existing, ...input, tenantId };
    this.tenants.set(tenantId, updated);
    return updated;
  }
  async deleteTenant(tenantId: string): Promise<boolean> {
    for (const room of this.rooms.values()) {
      if (room.tenantId === tenantId) return false;
    }
    for (const asset of this.assets.values()) {
      if (asset.tenantId === tenantId) return false;
    }
    return this.tenants.delete(tenantId);
  }
  async listTemplates(): Promise<TemplateRecord[]> {
    return sortTemplateRecords(Array.from(this.templates.values(), (template) => {
      const snapshot = this.requireTemplateVersion(template.templateId, template.currentVersion);
      return {
        ...structuredClone(template),
        label: snapshot.label,
        assetSlots: [...snapshot.assetSlots]
      };
    }));
  }
  async getTemplateVersion(templateId: string, version?: string): Promise<RoomTemplateVersionSnapshotV1 | null> {
    const resolvedVersion = version ?? this.templates.get(templateId)?.currentVersion;
    if (!resolvedVersion) return null;
    const snapshot = this.templateVersions.get(templateVersionKey(templateId, resolvedVersion));
    return snapshot ? structuredClone(snapshot) : null;
  }
  async listAssets(): Promise<AssetRecord[]> { return Array.from(this.assets.values()); }
  async listRooms(): Promise<RoomRecord[]> { return Array.from(this.rooms.values(), (room) => structuredClone(room)); }
  async getRoom(roomId: string): Promise<RoomRecord | null> {
    const room = this.rooms.get(roomId);
    return room ? structuredClone(room) : null;
  }
  async createRoom(input: Partial<RoomRecord>): Promise<RoomRecord> {
    const roomType = defaultRoomType(input.roomType);
    const roomWithoutTemplateMetadata: RoomRecordWithoutTemplateMetadata = {
      roomId: input.roomId ?? crypto.randomUUID(),
      tenantId: input.tenantId ?? "demo-tenant",
      templateId: input.templateId ?? (roomType === "personal" ? "personal-workspace-basic" : "meeting-room-basic"),
      name: input.name ?? "New Room",
      roomType,
      ownerParticipantId: input.ownerParticipantId ?? null,
      status: defaultRoomStatus(input.status),
      disabledAt: input.disabledAt ?? null,
      disabledBy: input.disabledBy ?? null,
      visibility: defaultRoomVisibility(input.visibility, roomType),
      sceneBundleUrl: input.sceneBundleUrl,
      features: {
        voice: input.features?.voice ?? true,
        spatialAudio: input.features?.spatialAudio ?? true,
        screenShare: input.features?.screenShare ?? true
      },
      assetIds: input.assetIds ?? [],
      theme: input.theme ?? {
        primaryColor: "#5fc8ff",
        accentColor: "#163354"
      },
      guestAllowed: defaultGuestAllowed(input.guestAllowed, roomType),
      avatarConfig: defaultAvatarConfig(input.avatarConfig),
      sessionControl: defaultSessionControl(input.sessionControl),
      personalState: defaultPersonalState(input.personalState)
    };
    const room = bindRoomTemplateMetadata(roomWithoutTemplateMetadata, this.requireTemplateVersion(roomWithoutTemplateMetadata.templateId));
    this.rooms.set(room.roomId, structuredClone(room));
    return structuredClone(room);
  }
  async updateRoom(roomId: string, input: Partial<RoomRecord>, expectedTemplateBinding?: ExpectedRoomTemplateBinding): Promise<RoomRecord | null> {
    const existing = this.rooms.get(roomId);
    if (!existing) {
      return null;
    }
    if (
      expectedTemplateBinding
      && (existing.templateId !== expectedTemplateBinding.templateId || existing.templateVersion !== expectedTemplateBinding.templateVersion)
    ) {
      throw new Error("room_template_binding_changed");
    }
    const { templateVersion: _inputTemplateVersion, templateSnapshot: _inputTemplateSnapshot, ...safeInput } = input;
    const { templateVersion: _existingTemplateVersion, templateSnapshot: _existingTemplateSnapshot, ...existingWithoutTemplateMetadata } = existing;
    const updatedWithoutTemplateMetadata: RoomRecordWithoutTemplateMetadata = {
      ...existingWithoutTemplateMetadata,
      ...safeInput,
      roomType: defaultRoomType(input.roomType ?? existing.roomType),
      ownerParticipantId: input.ownerParticipantId !== undefined ? input.ownerParticipantId : existing.ownerParticipantId ?? null,
      status: defaultRoomStatus(input.status ?? existing.status),
      disabledAt: input.disabledAt !== undefined ? input.disabledAt : existing.disabledAt ?? null,
      disabledBy: input.disabledBy !== undefined ? input.disabledBy : existing.disabledBy ?? null,
      features: {
        ...existing.features,
        ...input.features
      },
      theme: {
        primaryColor: input.theme?.primaryColor ?? existing.theme?.primaryColor ?? "#5fc8ff",
        accentColor: input.theme?.accentColor ?? existing.theme?.accentColor ?? "#163354"
      },
      assetIds: input.assetIds ?? existing.assetIds,
      visibility: defaultRoomVisibility(input.visibility ?? existing.visibility, input.roomType ?? existing.roomType),
      guestAllowed: defaultGuestAllowed(input.guestAllowed ?? existing.guestAllowed, input.roomType ?? existing.roomType),
      avatarConfig: defaultAvatarConfig({
        ...existing.avatarConfig,
        ...input.avatarConfig
      }),
      sessionControl: defaultSessionControl(input.sessionControl ?? existing.sessionControl),
      personalState: defaultPersonalState(input.personalState ?? existing.personalState)
    };
    const preservedVersion = updatedWithoutTemplateMetadata.templateId === existing.templateId ? existing.templateVersion : undefined;
    const updated = bindRoomTemplateMetadata(
      updatedWithoutTemplateMetadata,
      this.requireTemplateVersion(updatedWithoutTemplateMetadata.templateId, preservedVersion)
    );
    this.rooms.set(roomId, structuredClone(updated));
    return structuredClone(updated);
  }
  async deleteRoom(roomId: string): Promise<boolean> {
    return this.rooms.delete(roomId);
  }
  async createRoomInvite(input: Omit<RoomInviteRecord, "inviteId" | "createdAt" | "revokedAt" | "revokedBy"> & { inviteId?: string; createdAt?: string }): Promise<RoomInviteRecord> {
    const invite: RoomInviteRecord = {
      inviteId: input.inviteId ?? crypto.randomUUID(),
      roomId: input.roomId,
      tokenHash: input.tokenHash,
      role: input.role,
      waitingRoomEnabled: input.waitingRoomEnabled,
      createdAt: input.createdAt ?? new Date().toISOString(),
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdBy: input.createdBy ?? null,
      revokedBy: null
    };
    this.roomInvites.set(invite.inviteId, invite);
    return invite;
  }
  async listRoomInvites(roomId: string): Promise<RoomInviteRecord[]> {
    return Array.from(this.roomInvites.values()).filter((invite) => invite.roomId === roomId);
  }
  async getRoomInvite(inviteId: string): Promise<RoomInviteRecord | null> {
    return this.roomInvites.get(inviteId) ?? null;
  }
  async getRoomInviteByTokenHash(tokenHash: string): Promise<RoomInviteRecord | null> {
    return Array.from(this.roomInvites.values()).find((invite) => invite.tokenHash === tokenHash) ?? null;
  }
  async revokeRoomInvite(roomId: string, inviteId: string, revokedAt: string, revokedBy?: string | null): Promise<RoomInviteRecord | null> {
    const invite = this.roomInvites.get(inviteId);
    if (!invite || invite.roomId !== roomId) return null;
    const updated = { ...invite, revokedAt, revokedBy: revokedBy ?? null };
    this.roomInvites.set(inviteId, updated);
    return updated;
  }
  async createWaitingRoomRequest(input: Omit<WaitingRoomRequestRecord, "requestId" | "createdAt" | "status" | "decidedAt" | "decidedBy"> & { requestId?: string; createdAt?: string; status?: WaitingRoomRequestRecord["status"] }): Promise<WaitingRoomRequestRecord> {
    const request: WaitingRoomRequestRecord = {
      requestId: input.requestId ?? crypto.randomUUID(),
      roomId: input.roomId,
      inviteId: input.inviteId,
      participantId: input.participantId,
      displayName: input.displayName,
      status: input.status ?? "pending",
      createdAt: input.createdAt ?? new Date().toISOString(),
      decidedAt: null,
      decidedBy: null
    };
    this.waitingRoomRequests.set(request.requestId, request);
    return request;
  }
  async listWaitingRoomRequests(roomId: string): Promise<WaitingRoomRequestRecord[]> {
    return Array.from(this.waitingRoomRequests.values()).filter((request) => request.roomId === roomId);
  }
  async getWaitingRoomRequest(requestId: string): Promise<WaitingRoomRequestRecord | null> {
    return this.waitingRoomRequests.get(requestId) ?? null;
  }
  async getWaitingRoomRequestForInviteParticipant(inviteId: string, participantId: string): Promise<WaitingRoomRequestRecord | null> {
    return Array.from(this.waitingRoomRequests.values()).find((request) => request.inviteId === inviteId && request.participantId === participantId) ?? null;
  }
  async updateWaitingRoomRequest(roomId: string, requestId: string, input: Partial<Pick<WaitingRoomRequestRecord, "status" | "decidedAt" | "decidedBy">>): Promise<WaitingRoomRequestRecord | null> {
    const existing = this.waitingRoomRequests.get(requestId);
    if (!existing || existing.roomId !== roomId) return null;
    const updated = { ...existing, ...input };
    this.waitingRoomRequests.set(requestId, updated);
    return updated;
  }
  async getRoomNote(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null): Promise<RoomNoteRecord | null> {
    const note = this.roomNotes.get(roomNoteId(roomId, scope, ownerParticipantId));
    return note ? structuredClone(note) : null;
  }
  async upsertRoomNote(input: Pick<RoomNoteRecord, "roomId" | "scope" | "content"> & { ownerParticipantId?: string | null; updatedBy?: string | null }): Promise<RoomNoteRecord> {
    const note: RoomNoteRecord = {
      noteId: roomNoteId(input.roomId, input.scope, input.ownerParticipantId),
      roomId: input.roomId,
      scope: input.scope,
      ownerParticipantId: input.scope === "private" ? input.ownerParticipantId ?? null : null,
      content: input.content,
      updatedAt: new Date().toISOString(),
      updatedBy: input.updatedBy ?? null,
      deletedAt: null,
      deletedBy: null
    };
    this.roomNotes.set(note.noteId, note);
    this.appendRoomNoteVersion(note, "save", input.updatedBy ?? null);
    return structuredClone(note);
  }
  async deleteRoomNote(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null, deletedBy?: string | null): Promise<RoomNoteRecord | null> {
    const existing = this.roomNotes.get(roomNoteId(roomId, scope, ownerParticipantId));
    if (!existing || existing.deletedAt) return null;
    const deleted: RoomNoteRecord = {
      ...existing,
      updatedAt: new Date().toISOString(),
      updatedBy: deletedBy ?? null,
      deletedAt: new Date().toISOString(),
      deletedBy: deletedBy ?? null
    };
    this.roomNotes.set(deleted.noteId, deleted);
    this.appendRoomNoteVersion(deleted, "delete", deletedBy ?? null);
    return structuredClone(deleted);
  }
  async listRoomNotes(roomId: string, includeDeleted = false): Promise<RoomNoteRecord[]> {
    return Array.from(this.roomNotes.values())
      .filter((note) => note.roomId === roomId && (includeDeleted || !note.deletedAt))
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .map((note) => structuredClone(note));
  }
  async listRoomNoteVersions(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null, limit = 20): Promise<RoomNoteVersionRecord[]> {
    const noteId = roomNoteId(roomId, scope, ownerParticipantId);
    return (this.roomNoteVersions.get(noteId) ?? [])
      .slice(0, Math.max(1, Math.min(100, Math.floor(limit))))
      .map((version) => structuredClone(version));
  }
  async restoreRoomNoteVersion(roomId: string, scope: RoomNoteScope, ownerParticipantId: string | null | undefined, versionId: string, updatedBy?: string | null): Promise<{ note: RoomNoteRecord; version: RoomNoteVersionRecord } | null> {
    const noteId = roomNoteId(roomId, scope, ownerParticipantId);
    const source = (this.roomNoteVersions.get(noteId) ?? []).find((version) => version.versionId === versionId);
    if (!source) return null;
    const note: RoomNoteRecord = {
      noteId,
      roomId,
      scope,
      ownerParticipantId: scope === "private" ? ownerParticipantId ?? null : null,
      content: source.content,
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy ?? null,
      deletedAt: null,
      deletedBy: null
    };
    this.roomNotes.set(noteId, note);
    const version = this.appendRoomNoteVersion(note, "restore", updatedBy ?? null, source.versionId);
    return { note: structuredClone(note), version: structuredClone(version) };
  }
  private appendRoomNoteVersion(note: RoomNoteRecord, action: RoomNoteVersionAction, createdBy?: string | null, restoredFromVersionId?: string | null): RoomNoteVersionRecord {
    const version: RoomNoteVersionRecord = {
      versionId: crypto.randomUUID(),
      noteId: note.noteId,
      roomId: note.roomId,
      scope: note.scope,
      ownerParticipantId: note.ownerParticipantId ?? null,
      content: note.content,
      action,
      restoredFromVersionId: restoredFromVersionId ?? null,
      createdAt: new Date().toISOString(),
      createdBy: createdBy ?? null
    };
    this.roomNoteVersions.set(note.noteId, [version, ...(this.roomNoteVersions.get(note.noteId) ?? [])]);
    return version;
  }
  async listRoomDocuments(roomId: string, includeDeleted = false): Promise<RoomDocumentRecord[]> {
    return Array.from(this.roomDocuments.values())
      .filter((document) => document.roomId === roomId && (includeDeleted || !document.deletedAt))
      .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))
      .map((document) => structuredClone(document));
  }
  async getRoomDocument(roomId: string, documentId: string): Promise<RoomDocumentRecord | null> {
    const document = this.roomDocuments.get(documentId);
    return document && document.roomId === roomId ? structuredClone(document) : null;
  }
  async createRoomDocument(input: Omit<RoomDocumentRecord, "uploadedAt" | "deletedAt" | "deletedBy" | "linkedSurfaceId"> & { uploadedAt?: string; linkedSurfaceId?: string | null }): Promise<RoomDocumentRecord> {
    const document: RoomDocumentRecord = {
      ...input,
      uploadedAt: input.uploadedAt ?? new Date().toISOString(),
      deletedAt: null,
      deletedBy: null,
      linkedSurfaceId: input.linkedSurfaceId ?? null,
      metadata: structuredClone(input.metadata ?? {})
    };
    this.roomDocuments.set(document.documentId, document);
    return structuredClone(document);
  }
  async markRoomDocumentDeleted(roomId: string, documentId: string, deletedAt: string, deletedBy?: string | null): Promise<RoomDocumentRecord | null> {
    const existing = this.roomDocuments.get(documentId);
    if (!existing || existing.roomId !== roomId) return null;
    const updated = { ...existing, deletedAt, deletedBy: deletedBy ?? null, linkedSurfaceId: null };
    this.roomDocuments.set(documentId, updated);
    return structuredClone(updated);
  }
  async updateRoomDocumentSurface(roomId: string, documentId: string, linkedSurfaceId: string | null): Promise<RoomDocumentRecord | null> {
    const existing = this.roomDocuments.get(documentId);
    if (!existing || existing.roomId !== roomId || existing.deletedAt) return null;
    if (linkedSurfaceId) {
      for (const [otherDocumentId, document] of this.roomDocuments.entries()) {
        if (otherDocumentId !== documentId && document.roomId === roomId && !document.deletedAt && document.linkedSurfaceId === linkedSurfaceId) {
          this.roomDocuments.set(otherDocumentId, { ...document, linkedSurfaceId: null });
        }
      }
    }
    const updated = { ...existing, linkedSurfaceId };
    this.roomDocuments.set(documentId, updated);
    return structuredClone(updated);
  }
  async createAsset(input: Partial<AssetRecord>): Promise<AssetRecord> {
    const asset = {
      assetId: input.assetId ?? crypto.randomUUID(),
      tenantId: input.tenantId ?? "demo-tenant",
      kind: input.kind ?? "logo",
      url: input.url ?? "/assets/demo/placeholder.glb",
      validationStatus: input.validationStatus ?? "validated",
      processedUrl: input.processedUrl ?? input.url ?? "/assets/demo/placeholder.glb"
    };
    this.assets.set(asset.assetId, asset);
    return asset;
  }
  async updateAsset(assetId: string, input: Partial<AssetRecord>): Promise<AssetRecord | null> {
    const existing = this.assets.get(assetId);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...input,
      assetId,
      validationStatus: input.validationStatus ?? existing.validationStatus ?? "validated",
      processedUrl: input.processedUrl ?? existing.processedUrl ?? input.url ?? existing.url
    };
    this.assets.set(assetId, updated);
    return updated;
  }
  async deleteAsset(assetId: string): Promise<boolean> {
    for (const room of this.rooms.values()) {
      if (room.assetIds.includes(assetId)) return false;
    }
    return this.assets.delete(assetId);
  }
  async addDiagnostic(roomId: string, payload: RuntimeDiagnosticRecord): Promise<void> {
    const entries = this.diagnostics.get(roomId) ?? [];
    entries.push(payload);
    while (entries.length > 200) entries.shift();
    this.diagnostics.set(roomId, entries);
  }
  async getDiagnostics(roomId: string): Promise<RuntimeDiagnosticRecord[]> { return this.diagnostics.get(roomId) ?? []; }
  async addXrTelemetry(roomId: string, participantId: string, payload: Record<string, unknown>): Promise<void> {
    const entries = this.xrTelemetry.get(roomId) ?? [];
    entries.push({
      participantId,
      payload: structuredClone(payload),
      createdAt: new Date().toISOString()
    });
    while (entries.length > XR_TELEMETRY_EVENT_LIMIT) entries.shift();
    this.xrTelemetry.set(roomId, entries);
  }
  async getXrTelemetry(roomId: string): Promise<XrTelemetryEventRecord[]> {
    return (this.xrTelemetry.get(roomId) ?? []).map((entry) => structuredClone(entry));
  }
  async listSceneBundles(): Promise<SceneBundleRecord[]> {
    const latest = new Map<string, SceneBundleRecord>();
    for (const item of this.sceneBundles.values()) {
      const existing = latest.get(item.bundleId);
      if (!existing || item.isCurrent || item.createdAt > existing.createdAt) {
        latest.set(item.bundleId, item);
      }
    }
    return Array.from(latest.values());
  }
  async getSceneBundle(bundleId: string): Promise<SceneBundleRecord | null> {
    return (await this.listSceneBundleVersions(bundleId)).find((item) => item.isCurrent) ?? null;
  }
  async createSceneBundle(input: SceneBundleCreateInput & { publicUrl: string; provider: SceneBundleRecord["provider"] }): Promise<SceneBundleRecord> {
    const bundleId = input.bundleId ?? crypto.randomUUID();
    const version = input.version ?? "v1";
    if (this.sceneBundles.has(this.sceneBundleKey(bundleId, version))) {
      throw new Error("scene_bundle_version_conflict");
    }
    const record: SceneBundleRecord = {
      bundleId,
      storageKey: input.storageKey,
      publicUrl: input.publicUrl,
      checksum: input.checksum,
      sizeBytes: input.sizeBytes,
      schemaVersion: input.schemaVersion,
      entryScene: input.entryScene,
      previewUrl: input.previewUrl,
      createdBy: input.createdBy,
      contentType: input.contentType ?? "application/json",
      provider: input.provider,
      version,
      status: "active",
      isCurrent: true,
      createdAt: new Date().toISOString()
    };
    for (const item of this.sceneBundles.values()) {
      if (item.bundleId === record.bundleId) item.isCurrent = false;
    }
    this.sceneBundles.set(this.sceneBundleKey(record.bundleId, record.version), record);
    return record;
  }
  async updateSceneBundle(bundleId: string, input: SceneBundleUpdateInput): Promise<SceneBundleRecord | null> {
    const existing = (await this.listSceneBundleVersions(bundleId)).find((item) => item.version === input.version) ?? await this.getSceneBundle(bundleId);
    if (!existing) return null;
    const updated: SceneBundleRecord = {
      ...existing,
      storageKey: input.storageKey ?? existing.storageKey,
      publicUrl: input.publicUrl ?? existing.publicUrl,
      checksum: input.checksum ?? existing.checksum,
      sizeBytes: input.sizeBytes ?? existing.sizeBytes,
      schemaVersion: input.schemaVersion ?? existing.schemaVersion,
      entryScene: input.entryScene ?? existing.entryScene,
      previewUrl: input.previewUrl ?? existing.previewUrl,
      createdBy: input.createdBy ?? existing.createdBy,
      contentType: input.contentType ?? existing.contentType,
      provider: input.provider ?? existing.provider,
      version: input.version ?? existing.version,
      status: input.status ?? existing.status ?? "active",
      isCurrent: input.isCurrent ?? existing.isCurrent ?? true
    };
    if (updated.isCurrent) {
      for (const item of this.sceneBundles.values()) {
        if (item.bundleId === bundleId && item.version !== updated.version) {
          item.isCurrent = false;
        }
      }
    }
    this.sceneBundles.set(this.sceneBundleKey(bundleId, updated.version), updated);
    return updated;
  }
  async listSceneBundleVersions(bundleId: string): Promise<SceneBundleRecord[]> {
    return Array.from(this.sceneBundles.values())
      .filter((item) => item.bundleId === bundleId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async setCurrentSceneBundleVersion(bundleId: string, version: string): Promise<SceneBundleRecord | null> {
    let target: SceneBundleRecord | undefined;
    for (const item of this.sceneBundles.values()) {
      if (item.bundleId === bundleId) {
        item.isCurrent = item.version === version;
        if (item.version === version) target = item;
      }
    }
    return target ?? null;
  }
}

export class PostgresStorage implements Storage {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    const client = await this.pool.connect();
    let lockAcquired = false;
    let transactionStarted = false;
    try {
      await client.query(POSTGRES_INIT_ADVISORY_LOCK_SQL);
      lockAcquired = true;
      await client.query("begin");
      transactionStarted = true;
      await this.initWithClient(client);
      await client.query("commit");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await client.query("rollback");
      }
      throw error;
    } finally {
      try {
        if (lockAcquired) {
          const result = await client.query(POSTGRES_INIT_ADVISORY_UNLOCK_SQL);
          if (result.rows[0]?.unlocked !== true) {
            throw new Error("postgres_init_advisory_unlock_failed");
          }
        }
      } finally {
        client.release();
      }
    }
  }

  private async initWithClient(client: PoolClient): Promise<void> {
    await client.query(`
      create table if not exists tenants (tenant_id text primary key, name text not null);
      create table if not exists templates (
        template_id text primary key,
        label text not null,
        asset_slots jsonb not null,
        current_version text,
        status text
      );
      create table if not exists template_versions (
        template_id text not null,
        version text not null,
        snapshot jsonb not null,
        content_hash text not null,
        created_at timestamptz not null default now(),
        constraint template_versions_pkey primary key (template_id, version),
        constraint template_versions_template_id_fkey foreign key (template_id) references templates(template_id)
      );
      create table if not exists rooms (
        room_id text primary key,
        tenant_id text not null references tenants(tenant_id),
        template_id text not null references templates(template_id),
      template_version text,
      template_snapshot jsonb,
      name text not null,
      room_type text not null default 'standard',
      owner_participant_id text,
      status text not null default 'active',
      disabled_at timestamptz,
      disabled_by text,
      visibility text not null default 'public',
      scene_bundle_url text,
      features jsonb not null,
      asset_ids jsonb not null default '[]'::jsonb,
      theme jsonb not null default '{"primaryColor":"#5fc8ff","accentColor":"#163354"}'::jsonb,
      guest_allowed boolean not null default true,
        avatar_config jsonb not null default '{"avatarsEnabled":true,"avatarCatalogUrl":"/assets/avatars/catalog.v1.json","avatarQualityProfile":"desktop-standard","avatarFallbackCapsulesEnabled":true,"avatarSeatsEnabled":true}'::jsonb,
        session_control jsonb not null default '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb,
        personal_state jsonb not null default '{}'::jsonb
       );
      alter table rooms alter column avatar_config set default '{"avatarsEnabled":true,"avatarCatalogUrl":"/assets/avatars/catalog.v1.json","avatarQualityProfile":"desktop-standard","avatarFallbackCapsulesEnabled":true,"avatarSeatsEnabled":true}'::jsonb;
      create table if not exists assets (
        asset_id text primary key,
        tenant_id text not null references tenants(tenant_id),
        kind text not null,
        url text not null,
        validation_status text not null default 'validated',
        processed_url text
      );
      create table if not exists runtime_diagnostics (
        id bigserial primary key,
        room_id text not null,
        payload jsonb not null,
        created_at timestamptz not null default now()
      );
      create table if not exists xr_telemetry (
        id bigserial primary key,
        room_id text not null,
        participant_id text not null,
        payload jsonb not null,
        created_at timestamptz not null default now()
      );
      create table if not exists scene_bundles (
        bundle_id text not null,
        storage_key text not null,
        public_url text not null,
        checksum text,
        size_bytes bigint,
        schema_version integer,
        entry_scene text,
        preview_url text,
        created_by text,
        content_type text not null,
        provider text not null,
        version text not null,
        status text not null default 'active',
        is_current boolean not null default true,
        created_at timestamptz not null default now(),
        primary key (bundle_id, version)
      );
      create table if not exists room_invites (
        invite_id text primary key,
        room_id text not null references rooms(room_id) on delete cascade,
        token_hash text not null unique,
        role text not null default 'guest',
        waiting_room_enabled boolean not null default false,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        created_by text,
        revoked_by text
      );
      create table if not exists room_waiting_requests (
        request_id text primary key,
        room_id text not null references rooms(room_id) on delete cascade,
        invite_id text not null references room_invites(invite_id) on delete cascade,
        participant_id text not null,
        display_name text not null,
        status text not null default 'pending',
        created_at timestamptz not null default now(),
        decided_at timestamptz,
        decided_by text,
        unique (invite_id, participant_id)
      );
      create table if not exists room_notes (
        note_id text primary key,
        room_id text not null references rooms(room_id) on delete cascade,
        scope text not null,
        owner_participant_id text,
        content text not null,
        updated_at timestamptz not null default now(),
        updated_by text,
        deleted_at timestamptz,
        deleted_by text
      );
      create table if not exists room_note_versions (
        version_id text primary key,
        note_id text not null,
        room_id text not null references rooms(room_id) on delete cascade,
        scope text not null,
        owner_participant_id text,
        content text not null,
        action text not null default 'save',
        restored_from_version_id text,
        created_at timestamptz not null default now(),
        created_by text
      );
      create table if not exists room_documents (
        document_id text primary key,
        room_id text not null references rooms(room_id) on delete cascade,
        tenant_id text not null references tenants(tenant_id),
        filename text not null,
        content_type text not null,
        size_bytes bigint not null,
        storage_key text not null,
        checksum text not null,
        uploaded_by text,
        uploaded_at timestamptz not null default now(),
        deleted_at timestamptz,
        deleted_by text,
        linked_surface_id text,
        metadata jsonb not null default '{}'::jsonb
      );
    `);
    await client.query(`create index if not exists xr_telemetry_room_id_id_idx on xr_telemetry (room_id, id)`);
    await client.query(`create unique index if not exists room_notes_room_scope_owner_idx on room_notes (room_id, scope, coalesce(owner_participant_id, ''))`);
    await client.query(`create index if not exists room_note_versions_note_created_idx on room_note_versions (note_id, created_at desc)`);
    await client.query(`create index if not exists room_note_versions_room_scope_owner_idx on room_note_versions (room_id, scope, coalesce(owner_participant_id, ''), created_at desc)`);
    await client.query(`create index if not exists room_documents_room_uploaded_idx on room_documents (room_id, uploaded_at desc)`);
    await client.query(`alter table room_documents add column if not exists metadata jsonb not null default '{}'::jsonb`);
    await client.query(`alter table room_notes add column if not exists deleted_at timestamptz`);
    await client.query(`alter table room_notes add column if not exists deleted_by text`);
    await client.query(`alter table templates add column if not exists current_version text`);
    await client.query(`alter table templates add column if not exists status text`);
    await client.query(`alter table rooms add column if not exists template_version text`);
    await client.query(`alter table rooms add column if not exists template_snapshot jsonb`);
    await client.query(`
      create table if not exists template_versions (
        template_id text not null,
        version text not null,
        snapshot jsonb not null,
        content_hash text not null,
        created_at timestamptz not null default now(),
        constraint template_versions_pkey primary key (template_id, version),
        constraint template_versions_template_id_fkey foreign key (template_id) references templates(template_id)
      )
    `);
    await client.query(`alter table rooms add column if not exists scene_bundle_url text`);
    await client.query(`alter table rooms add column if not exists status text not null default 'active'`);
    await client.query(`alter table rooms add column if not exists disabled_at timestamptz`);
    await client.query(`alter table rooms add column if not exists disabled_by text`);
    await client.query(`alter table rooms add column if not exists visibility text not null default 'public'`);
    await client.query(`alter table rooms add column if not exists room_type text not null default 'standard'`);
    await client.query(`alter table rooms add column if not exists owner_participant_id text`);
    await client.query(`alter table rooms add column if not exists personal_state jsonb not null default '${DEFAULT_PERSONAL_STATE_JSON}'::jsonb`);
    await client.query(`alter table rooms alter column personal_state set default '${DEFAULT_PERSONAL_STATE_JSON}'::jsonb`);
    await client.query(`update rooms set room_type = 'standard' where room_type is null`);
    await client.query(`update rooms set personal_state = '${DEFAULT_PERSONAL_STATE_JSON}'::jsonb where personal_state is null`);
    await client.query(`update rooms set status = 'disabled' where disabled_at is not null and (status is null or status = 'active')`);
    await client.query(`update rooms set visibility = 'private' where guest_allowed = false and (visibility is null or visibility = 'public')`);
    await client.query(`alter table rooms add column if not exists avatar_config jsonb not null default '${DEFAULT_AVATAR_CONFIG_JSON}'::jsonb`);
    await client.query(`update rooms set avatar_config = '${DEFAULT_AVATAR_CONFIG_JSON}'::jsonb where avatar_config is null`);
    await client.query(`update rooms set avatar_config = '${DEFAULT_AVATAR_CONFIG_JSON}'::jsonb || avatar_config`);
    await client.query(`alter table rooms add column if not exists session_control jsonb not null default '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb`);
    await client.query(`alter table rooms alter column session_control set default '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb`);
    await client.query(`update rooms set session_control = '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb where session_control is null`);
    await client.query(`update rooms set session_control = '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb || session_control`);
    await client.query(`alter table scene_bundles add column if not exists status text not null default 'active'`);
    await client.query(`alter table scene_bundles add column if not exists is_current boolean not null default true`);
    await client.query(`alter table scene_bundles add column if not exists schema_version integer`);
    await client.query(`alter table scene_bundles add column if not exists entry_scene text`);
    await client.query(`alter table scene_bundles add column if not exists preview_url text`);
    await client.query(`alter table scene_bundles add column if not exists created_by text`);
    await client.query(`do $$ begin alter table scene_bundles drop constraint if exists scene_bundles_pkey; alter table scene_bundles add primary key (bundle_id, version); exception when duplicate_object then null; end $$;`);
    await this.ensureTemplateVersionBaseConstraints(client);
    await this.seed(client);
    await this.validateStoredTemplateVersions(client);
    await this.synchronizeTemplateCatalog(client);
    await this.repairRoomTemplateMetadata(client);
    await this.addTemplateVersionConstraints(client);
    await this.installTemplateVersionImmutabilityTrigger(client);
  }

  private async seed(client: PoolClient): Promise<void> {
    await client.query(`insert into tenants (tenant_id, name) values ('demo-tenant','Demo Tenant') on conflict do nothing`);
    for (const template of defaultTemplates) {
      await client.query(
        `insert into templates (template_id, label, asset_slots) values ($1,$2,$3::jsonb) on conflict do nothing`,
        [template.templateId, template.label, JSON.stringify(template.assetSlots)]
      );
    }
    const templateRows = await client.query(`select template_id, label, asset_slots, current_version, status from templates order by template_id`);
    const seedVersionsByTemplateId = new Map(defaultTemplateVersions.map((snapshot) => [snapshot.templateId, snapshot]));
    for (const row of templateRows.rows as Array<{ template_id: string; label: string; asset_slots: string[]; current_version: string | null; status: string | null }>) {
      normalizeStoredTemplateStatus(row.template_id, row.status);
      const seedVersion = seedVersionsByTemplateId.get(row.template_id);
      const storedLegacyVersion = seedVersion ? null : await this.readStoredTemplateVersion(client, row.template_id, "0.1.0");
      if (!seedVersion && !storedLegacyVersion && row.current_version && row.current_version !== "0.1.0") {
        throw new Error(`missing_legacy_template_version:${row.template_id}@0.1.0`);
      }
      const versionSnapshot: RoomTemplateVersionSnapshotV1 = seedVersion ?? storedLegacyVersion ?? {
          schemaVersion: 1,
          templateId: row.template_id,
          version: "0.1.0",
          label: row.label,
          assetSlots: [...row.asset_slots]
        };
      await this.ensureTemplateVersion(client, versionSnapshot);
      await client.query(
        `update templates set current_version = coalesce(current_version, $2), status = coalesce(status, $3) where template_id = $1`,
        [row.template_id, versionSnapshot.version, "active"]
      );
    }
    await client.query(
      `insert into rooms (room_id, tenant_id, template_id, name, room_type, owner_participant_id, status, disabled_at, disabled_by, visibility, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config, session_control, personal_state)
       values ('demo-room','demo-tenant','meeting-room-basic','Demo Room','standard',null,'active',null,null,'public',null,$1::jsonb,'[]'::jsonb,'{"primaryColor":"#5fc8ff","accentColor":"#163354"}'::jsonb,true,$2::jsonb,$3::jsonb,$4::jsonb)
       on conflict do nothing`,
      [JSON.stringify({ voice: true, spatialAudio: true, screenShare: true }), JSON.stringify(defaultAvatarConfig()), DEFAULT_SESSION_CONTROL_JSON, DEFAULT_PERSONAL_STATE_JSON]
    );
  }

  private async readStoredTemplateVersion(client: PoolClient, templateId: string, version: string): Promise<RoomTemplateVersionSnapshotV1 | null> {
    const result = await client.query(
      `select template_id, version, snapshot, content_hash from template_versions where template_id = $1 and version = $2`,
      [templateId, version]
    );
    const row = result.rows[0] as StoredTemplateVersionRow | undefined;
    return row ? parseStoredTemplateVersion(row) : null;
  }

  private async validateStoredTemplateVersions(client: PoolClient): Promise<void> {
    const result = await client.query(
      `select template_id, version, snapshot, content_hash from template_versions order by template_id, version`
    );
    for (const row of result.rows as StoredTemplateVersionRow[]) {
      parseStoredTemplateVersion(row);
    }
  }

  private async ensureTemplateVersion(client: PoolClient, snapshot: RoomTemplateVersionSnapshotV1): Promise<void> {
    const contentHash = templateVersionContentHash(snapshot);
    await client.query(
      `insert into template_versions (template_id, version, snapshot, content_hash)
       values ($1,$2,$3::jsonb,$4)
       on conflict (template_id, version) do nothing`,
      [snapshot.templateId, snapshot.version, JSON.stringify(snapshot), contentHash]
    );
    let existingSnapshot: RoomTemplateVersionSnapshotV1 | undefined;
    try {
      existingSnapshot = await this.readStoredTemplateVersion(client, snapshot.templateId, snapshot.version) ?? undefined;
    } catch (error) {
      if (
        error instanceof Error
        && /^(invalid_template_version_snapshot|template_version_identity_mismatch|template_version_content_hash_mismatch):/.test(error.message)
      ) {
        throw new Error(`template_version_seed_conflict:${snapshot.templateId}@${snapshot.version}`);
      }
      throw error;
    }
    if (!existingSnapshot || stableJson(existingSnapshot) !== stableJson(snapshot)) {
      throw new Error(`template_version_seed_conflict:${snapshot.templateId}@${snapshot.version}`);
    }
  }

  private async synchronizeTemplateCatalog(client: PoolClient): Promise<void> {
    const result = await client.query(`
      select t.template_id, t.current_version, t.status,
             tv.template_id as version_template_id, tv.version, tv.snapshot, tv.content_hash
      from templates t
      left join template_versions tv
        on tv.template_id = t.template_id and tv.version = t.current_version
      order by t.template_id
    `);
    for (const row of result.rows as Array<{
      template_id: string;
      current_version: string | null;
      status: string | null;
      version_template_id: string | null;
      version: string | null;
      snapshot: unknown;
      content_hash: string | null;
    }>) {
      normalizeStoredTemplateStatus(row.template_id, row.status);
      if (!row.current_version || !row.version_template_id || !row.version || !row.content_hash) {
        throw new Error(`template_version_not_found:${row.template_id}`);
      }
      const snapshot = parseStoredTemplateVersion({
        template_id: row.version_template_id,
        version: row.version,
        snapshot: row.snapshot,
        content_hash: row.content_hash
      });
      await client.query(
        `update templates set label = $2, asset_slots = $3::jsonb where template_id = $1`,
        [row.template_id, snapshot.label, JSON.stringify(snapshot.assetSlots)]
      );
    }
  }

  private async repairRoomTemplateMetadata(client: PoolClient): Promise<void> {
    await client.query(`
      with desired as (
        select
          r.room_id,
          coalesce(r.template_version, t.current_version) as template_version,
          tv.snapshot || jsonb_build_object(
            'roomConfig', jsonb_build_object(
              'roomType', r.room_type,
              'visibility', r.visibility,
              'guestAllowed', r.guest_allowed,
              'sceneBundleUrl', r.scene_bundle_url,
              'features', r.features,
              'theme', r.theme,
              'avatarConfig', r.avatar_config
            )
          ) as template_snapshot
        from rooms r
        join templates t on t.template_id = r.template_id
        join template_versions tv
          on tv.template_id = r.template_id
         and tv.version = coalesce(r.template_version, t.current_version)
        where coalesce(r.template_version, t.current_version) is not null
      )
      update rooms r
      set template_version = coalesce(r.template_version, desired.template_version),
          template_snapshot = desired.template_snapshot
      from desired
      where r.room_id = desired.room_id
        and (
          r.template_version is distinct from desired.template_version
          or r.template_snapshot is distinct from desired.template_snapshot
        )
    `);
  }

  private async ensureTemplateVersionBaseConstraints(client: PoolClient): Promise<void> {
    await this.ensureNamedForeignKey(client, {
      tableRegclass: "template_versions",
      tableSql: "template_versions",
      constraintName: "template_versions_template_id_fkey",
      columns: ["template_id"],
      referencedTableRegclass: "templates",
      referencedColumns: ["template_id"],
      expectedDefinition: "foreign key (template_id) references templates(template_id)",
      createSql: `alter table template_versions
        add constraint template_versions_template_id_fkey
        foreign key (template_id) references templates(template_id) not valid`
    });
    await this.ensureNamedForeignKey(client, {
      tableRegclass: "rooms",
      tableSql: "rooms",
      constraintName: "rooms_template_id_fkey",
      columns: ["template_id"],
      referencedTableRegclass: "templates",
      referencedColumns: ["template_id"],
      expectedDefinition: "foreign key (template_id) references templates(template_id)",
      createSql: `alter table rooms
        add constraint rooms_template_id_fkey
        foreign key (template_id) references templates(template_id) not valid`
    });
  }

  private async addTemplateVersionConstraints(client: PoolClient): Promise<void> {
    await this.ensureNamedForeignKey(client, {
      tableRegclass: "templates",
      tableSql: "templates",
      constraintName: "templates_current_version_fkey",
      columns: ["template_id", "current_version"],
      referencedTableRegclass: "template_versions",
      referencedColumns: ["template_id", "version"],
      expectedDefinition: "foreign key (template_id, current_version) references template_versions(template_id, version)",
      createSql: `alter table templates
        add constraint templates_current_version_fkey
        foreign key (template_id, current_version)
        references template_versions(template_id, version) not valid`
    });
    await this.ensureNamedForeignKey(client, {
      tableRegclass: "rooms",
      tableSql: "rooms",
      constraintName: "rooms_template_version_fkey",
      columns: ["template_id", "template_version"],
      referencedTableRegclass: "template_versions",
      referencedColumns: ["template_id", "version"],
      expectedDefinition: "foreign key (template_id, template_version) references template_versions(template_id, version)",
      createSql: `alter table rooms
        add constraint rooms_template_version_fkey
        foreign key (template_id, template_version)
        references template_versions(template_id, version) not valid`
    });
  }

  private async ensureNamedForeignKey(client: PoolClient, input: {
    tableRegclass: string;
    tableSql: string;
    constraintName: string;
    columns: string[];
    referencedTableRegclass: string;
    referencedColumns: string[];
    expectedDefinition: string;
    createSql: string;
  }): Promise<void> {
    const result = await client.query(
      `select
         c.contype,
         c.convalidated,
         c.condeferrable,
         c.condeferred,
         c.confmatchtype,
         c.confupdtype,
         c.confdeltype,
         c.confrelid = $3::regclass as referenced_table_matches,
         pg_get_constraintdef(c.oid, true) as definition,
         (select array_agg(a.attname::text order by key.ordinality)
            from unnest(c.conkey) with ordinality as key(attnum, ordinality)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = key.attnum) as columns,
         (select array_agg(a.attname::text order by key.ordinality)
            from unnest(c.confkey) with ordinality as key(attnum, ordinality)
            join pg_attribute a on a.attrelid = c.confrelid and a.attnum = key.attnum) as referenced_columns
       from pg_constraint c
       where c.conrelid = $1::regclass and c.conname = $2`,
      [input.tableRegclass, input.constraintName, input.referencedTableRegclass]
    );
    const row = result.rows[0] as {
      contype: string;
      convalidated: boolean;
      condeferrable: boolean;
      condeferred: boolean;
      confmatchtype: string;
      confupdtype: string;
      confdeltype: string;
      referenced_table_matches: boolean;
      definition: string;
      columns: string[];
      referenced_columns: string[];
    } | undefined;
    if (row && (
      row.contype !== "f"
      || row.condeferrable
      || row.condeferred
      || row.confmatchtype !== "s"
      || row.confupdtype !== "a"
      || row.confdeltype !== "a"
      || !row.referenced_table_matches
      || stableJson(row.columns) !== stableJson(input.columns)
      || stableJson(row.referenced_columns) !== stableJson(input.referencedColumns)
      || normalizePostgresConstraintDefinition(row.definition) !== normalizePostgresConstraintDefinition(input.expectedDefinition)
    )) {
      throw new Error(`postgres_constraint_definition_mismatch:${input.tableRegclass}.${input.constraintName}:${stableJson(row)}`);
    }
    if (!row) {
      await client.query(input.createSql);
    }
    if (!row?.convalidated) {
      await client.query(`alter table ${input.tableSql} validate constraint ${input.constraintName}`);
    }
  }

  private async installTemplateVersionImmutabilityTrigger(client: PoolClient): Promise<void> {
    const schemaResult = await client.query(`
      select n.nspname as table_schema
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.oid = 'template_versions'::regclass
    `);
    const tableSchema = schemaResult.rows[0]?.table_schema as string | undefined;
    if (!tableSchema) throw new Error("postgres_table_schema_not_found:template_versions");
    const quotedTableSchema = quotePostgresIdentifier(tableSchema);
    const functionResult = await client.query(
      `select
         p.prorettype::regtype::text as return_type,
         l.lanname as language,
         p.prosrc as source,
         p.prosecdef as security_definer,
         p.provolatile as volatility,
         p.proleakproof as leakproof,
         p.proparallel as parallel_safety,
         p.proisstrict as strict,
         p.proconfig as runtime_config,
         pg_get_functiondef(p.oid) as definition
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_language l on l.oid = p.prolang
       where n.nspname = $2
          and p.proname = $1
          and p.pronargs = 0`,
      [TEMPLATE_VERSION_MUTATION_FUNCTION_NAME, tableSchema]
    );
    const functionRow = functionResult.rows[0] as {
      return_type: string;
      language: string;
      source: string;
      security_definer: boolean;
      volatility: string;
      leakproof: boolean;
      parallel_safety: string;
      strict: boolean;
      runtime_config: string[] | null;
      definition: string;
    } | undefined;
    if (functionRow && (
      functionRow.return_type !== "trigger"
      || functionRow.language !== "plpgsql"
      || functionRow.security_definer
      || functionRow.volatility !== "v"
      || functionRow.leakproof
      || functionRow.parallel_safety !== "u"
      || functionRow.strict
      || functionRow.runtime_config !== null
      || normalizePostgresDefinition(functionRow.source) !== normalizePostgresDefinition(TEMPLATE_VERSION_MUTATION_FUNCTION_SOURCE)
    )) {
      throw new Error(`postgres_function_definition_mismatch:${tableSchema}.${TEMPLATE_VERSION_MUTATION_FUNCTION_NAME}:${functionRow.definition}`);
    }
    if (!functionRow) {
      await client.query(`
        create function ${quotedTableSchema}.vrata_reject_template_version_mutation()
        returns trigger
        language plpgsql
        as $vrata_function$
        begin
          raise exception 'template_versions_are_immutable' using errcode = '55000';
          return null;
        end
        $vrata_function$
      `);
    }

    const triggerResult = await client.query(
      `select
         t.tgtype::integer as trigger_type,
         t.tgenabled,
         t.tgqual is null as has_no_when,
         t.tgattr::text = '' as all_columns,
         fn.proname as function_name,
         fn.pronargs as function_arg_count,
         fn_ns.nspname as function_schema,
         pg_get_triggerdef(t.oid, true) as definition
       from pg_trigger t
       join pg_proc fn on fn.oid = t.tgfoid
       join pg_namespace fn_ns on fn_ns.oid = fn.pronamespace
       where t.tgrelid = 'template_versions'::regclass
         and t.tgname = 'template_versions_immutable'
         and not t.tgisinternal`
    );
    const triggerRow = triggerResult.rows[0] as {
      trigger_type: number;
      tgenabled: string;
      has_no_when: boolean;
      all_columns: boolean;
      function_name: string;
      function_arg_count: number;
      function_schema: string;
      definition: string;
    } | undefined;
    if (triggerRow && (
      triggerRow.trigger_type !== 27
      || triggerRow.tgenabled !== "O"
      || !triggerRow.has_no_when
      || !triggerRow.all_columns
      || triggerRow.function_schema !== tableSchema
      || triggerRow.function_name !== TEMPLATE_VERSION_MUTATION_FUNCTION_NAME
      || triggerRow.function_arg_count !== 0
      || !isExpectedTemplateVersionTriggerDefinition(triggerRow.definition)
    )) {
      throw new Error(`postgres_trigger_definition_mismatch:template_versions.template_versions_immutable:${triggerRow.definition}`);
    }
    if (!triggerRow) {
      await client.query(`
        create trigger template_versions_immutable
          before update or delete on template_versions
          for each row execute function ${quotedTableSchema}.vrata_reject_template_version_mutation()
      `);
    }
  }

  async listTenants(): Promise<TenantRecord[]> {
    const result = await this.pool.query(`select tenant_id, name from tenants order by tenant_id`);
    return result.rows.map((row: { tenant_id: string; name: string }) => ({ tenantId: row.tenant_id, name: row.name }));
  }
  async createTenant(input: Partial<TenantRecord>): Promise<TenantRecord> {
    const tenant = { tenantId: input.tenantId ?? crypto.randomUUID(), name: input.name ?? "New Tenant" };
    await this.pool.query(`insert into tenants (tenant_id, name) values ($1,$2)`, [tenant.tenantId, tenant.name]);
    return tenant;
  }
  async updateTenant(tenantId: string, input: Partial<TenantRecord>): Promise<TenantRecord | null> {
    const existing = await this.pool.query(`select tenant_id, name from tenants where tenant_id = $1`, [tenantId]);
    if (!existing.rows[0]) return null;
    const name = input.name ?? existing.rows[0].name;
    await this.pool.query(`update tenants set name = $2 where tenant_id = $1`, [tenantId, name]);
    return { tenantId, name };
  }
  async deleteTenant(tenantId: string): Promise<boolean> {
    const rooms = await this.pool.query(`select 1 from rooms where tenant_id = $1 limit 1`, [tenantId]);
    const assets = await this.pool.query(`select 1 from assets where tenant_id = $1 limit 1`, [tenantId]);
    if (rooms.rows[0] || assets.rows[0]) return false;
    const result = await this.pool.query(`delete from tenants where tenant_id = $1`, [tenantId]);
    return (result.rowCount ?? 0) > 0;
  }
  async listTemplates(): Promise<TemplateRecord[]> {
    const result = await this.pool.query(`
      select t.template_id, t.current_version, t.status,
             tv.template_id as version_template_id, tv.version, tv.snapshot, tv.content_hash
      from templates t
      left join template_versions tv
        on tv.template_id = t.template_id and tv.version = t.current_version
    `);
    return sortTemplateRecords(result.rows.map((row: {
      template_id: string;
      current_version: string | null;
      status: string | null;
      version_template_id: string | null;
      version: string | null;
      snapshot: unknown;
      content_hash: string | null;
    }) => {
      if (!row.current_version || !row.version_template_id || !row.version || !row.content_hash) {
        throw new Error(`template_version_not_found:${row.template_id}`);
      }
      const snapshot = parseStoredTemplateVersion({
        template_id: row.version_template_id,
        version: row.version,
        snapshot: row.snapshot,
        content_hash: row.content_hash
      });
      return {
        templateId: row.template_id,
        label: snapshot.label,
        assetSlots: [...snapshot.assetSlots],
        currentVersion: row.current_version,
        status: normalizeStoredTemplateStatus(row.template_id, row.status)
      };
    }));
  }
  async getTemplateVersion(templateId: string, version?: string): Promise<RoomTemplateVersionSnapshotV1 | null> {
    const result = await this.pool.query(
      `select tv.template_id, tv.version, tv.snapshot, tv.content_hash
       from templates t
       join template_versions tv on tv.template_id = t.template_id and tv.version = coalesce($2, t.current_version)
       where t.template_id = $1`,
      [templateId, version ?? null]
    );
    const row = result.rows[0] as StoredTemplateVersionRow | undefined;
    return row ? parseStoredTemplateVersion(row) : null;
  }
  async listAssets(): Promise<AssetRecord[]> {
    const result = await this.pool.query(`select asset_id, tenant_id, kind, url, validation_status, processed_url from assets order by asset_id desc`);
    return result.rows.map((row: { asset_id: string; tenant_id: string; kind: string; url: string; validation_status: "pending" | "validated" | "rejected"; processed_url: string | null }) => ({
      assetId: row.asset_id,
      tenantId: row.tenant_id,
      kind: row.kind,
      url: row.url,
      validationStatus: row.validation_status,
      processedUrl: row.processed_url ?? row.url
    }));
  }
  async listRooms(): Promise<RoomRecord[]> {
    const result = await this.pool.query(`
      select r.room_id, r.tenant_id, r.template_id, r.template_version, r.template_snapshot,
             tv.template_id as template_version_template_id, tv.version as template_version_resolved,
             tv.snapshot as template_version_snapshot, tv.content_hash as template_version_content_hash,
             r.name, r.room_type, r.owner_participant_id,
             r.status, r.disabled_at, r.disabled_by, r.visibility, r.scene_bundle_url, r.features,
             r.asset_ids, r.theme, r.guest_allowed, r.avatar_config, r.session_control, r.personal_state
      from rooms r
      left join templates t on t.template_id = r.template_id
      left join template_versions tv on tv.template_id = r.template_id and tv.version = coalesce(r.template_version, t.current_version)
      order by r.room_id
    `);
    return result.rows.map(mapRoomRow);
  }
  async getRoom(roomId: string): Promise<RoomRecord | null> {
    const result = await this.pool.query(`
      select r.room_id, r.tenant_id, r.template_id, r.template_version, r.template_snapshot,
             tv.template_id as template_version_template_id, tv.version as template_version_resolved,
             tv.snapshot as template_version_snapshot, tv.content_hash as template_version_content_hash,
             r.name, r.room_type, r.owner_participant_id,
             r.status, r.disabled_at, r.disabled_by, r.visibility, r.scene_bundle_url, r.features,
             r.asset_ids, r.theme, r.guest_allowed, r.avatar_config, r.session_control, r.personal_state
      from rooms r
      left join templates t on t.template_id = r.template_id
      left join template_versions tv on tv.template_id = r.template_id and tv.version = coalesce(r.template_version, t.current_version)
      where r.room_id = $1
    `, [roomId]);
    const row = result.rows[0];
    return row ? mapRoomRow(row) : null;
  }
  async createRoom(input: Partial<RoomRecord>): Promise<RoomRecord> {
    const roomType = defaultRoomType(input.roomType);
    const roomWithoutTemplateMetadata: RoomRecordWithoutTemplateMetadata = {
      roomId: input.roomId ?? crypto.randomUUID(),
      tenantId: input.tenantId ?? "demo-tenant",
      templateId: input.templateId ?? (roomType === "personal" ? "personal-workspace-basic" : "meeting-room-basic"),
      name: input.name ?? "New Room",
      roomType,
      ownerParticipantId: input.ownerParticipantId ?? null,
      status: defaultRoomStatus(input.status),
      disabledAt: input.disabledAt ?? null,
      disabledBy: input.disabledBy ?? null,
      visibility: defaultRoomVisibility(input.visibility, roomType),
      sceneBundleUrl: input.sceneBundleUrl,
      features: {
        voice: input.features?.voice ?? true,
        spatialAudio: input.features?.spatialAudio ?? true,
        screenShare: input.features?.screenShare ?? true
      },
      assetIds: input.assetIds ?? [],
      theme: input.theme ?? {
        primaryColor: "#5fc8ff",
        accentColor: "#163354"
      },
      guestAllowed: defaultGuestAllowed(input.guestAllowed, roomType),
      avatarConfig: defaultAvatarConfig(input.avatarConfig),
      sessionControl: defaultSessionControl(input.sessionControl),
      personalState: defaultPersonalState(input.personalState)
    };
    const versionSnapshot = await this.getTemplateVersion(roomWithoutTemplateMetadata.templateId);
    if (!versionSnapshot) throw new Error(`template_version_not_found:${roomWithoutTemplateMetadata.templateId}`);
    const room = bindRoomTemplateMetadata(roomWithoutTemplateMetadata, versionSnapshot);
    await this.pool.query(
      `insert into rooms (room_id, tenant_id, template_id, name, room_type, owner_participant_id, status, disabled_at, disabled_by, visibility, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config, session_control, personal_state, template_version, template_snapshot) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20::jsonb)`,
      [room.roomId, room.tenantId, room.templateId, room.name, room.roomType, room.ownerParticipantId ?? null, room.status, room.disabledAt ?? null, room.disabledBy ?? null, room.visibility, room.sceneBundleUrl ?? null, JSON.stringify(room.features), JSON.stringify(room.assetIds), JSON.stringify(room.theme), room.guestAllowed, JSON.stringify(room.avatarConfig), JSON.stringify(room.sessionControl), JSON.stringify(room.personalState), room.templateVersion, JSON.stringify(room.templateSnapshot)]
    );
    return room;
  }
  async updateRoom(roomId: string, input: Partial<RoomRecord>, expectedTemplateBinding?: ExpectedRoomTemplateBinding): Promise<RoomRecord | null> {
    const existing = await this.getRoom(roomId);
    if (!existing) {
      return null;
    }
    if (
      expectedTemplateBinding
      && (existing.templateId !== expectedTemplateBinding.templateId || existing.templateVersion !== expectedTemplateBinding.templateVersion)
    ) {
      throw new Error("room_template_binding_changed");
    }
    const { templateVersion: _inputTemplateVersion, templateSnapshot: _inputTemplateSnapshot, ...safeInput } = input;
    const { templateVersion: _existingTemplateVersion, templateSnapshot: _existingTemplateSnapshot, ...existingWithoutTemplateMetadata } = existing;
    const updatedWithoutTemplateMetadata: RoomRecordWithoutTemplateMetadata = {
      ...existingWithoutTemplateMetadata,
      ...safeInput,
      roomType: defaultRoomType(input.roomType ?? existing.roomType),
      ownerParticipantId: input.ownerParticipantId !== undefined ? input.ownerParticipantId : existing.ownerParticipantId ?? null,
      status: defaultRoomStatus(input.status ?? existing.status),
      disabledAt: input.disabledAt !== undefined ? input.disabledAt : existing.disabledAt ?? null,
      disabledBy: input.disabledBy !== undefined ? input.disabledBy : existing.disabledBy ?? null,
      features: {
        ...existing.features,
        ...input.features
      },
      theme: {
        primaryColor: input.theme?.primaryColor ?? existing.theme?.primaryColor ?? "#5fc8ff",
        accentColor: input.theme?.accentColor ?? existing.theme?.accentColor ?? "#163354"
      },
      assetIds: input.assetIds ?? existing.assetIds,
      visibility: defaultRoomVisibility(input.visibility ?? existing.visibility, input.roomType ?? existing.roomType),
      guestAllowed: defaultGuestAllowed(input.guestAllowed ?? existing.guestAllowed, input.roomType ?? existing.roomType),
      avatarConfig: defaultAvatarConfig({
        ...existing.avatarConfig,
        ...input.avatarConfig
      }),
      sessionControl: defaultSessionControl(input.sessionControl ?? existing.sessionControl),
      personalState: defaultPersonalState(input.personalState ?? existing.personalState)
    };
    const preservedVersion = updatedWithoutTemplateMetadata.templateId === existing.templateId ? existing.templateVersion : undefined;
    const versionSnapshot = await this.getTemplateVersion(updatedWithoutTemplateMetadata.templateId, preservedVersion);
    if (!versionSnapshot) throw new Error(`template_version_not_found:${updatedWithoutTemplateMetadata.templateId}`);
    const updated = bindRoomTemplateMetadata(updatedWithoutTemplateMetadata, versionSnapshot);
    const result = await this.pool.query(
      `update rooms set template_id = $2, name = $3, room_type = $4, owner_participant_id = $5, status = $6, disabled_at = $7, disabled_by = $8, visibility = $9, scene_bundle_url = $10, features = $11::jsonb, asset_ids = $12::jsonb, theme = $13::jsonb, guest_allowed = $14, avatar_config = $15::jsonb, session_control = $16::jsonb, personal_state = $17::jsonb, template_version = $18, template_snapshot = $19::jsonb where room_id = $1 and ($20::text is null or (template_id = $20 and coalesce(template_version, (select t.current_version from templates t where t.template_id = rooms.template_id)) = $21))`,
      [roomId, updated.templateId, updated.name, updated.roomType, updated.ownerParticipantId ?? null, updated.status, updated.disabledAt ?? null, updated.disabledBy ?? null, updated.visibility, updated.sceneBundleUrl ?? null, JSON.stringify(updated.features), JSON.stringify(updated.assetIds), JSON.stringify(updated.theme), updated.guestAllowed, JSON.stringify(updated.avatarConfig), JSON.stringify(updated.sessionControl), JSON.stringify(updated.personalState), updated.templateVersion, JSON.stringify(updated.templateSnapshot), expectedTemplateBinding?.templateId ?? null, expectedTemplateBinding?.templateVersion ?? null]
    );
    if ((result.rowCount ?? 0) === 0) {
      if (expectedTemplateBinding) throw new Error("room_template_binding_changed");
      return null;
    }
    return updated;
  }
  async deleteRoom(roomId: string): Promise<boolean> {
    const result = await this.pool.query(`delete from rooms where room_id = $1`, [roomId]);
    return (result.rowCount ?? 0) > 0;
  }
  async createRoomInvite(input: Omit<RoomInviteRecord, "inviteId" | "createdAt" | "revokedAt" | "revokedBy"> & { inviteId?: string; createdAt?: string }): Promise<RoomInviteRecord> {
    const invite: RoomInviteRecord = {
      inviteId: input.inviteId ?? crypto.randomUUID(),
      roomId: input.roomId,
      tokenHash: input.tokenHash,
      role: input.role,
      waitingRoomEnabled: input.waitingRoomEnabled,
      createdAt: input.createdAt ?? new Date().toISOString(),
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdBy: input.createdBy ?? null,
      revokedBy: null
    };
    await this.pool.query(
      `insert into room_invites (invite_id, room_id, token_hash, role, waiting_room_enabled, created_at, expires_at, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [invite.inviteId, invite.roomId, invite.tokenHash, invite.role, invite.waitingRoomEnabled, invite.createdAt, invite.expiresAt, invite.createdBy]
    );
    return invite;
  }
  async listRoomInvites(roomId: string): Promise<RoomInviteRecord[]> {
    const result = await this.pool.query(`select invite_id, room_id, token_hash, role, waiting_room_enabled, created_at, expires_at, revoked_at, created_by, revoked_by from room_invites where room_id = $1 order by created_at desc`, [roomId]);
    return result.rows.map(mapRoomInviteRow);
  }
  async getRoomInvite(inviteId: string): Promise<RoomInviteRecord | null> {
    const result = await this.pool.query(`select invite_id, room_id, token_hash, role, waiting_room_enabled, created_at, expires_at, revoked_at, created_by, revoked_by from room_invites where invite_id = $1`, [inviteId]);
    return result.rows[0] ? mapRoomInviteRow(result.rows[0]) : null;
  }
  async getRoomInviteByTokenHash(tokenHash: string): Promise<RoomInviteRecord | null> {
    const result = await this.pool.query(`select invite_id, room_id, token_hash, role, waiting_room_enabled, created_at, expires_at, revoked_at, created_by, revoked_by from room_invites where token_hash = $1`, [tokenHash]);
    return result.rows[0] ? mapRoomInviteRow(result.rows[0]) : null;
  }
  async revokeRoomInvite(roomId: string, inviteId: string, revokedAt: string, revokedBy?: string | null): Promise<RoomInviteRecord | null> {
    const result = await this.pool.query(
      `update room_invites set revoked_at = $3, revoked_by = $4 where room_id = $1 and invite_id = $2 returning invite_id, room_id, token_hash, role, waiting_room_enabled, created_at, expires_at, revoked_at, created_by, revoked_by`,
      [roomId, inviteId, revokedAt, revokedBy ?? null]
    );
    return result.rows[0] ? mapRoomInviteRow(result.rows[0]) : null;
  }
  async createWaitingRoomRequest(input: Omit<WaitingRoomRequestRecord, "requestId" | "createdAt" | "status" | "decidedAt" | "decidedBy"> & { requestId?: string; createdAt?: string; status?: WaitingRoomRequestRecord["status"] }): Promise<WaitingRoomRequestRecord> {
    const waitingRequest: WaitingRoomRequestRecord = {
      requestId: input.requestId ?? crypto.randomUUID(),
      roomId: input.roomId,
      inviteId: input.inviteId,
      participantId: input.participantId,
      displayName: input.displayName,
      status: input.status ?? "pending",
      createdAt: input.createdAt ?? new Date().toISOString(),
      decidedAt: null,
      decidedBy: null
    };
    const result = await this.pool.query(
      `insert into room_waiting_requests (request_id, room_id, invite_id, participant_id, display_name, status, created_at) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (invite_id, participant_id) do update set display_name = excluded.display_name
       returning request_id, room_id, invite_id, participant_id, display_name, status, created_at, decided_at, decided_by`,
      [waitingRequest.requestId, waitingRequest.roomId, waitingRequest.inviteId, waitingRequest.participantId, waitingRequest.displayName, waitingRequest.status, waitingRequest.createdAt]
    );
    return mapWaitingRoomRequestRow(result.rows[0]);
  }
  async listWaitingRoomRequests(roomId: string): Promise<WaitingRoomRequestRecord[]> {
    const result = await this.pool.query(`select request_id, room_id, invite_id, participant_id, display_name, status, created_at, decided_at, decided_by from room_waiting_requests where room_id = $1 order by created_at desc`, [roomId]);
    return result.rows.map(mapWaitingRoomRequestRow);
  }
  async getWaitingRoomRequest(requestId: string): Promise<WaitingRoomRequestRecord | null> {
    const result = await this.pool.query(`select request_id, room_id, invite_id, participant_id, display_name, status, created_at, decided_at, decided_by from room_waiting_requests where request_id = $1`, [requestId]);
    return result.rows[0] ? mapWaitingRoomRequestRow(result.rows[0]) : null;
  }
  async getWaitingRoomRequestForInviteParticipant(inviteId: string, participantId: string): Promise<WaitingRoomRequestRecord | null> {
    const result = await this.pool.query(`select request_id, room_id, invite_id, participant_id, display_name, status, created_at, decided_at, decided_by from room_waiting_requests where invite_id = $1 and participant_id = $2`, [inviteId, participantId]);
    return result.rows[0] ? mapWaitingRoomRequestRow(result.rows[0]) : null;
  }
  async updateWaitingRoomRequest(roomId: string, requestId: string, input: Partial<Pick<WaitingRoomRequestRecord, "status" | "decidedAt" | "decidedBy">>): Promise<WaitingRoomRequestRecord | null> {
    const result = await this.pool.query(
      `update room_waiting_requests set status = coalesce($3, status), decided_at = coalesce($4, decided_at), decided_by = coalesce($5, decided_by) where room_id = $1 and request_id = $2 returning request_id, room_id, invite_id, participant_id, display_name, status, created_at, decided_at, decided_by`,
      [roomId, requestId, input.status ?? null, input.decidedAt ?? null, input.decidedBy ?? null]
    );
    return result.rows[0] ? mapWaitingRoomRequestRow(result.rows[0]) : null;
  }
  async getRoomNote(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null): Promise<RoomNoteRecord | null> {
    const result = await this.pool.query(
      `select note_id, room_id, scope, owner_participant_id, content, updated_at, updated_by, deleted_at, deleted_by from room_notes where room_id = $1 and scope = $2 and coalesce(owner_participant_id, '') = coalesce($3, '') limit 1`,
      [roomId, scope, scope === "private" ? ownerParticipantId ?? "" : ""]
    );
    return result.rows[0] ? mapRoomNoteRow(result.rows[0]) : null;
  }
  async upsertRoomNote(input: Pick<RoomNoteRecord, "roomId" | "scope" | "content"> & { ownerParticipantId?: string | null; updatedBy?: string | null }): Promise<RoomNoteRecord> {
    const noteId = roomNoteId(input.roomId, input.scope, input.ownerParticipantId);
    const versionId = crypto.randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `insert into room_notes (note_id, room_id, scope, owner_participant_id, content, updated_at, updated_by, deleted_at, deleted_by)
         values ($1,$2,$3,$4,$5,now(),$6,null,null)
         on conflict (note_id) do update set content = excluded.content, updated_at = now(), updated_by = excluded.updated_by, deleted_at = null, deleted_by = null
         returning note_id, room_id, scope, owner_participant_id, content, updated_at, updated_by, deleted_at, deleted_by`,
        [noteId, input.roomId, input.scope, input.scope === "private" ? input.ownerParticipantId ?? null : null, input.content, input.updatedBy ?? null]
      );
      await client.query(
        `insert into room_note_versions (version_id, note_id, room_id, scope, owner_participant_id, content, action, restored_from_version_id, created_at, created_by)
         values ($1,$2,$3,$4,$5,$6,'save',null,now(),$7)`,
        [versionId, noteId, input.roomId, input.scope, input.scope === "private" ? input.ownerParticipantId ?? null : null, input.content, input.updatedBy ?? null]
      );
      await client.query("commit");
      return mapRoomNoteRow(result.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async deleteRoomNote(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null, deletedBy?: string | null): Promise<RoomNoteRecord | null> {
    const noteId = roomNoteId(roomId, scope, ownerParticipantId);
    const versionId = crypto.randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update room_notes set updated_at = now(), updated_by = $4, deleted_at = now(), deleted_by = $4
         where note_id = $1 and room_id = $2 and scope = $3 and deleted_at is null
         returning note_id, room_id, scope, owner_participant_id, content, updated_at, updated_by, deleted_at, deleted_by`,
        [noteId, roomId, scope, deletedBy ?? null]
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return null;
      }
      const note = mapRoomNoteRow(result.rows[0]);
      await client.query(
        `insert into room_note_versions (version_id, note_id, room_id, scope, owner_participant_id, content, action, restored_from_version_id, created_at, created_by)
         values ($1,$2,$3,$4,$5,$6,'delete',null,now(),$7)`,
        [versionId, note.noteId, note.roomId, note.scope, note.ownerParticipantId ?? null, note.content, deletedBy ?? null]
      );
      await client.query("commit");
      return note;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async listRoomNotes(roomId: string, includeDeleted = false): Promise<RoomNoteRecord[]> {
    const result = await this.pool.query(
      `select note_id, room_id, scope, owner_participant_id, content, updated_at, updated_by, deleted_at, deleted_by
       from room_notes
       where room_id = $1 and ($2 = true or deleted_at is null)
       order by updated_at desc`,
      [roomId, includeDeleted]
    );
    return result.rows.map(mapRoomNoteRow);
  }
  async listRoomNoteVersions(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null, limit = 20): Promise<RoomNoteVersionRecord[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.pool.query(
      `select version_id, note_id, room_id, scope, owner_participant_id, content, action, restored_from_version_id, created_at, created_by
       from room_note_versions
       where room_id = $1 and scope = $2 and coalesce(owner_participant_id, '') = coalesce($3, '')
       order by created_at desc
       limit $4`,
      [roomId, scope, scope === "private" ? ownerParticipantId ?? "" : "", safeLimit]
    );
    return result.rows.map(mapRoomNoteVersionRow);
  }
  async restoreRoomNoteVersion(roomId: string, scope: RoomNoteScope, ownerParticipantId: string | null | undefined, versionId: string, updatedBy?: string | null): Promise<{ note: RoomNoteRecord; version: RoomNoteVersionRecord } | null> {
    const noteId = roomNoteId(roomId, scope, ownerParticipantId);
    const restoreVersionId = crypto.randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const versionResult = await client.query(
        `select version_id, note_id, room_id, scope, owner_participant_id, content, action, restored_from_version_id, created_at, created_by
         from room_note_versions
         where version_id = $1 and room_id = $2 and scope = $3 and coalesce(owner_participant_id, '') = coalesce($4, '')
         limit 1`,
        [versionId, roomId, scope, scope === "private" ? ownerParticipantId ?? "" : ""]
      );
      const source = versionResult.rows[0] ? mapRoomNoteVersionRow(versionResult.rows[0]) : null;
      if (!source) {
        await client.query("rollback");
        return null;
      }
      const noteResult = await client.query(
        `insert into room_notes (note_id, room_id, scope, owner_participant_id, content, updated_at, updated_by, deleted_at, deleted_by)
         values ($1,$2,$3,$4,$5,now(),$6,null,null)
         on conflict (note_id) do update set content = excluded.content, updated_at = now(), updated_by = excluded.updated_by, deleted_at = null, deleted_by = null
         returning note_id, room_id, scope, owner_participant_id, content, updated_at, updated_by, deleted_at, deleted_by`,
        [noteId, roomId, scope, scope === "private" ? ownerParticipantId ?? null : null, source.content, updatedBy ?? null]
      );
      const restoreResult = await client.query(
        `insert into room_note_versions (version_id, note_id, room_id, scope, owner_participant_id, content, action, restored_from_version_id, created_at, created_by)
         values ($1,$2,$3,$4,$5,$6,'restore',$7,now(),$8)
         returning version_id, note_id, room_id, scope, owner_participant_id, content, action, restored_from_version_id, created_at, created_by`,
        [restoreVersionId, noteId, roomId, scope, scope === "private" ? ownerParticipantId ?? null : null, source.content, source.versionId, updatedBy ?? null]
      );
      await client.query("commit");
      return { note: mapRoomNoteRow(noteResult.rows[0]), version: mapRoomNoteVersionRow(restoreResult.rows[0]) };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async listRoomDocuments(roomId: string, includeDeleted = false): Promise<RoomDocumentRecord[]> {
    const result = await this.pool.query(
      `select document_id, room_id, tenant_id, filename, content_type, size_bytes, storage_key, checksum, uploaded_by, uploaded_at, deleted_at, deleted_by, linked_surface_id, metadata from room_documents where room_id = $1 and ($2 = true or deleted_at is null) order by uploaded_at desc`,
      [roomId, includeDeleted]
    );
    return result.rows.map(mapRoomDocumentRow);
  }
  async getRoomDocument(roomId: string, documentId: string): Promise<RoomDocumentRecord | null> {
    const result = await this.pool.query(
      `select document_id, room_id, tenant_id, filename, content_type, size_bytes, storage_key, checksum, uploaded_by, uploaded_at, deleted_at, deleted_by, linked_surface_id, metadata from room_documents where room_id = $1 and document_id = $2 limit 1`,
      [roomId, documentId]
    );
    return result.rows[0] ? mapRoomDocumentRow(result.rows[0]) : null;
  }
  async createRoomDocument(input: Omit<RoomDocumentRecord, "uploadedAt" | "deletedAt" | "deletedBy" | "linkedSurfaceId"> & { uploadedAt?: string; linkedSurfaceId?: string | null }): Promise<RoomDocumentRecord> {
    const result = await this.pool.query(
      `insert into room_documents (document_id, room_id, tenant_id, filename, content_type, size_bytes, storage_key, checksum, uploaded_by, uploaded_at, linked_surface_id, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()),$11,$12)
       returning document_id, room_id, tenant_id, filename, content_type, size_bytes, storage_key, checksum, uploaded_by, uploaded_at, deleted_at, deleted_by, linked_surface_id, metadata`,
      [input.documentId, input.roomId, input.tenantId, input.filename, input.contentType, input.sizeBytes, input.storageKey, input.checksum, input.uploadedBy ?? null, input.uploadedAt ?? null, input.linkedSurfaceId ?? null, input.metadata ?? {}]
    );
    return mapRoomDocumentRow(result.rows[0]);
  }
  async markRoomDocumentDeleted(roomId: string, documentId: string, deletedAt: string, deletedBy?: string | null): Promise<RoomDocumentRecord | null> {
    const result = await this.pool.query(
      `update room_documents set deleted_at = $3, deleted_by = $4, linked_surface_id = null where room_id = $1 and document_id = $2 and deleted_at is null returning document_id, room_id, tenant_id, filename, content_type, size_bytes, storage_key, checksum, uploaded_by, uploaded_at, deleted_at, deleted_by, linked_surface_id, metadata`,
      [roomId, documentId, deletedAt, deletedBy ?? null]
    );
    return result.rows[0] ? mapRoomDocumentRow(result.rows[0]) : null;
  }
  async updateRoomDocumentSurface(roomId: string, documentId: string, linkedSurfaceId: string | null): Promise<RoomDocumentRecord | null> {
    const result = await this.pool.query(
      `with cleared as (
         update room_documents set linked_surface_id = null where room_id = $1 and document_id <> $2 and linked_surface_id = $3 and $3 is not null
       )
       update room_documents set linked_surface_id = $3 where room_id = $1 and document_id = $2 and deleted_at is null returning document_id, room_id, tenant_id, filename, content_type, size_bytes, storage_key, checksum, uploaded_by, uploaded_at, deleted_at, deleted_by, linked_surface_id, metadata`,
      [roomId, documentId, linkedSurfaceId]
    );
    return result.rows[0] ? mapRoomDocumentRow(result.rows[0]) : null;
  }
  async createAsset(input: Partial<AssetRecord>): Promise<AssetRecord> {
    const asset = {
      assetId: input.assetId ?? crypto.randomUUID(),
      tenantId: input.tenantId ?? "demo-tenant",
      kind: input.kind ?? "logo",
      url: input.url ?? "/assets/demo/placeholder.glb",
      validationStatus: input.validationStatus ?? "validated",
      processedUrl: input.processedUrl ?? input.url ?? "/assets/demo/placeholder.glb"
    };
    await this.pool.query(`insert into assets (asset_id, tenant_id, kind, url, validation_status, processed_url) values ($1,$2,$3,$4,$5,$6)`, [asset.assetId, asset.tenantId, asset.kind, asset.url, asset.validationStatus, asset.processedUrl]);
    return asset;
  }
  async updateAsset(assetId: string, input: Partial<AssetRecord>): Promise<AssetRecord | null> {
    const existing = await this.pool.query(`select asset_id, tenant_id, kind, url, validation_status, processed_url from assets where asset_id = $1`, [assetId]);
    const row = existing.rows[0];
    if (!row) return null;
    const updated = {
      assetId,
      tenantId: input.tenantId ?? row.tenant_id,
      kind: input.kind ?? row.kind,
      url: input.url ?? row.url,
      validationStatus: input.validationStatus ?? row.validation_status,
      processedUrl: input.processedUrl ?? row.processed_url ?? row.url
    };
    await this.pool.query(`update assets set tenant_id = $2, kind = $3, url = $4, validation_status = $5, processed_url = $6 where asset_id = $1`, [assetId, updated.tenantId, updated.kind, updated.url, updated.validationStatus, updated.processedUrl]);
    return updated;
  }
  async deleteAsset(assetId: string): Promise<boolean> {
    const rooms = await this.pool.query(`select 1 from rooms where asset_ids @> $1::jsonb limit 1`, [JSON.stringify([assetId])]);
    if (rooms.rows[0]) return false;
    const result = await this.pool.query(`delete from assets where asset_id = $1`, [assetId]);
    return (result.rowCount ?? 0) > 0;
  }
  async addDiagnostic(roomId: string, payload: RuntimeDiagnosticRecord): Promise<void> {
    await this.pool.query(`insert into runtime_diagnostics (room_id, payload) values ($1,$2::jsonb)`, [roomId, JSON.stringify(payload)]);
    await this.pool.query(`delete from runtime_diagnostics where id in (select id from runtime_diagnostics where room_id = $1 order by id desc offset 200)`, [roomId]);
  }
  async getDiagnostics(roomId: string): Promise<RuntimeDiagnosticRecord[]> {
    const result = await this.pool.query(`select payload from runtime_diagnostics where room_id = $1 order by id asc`, [roomId]);
    return result.rows.map((row: { payload: RuntimeDiagnosticRecord }) => row.payload);
  }
  async addXrTelemetry(roomId: string, participantId: string, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query(`insert into xr_telemetry (room_id, participant_id, payload) values ($1,$2,$3::jsonb)`, [roomId, participantId, JSON.stringify(payload)]);
    await this.pool.query(`delete from xr_telemetry where id in (select id from xr_telemetry where room_id = $1 order by id desc offset ${XR_TELEMETRY_EVENT_LIMIT})`, [roomId]);
  }
  async getXrTelemetry(roomId: string): Promise<XrTelemetryEventRecord[]> {
    const result = await this.pool.query(`select participant_id, payload, created_at from xr_telemetry where room_id = $1 order by id asc`, [roomId]);
    return result.rows.map((row: { participant_id: string; payload: Record<string, unknown>; created_at: string }) => ({
      participantId: row.participant_id,
      payload: row.payload,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }
  async listSceneBundles(): Promise<SceneBundleRecord[]> {
    const result = await this.pool.query(`select distinct on (bundle_id) bundle_id, storage_key, public_url, checksum, size_bytes, schema_version, entry_scene, preview_url, created_by, content_type, provider, version, status, is_current, created_at from scene_bundles order by bundle_id, is_current desc, created_at desc`);
    return result.rows.map((row: { bundle_id: string; storage_key: string; public_url: string; checksum: string | null; size_bytes: string | number | null; schema_version: number | null; entry_scene: string | null; preview_url: string | null; created_by: string | null; content_type: string; provider: SceneBundleRecord["provider"]; version: string; status: SceneBundleRecord["status"]; is_current: boolean; created_at: string }) => ({
      bundleId: row.bundle_id,
      storageKey: row.storage_key,
      publicUrl: row.public_url,
      checksum: row.checksum ?? undefined,
      sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
      schemaVersion: row.schema_version ?? undefined,
      entryScene: row.entry_scene ?? undefined,
      previewUrl: row.preview_url ?? undefined,
      createdBy: row.created_by ?? undefined,
      contentType: row.content_type,
      provider: row.provider,
      version: row.version,
      status: row.status,
      isCurrent: row.is_current,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }
  async getSceneBundle(bundleId: string): Promise<SceneBundleRecord | null> {
    const result = await this.pool.query(`select bundle_id, storage_key, public_url, checksum, size_bytes, schema_version, entry_scene, preview_url, created_by, content_type, provider, version, status, is_current, created_at from scene_bundles where bundle_id = $1 order by is_current desc, created_at desc limit 1`, [bundleId]);
    const row = result.rows[0];
    return row ? {
      bundleId: row.bundle_id,
      storageKey: row.storage_key,
      publicUrl: row.public_url,
      checksum: row.checksum ?? undefined,
      sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
      schemaVersion: row.schema_version ?? undefined,
      entryScene: row.entry_scene ?? undefined,
      previewUrl: row.preview_url ?? undefined,
      createdBy: row.created_by ?? undefined,
      contentType: row.content_type,
      provider: row.provider,
      version: row.version,
      status: row.status,
      isCurrent: row.is_current,
      createdAt: new Date(row.created_at).toISOString()
    } : null;
  }
  async createSceneBundle(input: SceneBundleCreateInput & { publicUrl: string; provider: SceneBundleRecord["provider"] }): Promise<SceneBundleRecord> {
    const existingVersion = await this.pool.query(`select 1 from scene_bundles where bundle_id = $1 and version = $2 limit 1`, [input.bundleId ?? null, input.version ?? "v1"]);
    if (existingVersion.rows[0] && input.bundleId) {
      throw new Error("scene_bundle_version_conflict");
    }
    const record: SceneBundleRecord = {
      bundleId: input.bundleId ?? crypto.randomUUID(),
      storageKey: input.storageKey,
      publicUrl: input.publicUrl,
      checksum: input.checksum,
      sizeBytes: input.sizeBytes,
      schemaVersion: input.schemaVersion,
      entryScene: input.entryScene,
      previewUrl: input.previewUrl,
      createdBy: input.createdBy,
      contentType: input.contentType ?? "application/json",
      provider: input.provider,
      version: input.version ?? "v1",
      status: "active",
      isCurrent: true,
      createdAt: new Date().toISOString()
    };
    await this.pool.query(`update scene_bundles set is_current = false where bundle_id = $1`, [record.bundleId]);
    await this.pool.query(
      `insert into scene_bundles (bundle_id, storage_key, public_url, checksum, size_bytes, schema_version, entry_scene, preview_url, created_by, content_type, provider, version, status, is_current, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)` ,
      [record.bundleId, record.storageKey, record.publicUrl, record.checksum ?? null, record.sizeBytes ?? null, record.schemaVersion ?? null, record.entryScene ?? null, record.previewUrl ?? null, record.createdBy ?? null, record.contentType, record.provider, record.version, record.status, record.isCurrent, record.createdAt]
    );
    return record;
  }
  async updateSceneBundle(bundleId: string, input: SceneBundleUpdateInput): Promise<SceneBundleRecord | null> {
    const existing = input.version
      ? (await this.listSceneBundleVersions(bundleId)).find((item) => item.version === input.version) ?? null
      : await this.getSceneBundle(bundleId);
    if (!existing) return null;
    const updated: SceneBundleRecord = {
      ...existing,
      storageKey: input.storageKey ?? existing.storageKey,
      publicUrl: input.publicUrl ?? existing.publicUrl,
      checksum: input.checksum ?? existing.checksum,
      sizeBytes: input.sizeBytes ?? existing.sizeBytes,
      schemaVersion: input.schemaVersion ?? existing.schemaVersion,
      entryScene: input.entryScene ?? existing.entryScene,
      previewUrl: input.previewUrl ?? existing.previewUrl,
      createdBy: input.createdBy ?? existing.createdBy,
      contentType: input.contentType ?? existing.contentType,
      provider: input.provider ?? existing.provider,
      version: input.version ?? existing.version,
      status: input.status ?? existing.status ?? "active",
      isCurrent: input.isCurrent ?? existing.isCurrent ?? true
    };
    if (updated.isCurrent) {
      await this.pool.query(`update scene_bundles set is_current = false where bundle_id = $1 and version <> $2`, [bundleId, existing.version]);
    }
    await this.pool.query(
      `update scene_bundles set storage_key = $3, public_url = $4, checksum = $5, size_bytes = $6, schema_version = $7, entry_scene = $8, preview_url = $9, created_by = $10, content_type = $11, provider = $12, status = $13, is_current = $14 where bundle_id = $1 and version = $2`,
      [bundleId, existing.version, updated.storageKey, updated.publicUrl, updated.checksum ?? null, updated.sizeBytes ?? null, updated.schemaVersion ?? null, updated.entryScene ?? null, updated.previewUrl ?? null, updated.createdBy ?? null, updated.contentType, updated.provider, updated.status ?? "active", updated.isCurrent ?? true]
    );
    return updated;
  }
  async listSceneBundleVersions(bundleId: string): Promise<SceneBundleRecord[]> {
    const result = await this.pool.query(`select bundle_id, storage_key, public_url, checksum, size_bytes, schema_version, entry_scene, preview_url, created_by, content_type, provider, version, status, is_current, created_at from scene_bundles where bundle_id = $1 order by created_at desc`, [bundleId]);
    return result.rows.map((row: { bundle_id: string; storage_key: string; public_url: string; checksum: string | null; size_bytes: string | number | null; schema_version: number | null; entry_scene: string | null; preview_url: string | null; created_by: string | null; content_type: string; provider: SceneBundleRecord["provider"]; version: string; status: SceneBundleRecord["status"]; is_current: boolean; created_at: string }) => ({
      bundleId: row.bundle_id,
      storageKey: row.storage_key,
      publicUrl: row.public_url,
      checksum: row.checksum ?? undefined,
      sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
      schemaVersion: row.schema_version ?? undefined,
      entryScene: row.entry_scene ?? undefined,
      previewUrl: row.preview_url ?? undefined,
      createdBy: row.created_by ?? undefined,
      contentType: row.content_type,
      provider: row.provider,
      version: row.version,
      status: row.status,
      isCurrent: row.is_current,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }
  async setCurrentSceneBundleVersion(bundleId: string, version: string): Promise<SceneBundleRecord | null> {
    const target = await this.pool.query(`select public_url from scene_bundles where bundle_id = $1 and version = $2`, [bundleId, version]);
    if (!target.rows[0]) return null;
    await this.pool.query(`update scene_bundles set is_current = (version = $2) where bundle_id = $1`, [bundleId, version]);
    return this.getSceneBundle(bundleId);
  }
}

export async function createStorage(): Promise<Storage> {
  if (!process.env.POSTGRES_URL) {
    return new MemoryStorage();
  }

  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
  const storage = new PostgresStorage(pool);
  await initPostgresStorageWithRetry(storage, {
    onRetry: (error, attempt, maxAttempts, retryDelayMs) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`postgres storage init failed on attempt ${attempt}/${maxAttempts}; retrying in ${retryDelayMs}ms: ${message}`);
    }
  });
  return storage;
}
