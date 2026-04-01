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

export interface RoomRecord {
  roomId: string;
  tenantId: string;
  templateId: string;
  name: string;
  sceneBundleUrl?: string;
  features: RoomFeatures;
  assetIds: string[];
  theme?: {
    primaryColor: string;
    accentColor: string;
  };
  guestAllowed?: boolean;
  avatarConfig?: RoomAvatarConfig;
}

function defaultAvatarConfig(input?: Partial<RoomAvatarConfig>): RoomAvatarConfig {
  return {
    avatarsEnabled: input?.avatarsEnabled ?? false,
    avatarCatalogUrl: input?.avatarCatalogUrl ?? "/assets/avatars/catalog.v1.json",
    avatarQualityProfile: input?.avatarQualityProfile ?? "desktop-standard",
    avatarFallbackCapsulesEnabled: input?.avatarFallbackCapsulesEnabled ?? true,
    avatarSeatsEnabled: input?.avatarSeatsEnabled ?? false
  };
}

export interface RuntimeDiagnosticRecord {
  participantId: string;
  displayName: string;
  mode: "desktop" | "mobile" | "vr";
  userAgent: string;
  locomotionMode: string;
  audioState: string;
  localPosition: { x: number; z: number };
  xrAxes: { moveX: number; moveY: number; turnX: number };
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
  sceneDebug?: {
    bundleUrl?: string | null;
    state?: string;
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
  createAsset(input: Partial<AssetRecord>): Promise<AssetRecord>;
  updateAsset(assetId: string, input: Partial<AssetRecord>): Promise<AssetRecord | null>;
  deleteAsset(assetId: string): Promise<boolean>;
  addDiagnostic(roomId: string, payload: RuntimeDiagnosticRecord): Promise<void>;
  getDiagnostics(roomId: string): Promise<RuntimeDiagnosticRecord[]>;
  listSceneBundles(): Promise<SceneBundleRecord[]>;
  getSceneBundle(bundleId: string): Promise<SceneBundleRecord | null>;
  createSceneBundle(input: SceneBundleCreateInput & { publicUrl: string; provider: SceneBundleRecord["provider"] }): Promise<SceneBundleRecord>;
  updateSceneBundle(bundleId: string, input: Partial<SceneBundleCreateInput> & { publicUrl?: string; provider?: SceneBundleRecord["provider"] }): Promise<SceneBundleRecord | null>;
  listSceneBundleVersions(bundleId: string): Promise<SceneBundleRecord[]>;
  setCurrentSceneBundleVersion(bundleId: string, version: string): Promise<SceneBundleRecord | null>;
}

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
        sceneBundleUrl: undefined,
        features: { voice: true, spatialAudio: true, screenShare: true },
        assetIds: [],
        theme: {
          primaryColor: "#5fc8ff",
          accentColor: "#163354"
        },
        guestAllowed: true,
        avatarConfig: defaultAvatarConfig()
      }
    ]
  ]);
  private diagnostics = new Map<string, RuntimeDiagnosticRecord[]>();
  private sceneBundles = new Map<string, SceneBundleRecord>();

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
        sceneBundleUrl: input.sceneBundleUrl,
        features: {
          voice: input.features?.voice ?? true,
          spatialAudio: input.features?.spatialAudio ?? true,
        screenShare: input.features?.screenShare ?? false
      },
      assetIds: input.assetIds ?? [],
      theme: input.theme ?? {
        primaryColor: "#5fc8ff",
        accentColor: "#163354"
      },
      guestAllowed: input.guestAllowed ?? true,
      avatarConfig: defaultAvatarConfig(input.avatarConfig)
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
      features: {
        ...existing.features,
        ...input.features
      },
      theme: {
        primaryColor: input.theme?.primaryColor ?? existing.theme?.primaryColor ?? "#5fc8ff",
        accentColor: input.theme?.accentColor ?? existing.theme?.accentColor ?? "#163354"
      },
      assetIds: input.assetIds ?? existing.assetIds,
      guestAllowed: input.guestAllowed ?? existing.guestAllowed ?? true,
      avatarConfig: defaultAvatarConfig({
        ...existing.avatarConfig,
        ...input.avatarConfig
      })
    };
    this.rooms.set(roomId, updated);
    return updated;
  }
  async deleteRoom(roomId: string): Promise<boolean> {
    return this.rooms.delete(roomId);
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
    const record: SceneBundleRecord = {
      bundleId: input.bundleId ?? crypto.randomUUID(),
      storageKey: input.storageKey,
      publicUrl: input.publicUrl,
      checksum: input.checksum,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType ?? "application/json",
      provider: input.provider,
      version: input.version ?? "v1",
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
  async updateSceneBundle(bundleId: string, input: Partial<SceneBundleCreateInput> & { publicUrl?: string; provider?: SceneBundleRecord["provider"] }): Promise<SceneBundleRecord | null> {
    const existing = (await this.listSceneBundleVersions(bundleId)).find((item) => item.version === input.version) ?? await this.getSceneBundle(bundleId);
    if (!existing) return null;
    const updated: SceneBundleRecord = {
      ...existing,
      storageKey: input.storageKey ?? existing.storageKey,
      publicUrl: input.publicUrl ?? existing.publicUrl,
      checksum: input.checksum ?? existing.checksum,
      sizeBytes: input.sizeBytes ?? existing.sizeBytes,
      contentType: input.contentType ?? existing.contentType,
      provider: input.provider ?? existing.provider,
      version: input.version ?? existing.version,
      status: existing.status ?? "active",
      isCurrent: existing.isCurrent ?? true
    };
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
      scene_bundle_url text,
      features jsonb not null,
      asset_ids jsonb not null default '[]'::jsonb,
      theme jsonb not null default '{"primaryColor":"#5fc8ff","accentColor":"#163354"}'::jsonb,
      guest_allowed boolean not null default true,
      avatar_config jsonb not null default '{"avatarsEnabled":false,"avatarCatalogUrl":"/assets/avatars/catalog.v1.json","avatarQualityProfile":"desktop-standard","avatarFallbackCapsulesEnabled":true,"avatarSeatsEnabled":false}'::jsonb
      );
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
      create table if not exists scene_bundles (
        bundle_id text not null,
        storage_key text not null,
        public_url text not null,
        checksum text,
        size_bytes bigint,
        content_type text not null,
        provider text not null,
        version text not null,
        status text not null default 'active',
        is_current boolean not null default true,
        created_at timestamptz not null default now(),
        primary key (bundle_id, version)
      );
    `);
    await this.pool.query(`alter table rooms add column if not exists scene_bundle_url text`);
    await this.pool.query(`alter table rooms add column if not exists avatar_config jsonb not null default '{"avatarsEnabled":false,"avatarCatalogUrl":"/assets/avatars/catalog.v1.json","avatarQualityProfile":"desktop-standard","avatarFallbackCapsulesEnabled":true,"avatarSeatsEnabled":false}'::jsonb`);
    await this.pool.query(`alter table scene_bundles add column if not exists status text not null default 'active'`);
    await this.pool.query(`alter table scene_bundles add column if not exists is_current boolean not null default true`);
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
       `insert into rooms (room_id, tenant_id, template_id, name, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config)
       values ('demo-room','demo-tenant','meeting-room-basic','Demo Room',null,$1::jsonb,'[]'::jsonb,'{"primaryColor":"#5fc8ff","accentColor":"#163354"}'::jsonb,true,$2::jsonb)
       on conflict do nothing`,
       [JSON.stringify({ voice: true, spatialAudio: true, screenShare: true }), JSON.stringify(defaultAvatarConfig())]
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
    const result = await this.pool.query(`select room_id, tenant_id, template_id, name, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config from rooms order by room_id`);
    return result.rows.map((row: { room_id: string; tenant_id: string; template_id: string; name: string; scene_bundle_url: string | null; features: RoomFeatures; asset_ids: string[]; theme: { primaryColor: string; accentColor: string }; guest_allowed: boolean; avatar_config: Partial<RoomAvatarConfig> }) => ({ roomId: row.room_id, tenantId: row.tenant_id, templateId: row.template_id, name: row.name, sceneBundleUrl: row.scene_bundle_url ?? undefined, features: row.features, assetIds: row.asset_ids, theme: row.theme, guestAllowed: row.guest_allowed, avatarConfig: defaultAvatarConfig(row.avatar_config) }));
  }
  async getRoom(roomId: string): Promise<RoomRecord | null> {
    const result = await this.pool.query(`select room_id, tenant_id, template_id, name, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config from rooms where room_id = $1`, [roomId]);
    const row = result.rows[0];
    return row ? { roomId: row.room_id, tenantId: row.tenant_id, templateId: row.template_id, name: row.name, sceneBundleUrl: row.scene_bundle_url ?? undefined, features: row.features, assetIds: row.asset_ids, theme: row.theme, guestAllowed: row.guest_allowed, avatarConfig: defaultAvatarConfig(row.avatar_config) } : null;
  }
  async createRoom(input: Partial<RoomRecord>): Promise<RoomRecord> {
    const room: RoomRecord = {
      roomId: input.roomId ?? crypto.randomUUID(),
      tenantId: input.tenantId ?? "demo-tenant",
      templateId: input.templateId ?? "meeting-room-basic",
      name: input.name ?? "New Room",
      sceneBundleUrl: input.sceneBundleUrl,
      features: {
        voice: input.features?.voice ?? true,
        spatialAudio: input.features?.spatialAudio ?? true,
        screenShare: input.features?.screenShare ?? false
      },
      assetIds: input.assetIds ?? [],
      theme: input.theme ?? {
        primaryColor: "#5fc8ff",
        accentColor: "#163354"
      },
      guestAllowed: input.guestAllowed ?? true,
      avatarConfig: defaultAvatarConfig(input.avatarConfig)
    };
    await this.pool.query(
      `insert into rooms (room_id, tenant_id, template_id, name, scene_bundle_url, features, asset_ids, theme, guest_allowed, avatar_config) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10::jsonb)`,
      [room.roomId, room.tenantId, room.templateId, room.name, room.sceneBundleUrl ?? null, JSON.stringify(room.features), JSON.stringify(room.assetIds), JSON.stringify(room.theme), room.guestAllowed, JSON.stringify(room.avatarConfig)]
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
      features: {
        ...existing.features,
        ...input.features
      },
      theme: {
        primaryColor: input.theme?.primaryColor ?? existing.theme?.primaryColor ?? "#5fc8ff",
        accentColor: input.theme?.accentColor ?? existing.theme?.accentColor ?? "#163354"
      },
      assetIds: input.assetIds ?? existing.assetIds,
      guestAllowed: input.guestAllowed ?? existing.guestAllowed ?? true,
      avatarConfig: defaultAvatarConfig({
        ...existing.avatarConfig,
        ...input.avatarConfig
      })
    };
    await this.pool.query(
      `update rooms set template_id = $2, name = $3, scene_bundle_url = $4, features = $5::jsonb, asset_ids = $6::jsonb, theme = $7::jsonb, guest_allowed = $8, avatar_config = $9::jsonb where room_id = $1`,
      [roomId, updated.templateId, updated.name, updated.sceneBundleUrl ?? null, JSON.stringify(updated.features), JSON.stringify(updated.assetIds), JSON.stringify(updated.theme), updated.guestAllowed, JSON.stringify(updated.avatarConfig)]
    );
    return updated;
  }
  async deleteRoom(roomId: string): Promise<boolean> {
    const result = await this.pool.query(`delete from rooms where room_id = $1`, [roomId]);
    return (result.rowCount ?? 0) > 0;
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
  async listSceneBundles(): Promise<SceneBundleRecord[]> {
    const result = await this.pool.query(`select distinct on (bundle_id) bundle_id, storage_key, public_url, checksum, size_bytes, content_type, provider, version, status, is_current, created_at from scene_bundles order by bundle_id, is_current desc, created_at desc`);
    return result.rows.map((row: { bundle_id: string; storage_key: string; public_url: string; checksum: string | null; size_bytes: string | number | null; content_type: string; provider: SceneBundleRecord["provider"]; version: string; status: SceneBundleRecord["status"]; is_current: boolean; created_at: string }) => ({
      bundleId: row.bundle_id,
      storageKey: row.storage_key,
      publicUrl: row.public_url,
      checksum: row.checksum ?? undefined,
      sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
      contentType: row.content_type,
      provider: row.provider,
      version: row.version,
      status: row.status,
      isCurrent: row.is_current,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }
  async getSceneBundle(bundleId: string): Promise<SceneBundleRecord | null> {
    const result = await this.pool.query(`select bundle_id, storage_key, public_url, checksum, size_bytes, content_type, provider, version, status, is_current, created_at from scene_bundles where bundle_id = $1 order by is_current desc, created_at desc limit 1`, [bundleId]);
    const row = result.rows[0];
    return row ? {
      bundleId: row.bundle_id,
      storageKey: row.storage_key,
      publicUrl: row.public_url,
      checksum: row.checksum ?? undefined,
      sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
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
      contentType: input.contentType ?? "application/json",
      provider: input.provider,
      version: input.version ?? "v1",
      status: "active",
      isCurrent: true,
      createdAt: new Date().toISOString()
    };
    await this.pool.query(`update scene_bundles set is_current = false where bundle_id = $1`, [record.bundleId]);
    await this.pool.query(
      `insert into scene_bundles (bundle_id, storage_key, public_url, checksum, size_bytes, content_type, provider, version, status, is_current, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)` ,
      [record.bundleId, record.storageKey, record.publicUrl, record.checksum ?? null, record.sizeBytes ?? null, record.contentType, record.provider, record.version, record.status, record.isCurrent, record.createdAt]
    );
    return record;
  }
  async updateSceneBundle(bundleId: string, input: Partial<SceneBundleCreateInput> & { publicUrl?: string; provider?: SceneBundleRecord["provider"] }): Promise<SceneBundleRecord | null> {
    const existing = await this.getSceneBundle(bundleId);
    if (!existing) return null;
    const updated: SceneBundleRecord = {
      ...existing,
      storageKey: input.storageKey ?? existing.storageKey,
      publicUrl: input.publicUrl ?? existing.publicUrl,
      checksum: input.checksum ?? existing.checksum,
      sizeBytes: input.sizeBytes ?? existing.sizeBytes,
      contentType: input.contentType ?? existing.contentType,
      provider: input.provider ?? existing.provider,
      version: input.version ?? existing.version,
      status: existing.status ?? "active",
      isCurrent: existing.isCurrent ?? true
    };
    await this.pool.query(
      `update scene_bundles set storage_key = $3, public_url = $4, checksum = $5, size_bytes = $6, content_type = $7, provider = $8, status = $9, is_current = $10 where bundle_id = $1 and version = $2`,
      [bundleId, existing.version, updated.storageKey, updated.publicUrl, updated.checksum ?? null, updated.sizeBytes ?? null, updated.contentType, updated.provider, updated.status ?? "active", updated.isCurrent ?? true]
    );
    return updated;
  }
  async listSceneBundleVersions(bundleId: string): Promise<SceneBundleRecord[]> {
    const result = await this.pool.query(`select bundle_id, storage_key, public_url, checksum, size_bytes, content_type, provider, version, status, is_current, created_at from scene_bundles where bundle_id = $1 order by created_at desc`, [bundleId]);
    return result.rows.map((row: { bundle_id: string; storage_key: string; public_url: string; checksum: string | null; size_bytes: string | number | null; content_type: string; provider: SceneBundleRecord["provider"]; version: string; status: SceneBundleRecord["status"]; is_current: boolean; created_at: string }) => ({
      bundleId: row.bundle_id,
      storageKey: row.storage_key,
      publicUrl: row.public_url,
      checksum: row.checksum ?? undefined,
      sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
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
  await storage.init();
  return storage;
}
