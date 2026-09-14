import type { RoomTemplateCatalogRecord, RoomTemplateSnapshotV1, RoomTemplateVersionSnapshotV1 } from "@vrata/shared-types";
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
