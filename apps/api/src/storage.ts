import { Pool } from "pg";

import type { SceneBundleCreateInput, SceneBundleRecord } from "./scene-bundle-storage.js";

export interface TenantRecord {
  tenantId: string;
  name: string;
}

export interface TemplateRecord {
  templateId: string;
  label: string;
  assetSlots: string[];
}

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

export interface RoomInviteRecord {
  inviteId: string;
  roomId: string;
  tokenHash: string;
  role: "guest" | "member" | "host" | "admin";
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

export interface RoomSessionControlState {
  hostParticipantId?: string | null;
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
const DEFAULT_SESSION_CONTROL_JSON = '{"hostParticipantId":null,"lockedAt":null,"lockedBy":null,"endedAt":null,"endedBy":null,"removedParticipants":{}}' as const;
const POSTGRES_INIT_MAX_ATTEMPTS = 12;
const POSTGRES_INIT_RETRY_DELAY_MS = 1000;
const RETRYABLE_POSTGRES_INIT_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]);

export interface RoomRecord {
  roomId: string;
  tenantId: string;
  templateId: string;
  name: string;
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
}

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

function defaultRoomVisibility(input?: RoomVisibility): RoomVisibility {
  return input === "private" || input === "unlisted" ? input : "public";
}

function defaultRoomStatus(input?: RoomStatus): RoomStatus {
  return input === "disabled" ? "disabled" : "active";
}

function defaultSessionControl(input?: Partial<RoomSessionControlState> | null): RoomSessionControlState {
  return {
    hostParticipantId: input?.hostParticipantId ?? null,
    lockedAt: input?.lockedAt ?? null,
    lockedBy: input?.lockedBy ?? null,
    endedAt: input?.endedAt ?? null,
    endedBy: input?.endedBy ?? null,
    removedParticipants: input?.removedParticipants ?? {}
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

function mapRoomRow(row: {
  room_id: string;
  tenant_id: string;
  template_id: string;
  name: string;
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
}): RoomRecord {
  return {
    roomId: row.room_id,
    tenantId: row.tenant_id,
    templateId: row.template_id,
    name: row.name,
    status: defaultRoomStatus(row.status),
    disabledAt: isoString(row.disabled_at),
    disabledBy: row.disabled_by ?? null,
    visibility: defaultRoomVisibility(row.visibility),
    sceneBundleUrl: row.scene_bundle_url ?? undefined,
    features: row.features,
    assetIds: row.asset_ids,
    theme: row.theme,
    guestAllowed: row.guest_allowed,
    avatarConfig: defaultAvatarConfig(row.avatar_config),
    sessionControl: defaultSessionControl(row.session_control)
  };
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
  listAssets(): Promise<AssetRecord[]>;
  listRooms(): Promise<RoomRecord[]>;
  getRoom(roomId: string): Promise<RoomRecord | null>;
  createRoom(input: Partial<RoomRecord>): Promise<RoomRecord>;
  updateRoom(roomId: string, input: Partial<RoomRecord>): Promise<RoomRecord | null>;
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

export type SceneBundleUpdateInput = Partial<SceneBundleCreateInput> & {
  publicUrl?: string;
  provider?: SceneBundleRecord["provider"];
  status?: SceneBundleRecord["status"];
  isCurrent?: boolean;
};

const defaultTemplates: TemplateRecord[] = [
  { templateId: "meeting-room-basic", label: "Meeting Room Basic", assetSlots: ["logo", "hero-screen"] },
  { templateId: "showroom-basic", label: "Showroom Basic", assetSlots: ["logo", "wall-graphic"] },
  { templateId: "event-demo-basic", label: "Event Demo Basic", assetSlots: ["logo", "media-placeholder"] }
];

export class MemoryStorage implements Storage {
  private tenants = new Map<string, TenantRecord>([["demo-tenant", { tenantId: "demo-tenant", name: "Demo Tenant" }]]);
  private templates = new Map<string, TemplateRecord>(defaultTemplates.map((item) => [item.templateId, item]));
  private assets = new Map<string, AssetRecord>();
  private rooms = new Map<string, RoomRecord>([
    [
      "demo-room",
      {
        roomId: "demo-room",
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Demo Room",
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
        sessionControl: defaultSessionControl()
      }
    ]
  ]);
  private diagnostics = new Map<string, RuntimeDiagnosticRecord[]>();
  private xrTelemetry = new Map<string, XrTelemetryEventRecord[]>();
  private sceneBundles = new Map<string, SceneBundleRecord>();
  private roomInvites = new Map<string, RoomInviteRecord>();
  private waitingRoomRequests = new Map<string, WaitingRoomRequestRecord>();

  private sceneBundleKey(bundleId: string, version: string): string {
    return `${bundleId}::${version}`;
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
  async listTemplates(): Promise<TemplateRecord[]> { return Array.from(this.templates.values()); }
  async listAssets(): Promise<AssetRecord[]> { return Array.from(this.assets.values()); }
  async listRooms(): Promise<RoomRecord[]> { return Array.from(this.rooms.values()); }
  async getRoom(roomId: string): Promise<RoomRecord | null> { return this.rooms.get(roomId) ?? null; }
  async createRoom(input: Partial<RoomRecord>): Promise<RoomRecord> {
    const room: RoomRecord = {
      roomId: input.roomId ?? crypto.randomUUID(),
      tenantId: input.tenantId ?? "demo-tenant",
      templateId: input.templateId ?? "meeting-room-basic",
      name: input.name ?? "New Room",
      status: defaultRoomStatus(input.status),
      disabledAt: input.disabledAt ?? null,
      disabledBy: input.disabledBy ?? null,
      visibility: defaultRoomVisibility(input.visibility),
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
      guestAllowed: input.guestAllowed ?? true,
      avatarConfig: defaultAvatarConfig(input.avatarConfig),
      sessionControl: defaultSessionControl(input.sessionControl)
    };
    this.rooms.set(room.roomId, room);
    return room;
  }
  async updateRoom(roomId: string, input: Partial<RoomRecord>): Promise<RoomRecord | null> {
    const existing = this.rooms.get(roomId);
    if (!existing) {
      return null;
    }
    const updated: RoomRecord = {
      ...existing,
      ...input,
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
      visibility: defaultRoomVisibility(input.visibility ?? existing.visibility),
      guestAllowed: input.guestAllowed ?? existing.guestAllowed ?? true,
      avatarConfig: defaultAvatarConfig({
        ...existing.avatarConfig,
        ...input.avatarConfig
      }),
      sessionControl: defaultSessionControl(input.sessionControl ?? existing.sessionControl)
    };
    this.rooms.set(roomId, updated);
    return updated;
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
    await this.pool.query(`
      create table if not exists tenants (tenant_id text primary key, name text not null);
      create table if not exists templates (template_id text primary key, label text not null, asset_slots jsonb not null);
      create table if not exists rooms (
        room_id text primary key,
        tenant_id text not null references tenants(tenant_id),
        template_id text not null references templates(template_id),
      name text not null,
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
        session_control jsonb not null default '{"hostParticipantId":null,"lockedAt":null,"lockedBy":null,"endedAt":null,"endedBy":null,"removedParticipants":{}}'::jsonb
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
    `);
    await this.pool.query(`create index if not exists xr_telemetry_room_id_id_idx on xr_telemetry (room_id, id)`);
    await this.pool.query(`alter table rooms add column if not exists scene_bundle_url text`);
    await this.pool.query(`alter table rooms add column if not exists status text not null default 'active'`);
    await this.pool.query(`alter table rooms add column if not exists disabled_at timestamptz`);
    await this.pool.query(`alter table rooms add column if not exists disabled_by text`);
    await this.pool.query(`alter table rooms add column if not exists visibility text not null default 'public'`);
    await this.pool.query(`update rooms set status = 'disabled' where disabled_at is not null and (status is null or status = 'active')`);
    await this.pool.query(`update rooms set visibility = 'private' where guest_allowed = false and (visibility is null or visibility = 'public')`);
    await this.pool.query(`alter table rooms add column if not exists avatar_config jsonb not null default '${DEFAULT_AVATAR_CONFIG_JSON}'::jsonb`);
    await this.pool.query(`update rooms set avatar_config = '${DEFAULT_AVATAR_CONFIG_JSON}'::jsonb where avatar_config is null`);
    await this.pool.query(`update rooms set avatar_config = '${DEFAULT_AVATAR_CONFIG_JSON}'::jsonb || avatar_config`);
    await this.pool.query(`alter table rooms add column if not exists session_control jsonb not null default '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb`);
    await this.pool.query(`alter table rooms alter column session_control set default '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb`);
    await this.pool.query(`update rooms set session_control = '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb where session_control is null`);
    await this.pool.query(`update rooms set session_control = '${DEFAULT_SESSION_CONTROL_JSON}'::jsonb || session_control`);
    await this.pool.query(`alter table scene_bundles add column if not exists status text not null default 'active'`);
    await this.pool.query(`alter table scene_bundles add column if not exists is_current boolean not null default true`);
    await this.pool.query(`alter table scene_bundles add column if not exists schema_version integer`);
    await this.pool.query(`alter table scene_bundles add column if not exists entry_scene text`);
    await this.pool.query(`alter table scene_bundles add column if not exists preview_url text`);
    await this.pool.query(`alter table scene_bundles add column if not exists created_by text`);
    await this.pool.query(`do $$ begin alter table scene_bundles drop constraint if exists scene_bundles_pkey; alter table scene_bundles add primary key (bundle_id, version); exception when duplicate_object then null; end $$;`);
    await this.seed();
  }

  private async seed(): Promise<void> {
    await this.pool.query(`insert into tenants (tenant_id, name) values ('demo-tenant','Demo Tenant') on conflict do nothing`);
    for (const template of defaultTemplates) {
      await this.pool.query(
        `insert into templates (template_id, label, asset_slots) values ($1,$2,$3::jsonb) on conflict do nothing`,
        [template.templateId, template.label, JSON.stringify(template.assetSlots)]
      );
    }
    await this.pool.query(
      `insert into rooms (room_id, tenant_id, template_id, name, status, disabled_at, disabled_by, visibility, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config, session_control)
       values ('demo-room','demo-tenant','meeting-room-basic','Demo Room','active',null,null,'public',null,$1::jsonb,'[]'::jsonb,'{"primaryColor":"#5fc8ff","accentColor":"#163354"}'::jsonb,true,$2::jsonb,$3::jsonb)
       on conflict do nothing`,
      [JSON.stringify({ voice: true, spatialAudio: true, screenShare: true }), JSON.stringify(defaultAvatarConfig()), DEFAULT_SESSION_CONTROL_JSON]
    );
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
    const result = await this.pool.query(`select template_id, label, asset_slots from templates order by template_id`);
    return result.rows.map((row: { template_id: string; label: string; asset_slots: string[] }) => ({ templateId: row.template_id, label: row.label, assetSlots: row.asset_slots }));
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
    const result = await this.pool.query(`select room_id, tenant_id, template_id, name, status, disabled_at, disabled_by, visibility, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config, session_control from rooms order by room_id`);
    return result.rows.map(mapRoomRow);
  }
  async getRoom(roomId: string): Promise<RoomRecord | null> {
    const result = await this.pool.query(`select room_id, tenant_id, template_id, name, status, disabled_at, disabled_by, visibility, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config, session_control from rooms where room_id = $1`, [roomId]);
    const row = result.rows[0];
    return row ? mapRoomRow(row) : null;
  }
  async createRoom(input: Partial<RoomRecord>): Promise<RoomRecord> {
    const room: RoomRecord = {
      roomId: input.roomId ?? crypto.randomUUID(),
      tenantId: input.tenantId ?? "demo-tenant",
      templateId: input.templateId ?? "meeting-room-basic",
      name: input.name ?? "New Room",
      status: defaultRoomStatus(input.status),
      disabledAt: input.disabledAt ?? null,
      disabledBy: input.disabledBy ?? null,
      visibility: defaultRoomVisibility(input.visibility),
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
      guestAllowed: input.guestAllowed ?? true,
      avatarConfig: defaultAvatarConfig(input.avatarConfig),
      sessionControl: defaultSessionControl(input.sessionControl)
    };
    await this.pool.query(
      `insert into rooms (room_id, tenant_id, template_id, name, status, disabled_at, disabled_by, visibility, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config, session_control) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15::jsonb)`,
      [room.roomId, room.tenantId, room.templateId, room.name, room.status, room.disabledAt ?? null, room.disabledBy ?? null, room.visibility, room.sceneBundleUrl ?? null, JSON.stringify(room.features), JSON.stringify(room.assetIds), JSON.stringify(room.theme), room.guestAllowed, JSON.stringify(room.avatarConfig), JSON.stringify(room.sessionControl)]
    );
    return room;
  }
  async updateRoom(roomId: string, input: Partial<RoomRecord>): Promise<RoomRecord | null> {
    const existing = await this.getRoom(roomId);
    if (!existing) {
      return null;
    }
    const updated: RoomRecord = {
      ...existing,
      ...input,
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
      visibility: defaultRoomVisibility(input.visibility ?? existing.visibility),
      guestAllowed: input.guestAllowed ?? existing.guestAllowed ?? true,
      avatarConfig: defaultAvatarConfig({
        ...existing.avatarConfig,
        ...input.avatarConfig
      }),
      sessionControl: defaultSessionControl(input.sessionControl ?? existing.sessionControl)
    };
    await this.pool.query(
      `update rooms set template_id = $2, name = $3, status = $4, disabled_at = $5, disabled_by = $6, visibility = $7, scene_bundle_url = $8, features = $9::jsonb, asset_ids = $10::jsonb, theme = $11::jsonb, guest_allowed = $12, avatar_config = $13::jsonb, session_control = $14::jsonb where room_id = $1`,
      [roomId, updated.templateId, updated.name, updated.status, updated.disabledAt ?? null, updated.disabledBy ?? null, updated.visibility, updated.sceneBundleUrl ?? null, JSON.stringify(updated.features), JSON.stringify(updated.assetIds), JSON.stringify(updated.theme), updated.guestAllowed, JSON.stringify(updated.avatarConfig), JSON.stringify(updated.sessionControl)]
    );
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
