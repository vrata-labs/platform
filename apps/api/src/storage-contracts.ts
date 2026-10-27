import type { RoomTemplateCatalogRecord, RoomTemplateSnapshotV1, RoomTemplateVersionSnapshotV1 } from "@vrata/shared-types";
import type { SceneBundleCreateInput, SceneBundleRecord } from "./scene-bundle-storage.js";
import type { ReferenceCatalogState, TemplateCatalogPointer } from "@vrata/templates";

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
  protocolVersion?: 1 | 2;
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
  managed?: ManagedRoomState;
}

export type ManagedRoomKind = "reference" | "demo-instance";

export type ManagedRoomStatus = "active" | "paused" | "closed";

/** Features a demo policy allows; upload and remote browser are always off for demos. */
export interface ManagedRoomFeatures {
  voice: boolean;
  screenShare: boolean;
  documents: boolean;
}

// Access terms of a room created through the integration API; only integration storage methods write them.
export interface ManagedRoomState {
  managedBy: string;
  kind: ManagedRoomKind;
  status: ManagedRoomStatus;
  accessUntil: string;
  graceSeconds: number;
  revision: number;
  ownerSubject?: string | null;
  lastOperationId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Random id of the current LiveKit room generation; rotated when access is withdrawn. */
  accessEpoch: string;
  closedAt?: string | null;
  closeReason?: string | null;
  demoPolicyId?: string | null;
  maxParticipants?: number | null;
  idleTimeoutSeconds?: number | null;
  features?: ManagedRoomFeatures | null;
}

export interface ManagedRoomCreateInput {
  managedBy: string;
  kind: ManagedRoomKind;
  accessUntil: string;
  graceSeconds: number;
  ownerSubject?: string | null;
  operationId: string;
  demoPolicyId?: string | null;
  maxParticipants?: number | null;
  idleTimeoutSeconds?: number | null;
  features?: ManagedRoomFeatures | null;
}

export type ManagedRoomBlockReason = "room_closed" | "access_expired" | "room_paused";
export type ManagedRoomGrantPurpose = "visit" | "invite";
export type ManagedRoomGrantRole = "guest" | "member" | "presenter" | "host";

export interface ManagedRoomGrantRecord {
  grantId: string;
  roomId: string;
  tenantId: string;
  role: ManagedRoomGrantRole;
  /** The portal account (acct_<ULID>) of a member, presenter or host grant; null for a guest. */
  subject: string | null;
  purpose: ManagedRoomGrantPurpose;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  displayName: string | null;
  returnContext: unknown;
  revision: number;
  lastOperationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedRoomGrantInput {
  grantId: string;
  roomId: string;
  role: ManagedRoomGrantRole;
  subject?: string | null;
  purpose: ManagedRoomGrantPurpose;
  maxUses: number;
  expiresAt: string;
  /** HMAC of the one-time code; the code itself is never stored. */
  codeHash: string;
  displayName?: string | null;
  returnContext?: unknown;
  operationId: string;
}

export type ManagedRoomGrantConsumeResult =
  | { ok: true; grant: ManagedRoomGrantRecord; room: RoomRecord }
  | { ok: false; code: "grant_invalid" | "grant_revoked" | "capacity_full" | ManagedRoomBlockReason };

/** What the access enforcer needs to know about one managed room. */
export interface ManagedRoomEnforcementRecord {
  roomId: string;
  tenantId: string;
  kind: ManagedRoomKind;
  status: ManagedRoomStatus;
  cutoff: string;
  accessEpoch: string;
  /** The withdrawal the enforcer already acted on, null while the room is open. */
  enforcedBlock: ManagedRoomBlockReason | null;
  retiredEpochs: string[];
  rotateRequestedAt: string | null;
  idleTimeoutSeconds: number | null;
  lastActivityAt: string | null;
  createdAt: string;
  revision: number;
}

export interface ManagedRoomActivity {
  roomId: string;
  tenantId: string;
  participantSeconds: number;
}

export interface ManagedRoomAccessPatch {
  accessUntil?: string;
  graceSeconds?: number;
  status?: ManagedRoomStatus;
}

export interface IntegrationTenantRecord {
  tenantId: string;
  managedBy: string;
  displayName: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type IntegrationOperationState = "running" | "succeeded" | "failed";

export interface IntegrationErrorObject {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
}

export interface IntegrationOperationRecord {
  operationId: string;
  principal: string;
  idempotencyKey: string;
  kind: string;
  requestHash: string;
  state: IntegrationOperationState;
  resourceType: string | null;
  resourceId: string | null;
  resultRevision: number | null;
  error: IntegrationErrorObject | null;
  responseStatus: number | null;
  responseBody: unknown;
  leaseUntil: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationOperationStart {
  operationId: string;
  principal: string;
  idempotencyKey: string;
  kind: string;
  requestHash: string;
  resourceType: string;
  resourceId: string;
  leaseSeconds: number;
}

export interface IntegrationOperationOutcome {
  state: "succeeded" | "failed";
  resultRevision?: number | null;
  error?: IntegrationErrorObject | null;
  responseStatus: number;
  responseBody: unknown;
}

export interface IntegrationStore {
  getIntegrationTenant(tenantId: string): Promise<IntegrationTenantRecord | null>;
  upsertIntegrationTenant(input: { tenantId: string; managedBy: string; displayName: string }): Promise<IntegrationTenantRecord | "tenant_mismatch">;
  createManagedRoom(input: Partial<RoomRecord>, managed: ManagedRoomCreateInput): Promise<RoomRecord>;
  updateManagedRoomAccess(roomId: string, expectedRevision: number, patch: ManagedRoomAccessPatch, operationId: string): Promise<RoomRecord | "revision_mismatch" | "room_closed" | null>;
  beginIntegrationOperation(input: IntegrationOperationStart): Promise<{ created: boolean; operation: IntegrationOperationRecord }>;
  claimIntegrationOperation(operationId: string, leaseSeconds: number): Promise<IntegrationOperationRecord | null>;
  completeIntegrationOperation(operationId: string, outcome: IntegrationOperationOutcome): Promise<IntegrationOperationRecord | null>;
  releaseIntegrationOperation(operationId: string): Promise<void>;
  getIntegrationOperation(principal: string, operationId: string): Promise<IntegrationOperationRecord | null>;
  findIntegrationOperation(principal: string, idempotencyKey: string): Promise<IntegrationOperationRecord | null>;
  recordIntegrationAssertion(principal: string, jti: string, expiresAt: string): Promise<boolean>;
  closeManagedRoom(roomId: string, expectedRevision: number, reason: string | null, operationId: string | null): Promise<RoomRecord | "revision_mismatch" | null>;
  issueManagedRoomGrant(input: ManagedRoomGrantInput): Promise<ManagedRoomGrantRecord | ManagedRoomBlockReason | null>;
  getManagedRoomGrant(grantId: string): Promise<ManagedRoomGrantRecord | null>;
  revokeManagedRoomGrant(grantId: string, reason: string | null, operationId: string): Promise<ManagedRoomGrantRecord | null>;
  consumeManagedRoomGrant(roomId: string, codeHash: string): Promise<ManagedRoomGrantConsumeResult>;
  releaseManagedRoomGrantUse(grantId: string): Promise<void>;
  recordManagedRoomGrantIdentity(grantId: string, identityId: string): Promise<void>;
  listManagedRoomGrantIdentities(grantId: string): Promise<string[]>;
  /** Asks the enforcer to move the room to a new access epoch (after the identities of a revoked grant are revoked). */
  requestManagedRoomRotation(roomId: string): Promise<void>;
  /** Revoked grants whose identities and media were not finished yet (a revoke interrupted on its way). */
  listIncompleteManagedGrantRevocations(): Promise<ManagedRoomGrantRecord[]>;
  /** Revoked grants of one account in one room whose identities are not yet revoked; an entry finishes them first. */
  listIncompleteManagedAccountRevocations(roomId: string, subject: string): Promise<ManagedRoomGrantRecord[]>;
  /** Marks the revoke complete and, for a used grant, asks for a new epoch, once: a second caller does nothing. */
  completeManagedGrantRevocation(grantId: string): Promise<void>;
  listManagedRoomsForEnforcement(): Promise<ManagedRoomEnforcementRecord[]>;
  /** Moves the room to a new access epoch if it is still on expectedEpoch; the old one is queued for deletion. */
  rotateManagedRoomEpoch(roomId: string, expectedEpoch: string, enforcedBlock: ManagedRoomBlockReason | null): Promise<string | null>;
  setManagedRoomEnforcedBlock(roomId: string, enforcedBlock: ManagedRoomBlockReason | null): Promise<void>;
  completeRetiredManagedRoomEpoch(roomId: string, epoch: string): Promise<void>;
  recordManagedRoomActivity(activity: ManagedRoomActivity[]): Promise<void>;
  getIntegrationUsage(tenantId: string, day: string): Promise<{ participantSeconds: number; updatedAt: string | null }>;
  /** Runs fn only in the one process holding the enforcer lock; resolves false when another holds it. */
  withManagedRoomEnforcerLock(fn: () => Promise<void>): Promise<boolean>;
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

export interface Storage extends IntegrationStore {
  readonly roomPlugins: import("./plugins/contracts.js").RoomPluginStorage;
  readonly roomPluginAccess: import("./plugins/access-contracts.js").RoomPluginAccessFactory;
  readonly roomIdentities: import("./identity/contracts.js").RoomIdentityStorage;
  readonly identityProtocol: import("./identity/protocol.js").IdentityProtocolPolicy;
  /** Synchronous response release only: no arbitrary DB/network callback or retained facade. */
  releasePersonalRoomOwnerResponse(proof: import("@vrata/shared-types/identity-credential").RoomIdentityCredential,
    send: (room: RoomRecord, identity: import("./identity/contracts.js").RoomIdentityRecord) => undefined): Promise<void>;
  /** Read-only release for every persisted legacy token: floor 1, unbound, parent then child rows held
   * through COMMIT. `send` runs exactly once, synchronously, after all checks; no DB/network callback. */
  releaseLegacyRoomCredential(selector: LegacyRoomCredentialSelector, options: Pick<LegacyRoomEffectOptions, "lockTimeoutMs" | "idleTimeoutMs">,
    send: (fresh: LegacyRoomCredentialSnapshot) => undefined): Promise<void>;
  /** Floor-1 deferred admission write, floor 1 and unbound: parent, policy, then child rows held through COMMIT; one CAS
   * host seat or one pending insert, both leases rechecked before decide, before and after SQL, and before COMMIT. */
  writeLegacyAdmission(input: LegacyAdmissionWriteInput, options: Pick<LegacyRoomEffectOptions, "lockTimeoutMs" | "idleTimeoutMs">):
    Promise<LegacyAdmissionWriteReceipt>;
  /** Floor-1 legacy session control, floor 1 and unbound: parent NO KEY UPDATE then policy SHARE; the pure reducer decides on the
   * fresh raw row at the store's instant; at most one CAS merge of its patch into the raw column. Original lease rechecked before
   * decide, before and after SQL, and before COMMIT. No send or projection inside; the receipt follows a known COMMIT. */
  applyLegacyRoomControl(input: import("./identity/legacy-room-control.js").LegacyRoomControlInput,
    options: import("./identity/legacy-room-control.js").LegacyRoomControlOptions): Promise<LegacyRoomControlReceipt>;
  withRoomIdentityEffect<T>(guard: import("./identity/effect-write-guard.js").RoomEffectGuard,
    effect: (scoped: RoomIdentityEffectStorage, current: import("./identity/effect-write-guard.js").RoomEffectActor) => Promise<T>): Promise<T>;
  withLegacyRoomEffect<T>(scope: { tenantId: string; roomId: string }, options: LegacyRoomEffectOptions,
    effect: (scoped: RoomIdentityEffectStorage) => Promise<T>): Promise<T>;
  /** A media grant without a room identity (the remote-browser executor): parent row SHARE, then policy SHARE; the pinned codec,
   * namespace and room generation must be current, then `release` runs synchronously inside. Throws MediaBoundaryChanged or
   * room_not_found; nothing is released then. */
  releaseMediaGrant(scope: { tenantId: string; roomId: string }, media: import("./identity/effect-write-guard.js").MediaGrantPin,
    release: () => void): Promise<void>;
  /** Absent in every tenant, floor 1, unbound; grants nothing on a persisted room. */
  withLegacyVirtualRoomEffect<T>(roomId: string, options: VirtualRoomEffectOptions,
    effect: (scoped: VirtualRoomEffectStorage) => Promise<T>): Promise<T>;
  setRoomSceneBundleUrl(tenantId: string, roomId: string, sceneBundleUrl: string): Promise<RoomRecord | null>;
  getPersonalRoomState(tenantId: string, roomId: string): Promise<RoomPersonalState | null>;
  updatePersonalRoomState(tenantId: string, roomId: string, state: RoomPersonalState): Promise<RoomPersonalState | null>;
  reserveIdentityAdmission(input: import("./identity/admission-limits.js").AdmissionLimitInput): Promise<boolean>;
  hasRoomIdentityAuthority(roomId: string): Promise<boolean>;
  listTenants(): Promise<TenantRecord[]>;
  createTenant(input: Partial<TenantRecord>): Promise<TenantRecord>;
  updateTenant(tenantId: string, input: Partial<TenantRecord>): Promise<TenantRecord | null>;
  deleteTenant(tenantId: string): Promise<boolean>;
  listTemplates(): Promise<TemplateRecord[]>;
  transitionReferenceTemplateCatalog(target: ReferenceCatalogState): Promise<TemplateCatalogPointer[]>;
  getTemplateVersion(templateId: string, version?: string): Promise<RoomTemplateVersionSnapshotV1 | null>;
  listAssets(): Promise<AssetRecord[]>;
  listRooms(): Promise<RoomRecord[]>;
  getRoom(roomId: string): Promise<RoomRecord | null>;
  createRoom(input: Partial<RoomRecord>): Promise<RoomRecord>;
  /** Administrative metadata receipt, not a grant; floor 2 rejects raw owner/host/presenter seeds. */
  createAdministrativeRoom(input: Partial<RoomRecord>): Promise<RoomRecord>;
  createLegacyPersonalRoom(input: Partial<RoomRecord> & { roomId: string; tenantId: string; ownerParticipantId: string }):
    Promise<{ room: RoomRecord; created: boolean }>;
  createPersonalOwnedRoom(input: Omit<Partial<RoomRecord>, "ownerParticipantId" | "roomType" | "sessionControl"> & { displayName: string }):
    Promise<{ room: RoomRecord; identity: import("./identity/contracts.js").RoomIdentityRecord }>;
  updateRoom(roomId: string, input: Partial<RoomRecord>, expectedTemplateBinding?: ExpectedRoomTemplateBinding): Promise<RoomRecord | null>;
  /** `documentStorageKeys`, when given, receives the object keys of the room's documents (deleted ones included) read in
   * the deleting transaction; use them only after `true`. */
  deleteRoom(roomId: string, pluginDeletion?: { tenantId: string; deletionId: string }, documentStorageKeys?: string[]): Promise<boolean>;
  createRoomInvite(input: Omit<RoomInviteRecord, "inviteId" | "createdAt" | "revokedAt" | "revokedBy"> & { inviteId?: string; createdAt?: string }): Promise<RoomInviteRecord>;
  createRoomInviteV2(input: Omit<RoomInviteRecord, "inviteId" | "createdAt" | "revokedAt" | "revokedBy" | "protocolVersion"> & {
    actor: import("./identity/contracts.js").RoomIdentityActor
  }): Promise<RoomInviteRecord>;
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

/** Only DB-only mutations and the tombstone read belong inside a room fence. */
export type RoomEffectDatabase = Pick<Storage, "upsertRoomNote" | "deleteRoomNote" | "restoreRoomNoteVersion"
  | "createRoomDocument" | "markRoomDocumentDeleted" | "updateRoomDocumentSurface" | "getRoomDocument"
  | "getPersonalRoomState" | "updatePersonalRoomState" | "setRoomSceneBundleUrl"
  | "listRoomInvites" | "revokeRoomInvite" | "listWaitingRoomRequests" | "updateWaitingRoomRequest" | "getRoom"
  | "addDiagnostic" | "addXrTelemetry">;

export type RoomIdentityEffectStorage = RoomEffectDatabase & { releaseResponse(send: () => void): void };
export interface LegacyRoomEffectOptions { roomWrite?: boolean; lockTimeoutMs?: number; idleTimeoutMs?: number }
export interface LegacyRoomCredentialSelector {
  readonly tenantId: string;
  readonly roomId: string;
  readonly participantId: string;
  readonly inviteTokenHash: string | null;
}
/** Invite matches (roomId, tokenHash); waiting matches (roomId, fresh inviteId, participantId); else null. */
export interface LegacyRoomCredentialSnapshot {
  readonly room: Readonly<RoomRecord>;
  readonly invite: Readonly<RoomInviteRecord> | null;
  readonly waiting: Readonly<WaitingRoomRequestRecord> | null;
}
/** `decide` is the trusted pure, synchronous re-evaluation over fresh clones at the store's instant. The store derives
 * every identifier itself (selector subject, pinned invite and row, its own UUID) and validates the answer. */
export interface LegacyAdmissionWriteInput {
  readonly selector: LegacyRoomCredentialSelector;
  readonly mode: "claim_host" | "pending";
  readonly deadline: import("./identity/legacy-admission-write.js").LegacyAdmissionDeadline | null;
  /** The presented MAC's own signed expiry; kind bearer only. */
  readonly presentedBearerDeadline: import("./identity/legacy-admission-write.js").LegacyAdmissionDeadline | null;
  /** Required for a pending write; never read for a host claim. */
  readonly displayName: string | null;
  readonly decide: (fresh: LegacyRoomCredentialSnapshot, atMs: number) => import("./identity/legacy-admission-write.js").LegacyAdmissionWriteDecision;
}
/** Returned only after a known COMMIT; nothing is sent or signed inside the transaction. */
export type LegacyAdmissionWriteReceipt =
  | { readonly kind: "host_ready" }
  | { readonly kind: "pending"; readonly accessRequestId: string; readonly created: boolean }
  | { readonly kind: "refused"; readonly status: 403; readonly reason: string; readonly accessRequestId?: string; readonly fresh: LegacyRoomCredentialSnapshot }
  | { readonly kind: "changed" };
/** Returned only after a known COMMIT. `state` is the stored column as written, sanitized; refused and changed wrote nothing. */
export type LegacyRoomControlReceipt =
  | { readonly kind: "applied"; readonly state: Required<RoomSessionControlState> }
  | { readonly kind: "refused"; readonly status: 400 | 403 | 404; readonly error: string; readonly reason?: string }
  | { readonly kind: "changed" };
/** Read mode admits at most one release; write mode admits telemetry only;
 * pinAbsence requires exactly one release and excludes writes. */
export type VirtualRoomEffectStorage = Pick<RoomEffectDatabase, "addDiagnostic" | "addXrTelemetry"> & { releaseResponse(send: () => void): void };
/** pinAbsence holds absence through release/COMMIT for virtual state-token issuance. */
export type VirtualRoomEffectOptions = LegacyRoomEffectOptions & { expiresAtSeconds?: number; pinAbsence?: boolean };

export type SceneBundleUpdateInput = Partial<SceneBundleCreateInput> & {
  publicUrl?: string;
  provider?: SceneBundleRecord["provider"];
  status?: SceneBundleRecord["status"];
  isCurrent?: boolean;
};
