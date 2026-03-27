import { Pool } from "pg";

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
}

export interface RoomFeatures {
  voice: boolean;
  spatialAudio: boolean;
  screenShare: boolean;
}

export interface RoomRecord {
  roomId: string;
  tenantId: string;
  templateId: string;
  name: string;
  features: RoomFeatures;
  assetIds: string[];
  theme?: {
    primaryColor: string;
    accentColor: string;
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
  addDiagnostic(roomId: string, payload: RuntimeDiagnosticRecord): Promise<void>;
  getDiagnostics(roomId: string): Promise<RuntimeDiagnosticRecord[]>;
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
        features: { voice: true, spatialAudio: true, screenShare: true },
        assetIds: [],
        theme: {
          primaryColor: "#5fc8ff",
          accentColor: "#163354"
        }
      }
    ]
  ]);
  private diagnostics = new Map<string, RuntimeDiagnosticRecord[]>();

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
      features: {
        voice: input.features?.voice ?? true,
        spatialAudio: input.features?.spatialAudio ?? true,
        screenShare: input.features?.screenShare ?? false
      },
      assetIds: input.assetIds ?? [],
      theme: input.theme ?? {
        primaryColor: "#5fc8ff",
        accentColor: "#163354"
      }
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
      assetIds: input.assetIds ?? existing.assetIds
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
      url: input.url ?? "/assets/demo/placeholder.png"
    };
    this.assets.set(asset.assetId, asset);
    return asset;
  }
  async addDiagnostic(roomId: string, payload: RuntimeDiagnosticRecord): Promise<void> {
    const entries = this.diagnostics.get(roomId) ?? [];
    entries.push(payload);
    while (entries.length > 200) entries.shift();
    this.diagnostics.set(roomId, entries);
  }
  async getDiagnostics(roomId: string): Promise<RuntimeDiagnosticRecord[]> { return this.diagnostics.get(roomId) ?? []; }
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
      features jsonb not null,
      asset_ids jsonb not null default '[]'::jsonb,
      theme jsonb not null default '{"primaryColor":"#5fc8ff","accentColor":"#163354"}'::jsonb
      );
      create table if not exists assets (
        asset_id text primary key,
        tenant_id text not null references tenants(tenant_id),
        kind text not null,
        url text not null
      );
      create table if not exists runtime_diagnostics (
        id bigserial primary key,
        room_id text not null,
        payload jsonb not null,
        created_at timestamptz not null default now()
      );
    `);
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
      `insert into rooms (room_id, tenant_id, template_id, name, features, asset_ids, theme)
       values ('demo-room','demo-tenant','meeting-room-basic','Demo Room',$1::jsonb,'[]'::jsonb,'{"primaryColor":"#5fc8ff","accentColor":"#163354"}'::jsonb)
       on conflict do nothing`,
       [JSON.stringify({ voice: true, spatialAudio: true, screenShare: true })]
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
    const result = await this.pool.query(`select asset_id, tenant_id, kind, url from assets order by asset_id desc`);
    return result.rows.map((row: { asset_id: string; tenant_id: string; kind: string; url: string }) => ({
      assetId: row.asset_id,
      tenantId: row.tenant_id,
      kind: row.kind,
      url: row.url
    }));
  }
  async listRooms(): Promise<RoomRecord[]> {
    const result = await this.pool.query(`select room_id, tenant_id, template_id, name, features, asset_ids, theme from rooms order by room_id`);
    return result.rows.map((row: { room_id: string; tenant_id: string; template_id: string; name: string; features: RoomFeatures; asset_ids: string[]; theme: { primaryColor: string; accentColor: string } }) => ({ roomId: row.room_id, tenantId: row.tenant_id, templateId: row.template_id, name: row.name, features: row.features, assetIds: row.asset_ids, theme: row.theme }));
  }
  async getRoom(roomId: string): Promise<RoomRecord | null> {
    const result = await this.pool.query(`select room_id, tenant_id, template_id, name, features, asset_ids, theme from rooms where room_id = $1`, [roomId]);
    const row = result.rows[0];
    return row ? { roomId: row.room_id, tenantId: row.tenant_id, templateId: row.template_id, name: row.name, features: row.features, assetIds: row.asset_ids, theme: row.theme } : null;
  }
  async createRoom(input: Partial<RoomRecord>): Promise<RoomRecord> {
    const room: RoomRecord = {
      roomId: input.roomId ?? crypto.randomUUID(),
      tenantId: input.tenantId ?? "demo-tenant",
      templateId: input.templateId ?? "meeting-room-basic",
      name: input.name ?? "New Room",
      features: {
        voice: input.features?.voice ?? true,
        spatialAudio: input.features?.spatialAudio ?? true,
        screenShare: input.features?.screenShare ?? false
      },
      assetIds: input.assetIds ?? [],
      theme: input.theme ?? {
        primaryColor: "#5fc8ff",
        accentColor: "#163354"
      }
    };
    await this.pool.query(
      `insert into rooms (room_id, tenant_id, template_id, name, features, asset_ids, theme) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
      [room.roomId, room.tenantId, room.templateId, room.name, JSON.stringify(room.features), JSON.stringify(room.assetIds), JSON.stringify(room.theme)]
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
      assetIds: input.assetIds ?? existing.assetIds
    };
    await this.pool.query(
      `update rooms set template_id = $2, name = $3, features = $4::jsonb, asset_ids = $5::jsonb, theme = $6::jsonb where room_id = $1`,
      [roomId, updated.templateId, updated.name, JSON.stringify(updated.features), JSON.stringify(updated.assetIds), JSON.stringify(updated.theme)]
    );
    return updated;
  }
  async deleteRoom(roomId: string): Promise<boolean> {
    const result = await this.pool.query(`delete from rooms where room_id = $1`, [roomId]);
    return (result.rowCount ?? 0) > 0;
  }
  async createAsset(input: Partial<AssetRecord>): Promise<AssetRecord> {
    const asset = { assetId: input.assetId ?? crypto.randomUUID(), tenantId: input.tenantId ?? "demo-tenant", kind: input.kind ?? "logo", url: input.url ?? "/assets/demo/placeholder.png" };
    await this.pool.query(`insert into assets (asset_id, tenant_id, kind, url) values ($1,$2,$3,$4)`, [asset.assetId, asset.tenantId, asset.kind, asset.url]);
    return asset;
  }
  async addDiagnostic(roomId: string, payload: RuntimeDiagnosticRecord): Promise<void> {
    await this.pool.query(`insert into runtime_diagnostics (room_id, payload) values ($1,$2::jsonb)`, [roomId, JSON.stringify(payload)]);
    await this.pool.query(`delete from runtime_diagnostics where id in (select id from runtime_diagnostics where room_id = $1 order by id desc offset 200)`, [roomId]);
  }
  async getDiagnostics(roomId: string): Promise<RuntimeDiagnosticRecord[]> {
    const result = await this.pool.query(`select payload from runtime_diagnostics where room_id = $1 order by id asc`, [roomId]);
    return result.rows.map((row: { payload: RuntimeDiagnosticRecord }) => row.payload);
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
