export function createRoomUrl(baseUrl: string, roomId: string): string {
  return new URL(`/rooms/${roomId}`, baseUrl).toString();
}

export interface TemplateRecord {
  templateId: string;
  label: string;
  assetSlots: string[];
}

export interface TenantRecord {
  tenantId: string;
  name: string;
}

export interface RoomCreateInput {
  tenantId: string;
  templateId: string;
  name: string;
  assetIds?: string[];
  guestAllowed?: boolean;
  theme?: {
    primaryColor: string;
    accentColor: string;
  };
  features?: {
    voice?: boolean;
    spatialAudio?: boolean;
    screenShare?: boolean;
  };
}

export interface ControlPlaneAuth {
  adminToken?: string;
}

export interface RoomRecord {
  roomId: string;
  tenantId: string;
  templateId: string;
  name: string;
  assetIds?: string[];
  guestAllowed?: boolean;
  features?: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
  theme?: {
    primaryColor: string;
    accentColor: string;
  };
  roomLink: string;
}

export interface RoomManifestRecord {
  schemaVersion: number;
  tenantId: string;
  roomId: string;
  template: string;
  theme: {
    primaryColor: string;
    accentColor: string;
  };
  assets: Array<{
    assetId: string;
    kind: string;
    url: string;
  }>;
  features: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
  access: {
    joinMode: "link";
    guestAllowed: boolean;
  };
}

export interface RuntimeDiagnosticRecord {
  participantId: string;
  displayName: string;
  mode: "desktop" | "mobile" | "vr";
  audioState: string;
  screenShareState: string;
  note?: string;
  createdAt: string;
}

export interface AssetUploadInput {
  tenantId: string;
  kind: string;
  url: string;
  processedUrl?: string;
  validationStatus?: "pending" | "validated" | "rejected";
}

export interface AssetRecord {
  assetId: string;
  tenantId: string;
  kind: string;
  url: string;
  validationStatus?: "pending" | "validated" | "rejected";
  processedUrl?: string;
}

export async function fetchTemplates(apiBaseUrl: string): Promise<TemplateRecord[]> {
  const response = await fetch(new URL("/api/templates", apiBaseUrl));
  if (!response.ok) {
    throw new Error(`failed_to_fetch_templates:${response.status}`);
  }

  const payload = (await response.json()) as { items: TemplateRecord[] };
  return payload.items;
}

export async function listTenants(apiBaseUrl: string): Promise<TenantRecord[]> {
  const response = await fetch(new URL("/api/tenants", apiBaseUrl));
  if (!response.ok) {
    throw new Error(`failed_to_list_tenants:${response.status}`);
  }
  const payload = (await response.json()) as { items: TenantRecord[] };
  return payload.items;
}

export async function createTenant(apiBaseUrl: string, input: Partial<TenantRecord>, auth?: ControlPlaneAuth): Promise<TenantRecord> {
  const response = await fetch(new URL("/api/tenants", apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(`failed_to_create_tenant:${response.status}`);
  }

  return (await response.json()) as TenantRecord;
}

export async function updateTenant(apiBaseUrl: string, tenantId: string, input: Partial<TenantRecord>, auth?: ControlPlaneAuth): Promise<TenantRecord> {
  const response = await fetch(new URL(`/api/tenants/${tenantId}`, apiBaseUrl), {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(`failed_to_update_tenant:${response.status}`);
  }
  return (await response.json()) as TenantRecord;
}

export async function deleteTenant(apiBaseUrl: string, tenantId: string, auth?: ControlPlaneAuth): Promise<void> {
  const response = await fetch(new URL(`/api/tenants/${tenantId}`, apiBaseUrl), {
    method: "DELETE",
    headers: { ...authHeaders(auth) }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_delete_tenant:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_delete_tenant:${response.status}`);
  }
}

function authHeaders(auth?: ControlPlaneAuth): Record<string, string> {
  return auth?.adminToken ? { "x-noah-admin-token": auth.adminToken } : {};
}

export async function createRoom(apiBaseUrl: string, input: RoomCreateInput, auth?: ControlPlaneAuth): Promise<RoomRecord> {
  const response = await fetch(new URL("/api/rooms", apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(`failed_to_create_room:${response.status}`);
  }

  return (await response.json()) as RoomRecord;
}

export async function updateRoom(apiBaseUrl: string, roomId: string, input: Partial<RoomCreateInput>, auth?: ControlPlaneAuth): Promise<RoomRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}`, apiBaseUrl), {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(`failed_to_update_room:${response.status}`);
  }

  return (await response.json()) as RoomRecord;
}

export async function deleteRoom(apiBaseUrl: string, roomId: string, auth?: ControlPlaneAuth): Promise<void> {
  const response = await fetch(new URL(`/api/rooms/${roomId}`, apiBaseUrl), {
    method: "DELETE",
    headers: { ...authHeaders(auth) }
  });

  if (!response.ok) {
    throw new Error(`failed_to_delete_room:${response.status}`);
  }
}

export async function listRooms(apiBaseUrl: string): Promise<RoomRecord[]> {
  const response = await fetch(new URL("/api/rooms", apiBaseUrl));

  if (!response.ok) {
    throw new Error(`failed_to_list_rooms:${response.status}`);
  }

  const payload = (await response.json()) as { items: RoomRecord[] };
  return payload.items;
}

export async function fetchRoomManifest(apiBaseUrl: string, roomId: string): Promise<RoomManifestRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/manifest`, apiBaseUrl));

  if (!response.ok) {
    throw new Error(`failed_to_fetch_room_manifest:${response.status}`);
  }

  return (await response.json()) as RoomManifestRecord;
}

export async function fetchRoomDiagnostics(apiBaseUrl: string, roomId: string): Promise<RuntimeDiagnosticRecord[]> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/diagnostics`, apiBaseUrl));

  if (!response.ok) {
    throw new Error(`failed_to_fetch_room_diagnostics:${response.status}`);
  }

  const payload = (await response.json()) as { items: RuntimeDiagnosticRecord[] };
  return payload.items;
}

export async function uploadAsset(apiBaseUrl: string, input: AssetUploadInput, auth?: ControlPlaneAuth): Promise<{ assetId: string }> {
  const response = await fetch(new URL("/api/assets", apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_upload_asset:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_upload_asset:${response.status}`);
  }

  return (await response.json()) as { assetId: string };
}

export async function updateAsset(apiBaseUrl: string, assetId: string, input: Partial<AssetUploadInput>, auth?: ControlPlaneAuth): Promise<AssetRecord> {
  const response = await fetch(new URL(`/api/assets/${assetId}`, apiBaseUrl), {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_update_asset:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_update_asset:${response.status}`);
  }

  return (await response.json()) as AssetRecord;
}

export async function deleteAsset(apiBaseUrl: string, assetId: string, auth?: ControlPlaneAuth): Promise<void> {
  const response = await fetch(new URL(`/api/assets/${assetId}`, apiBaseUrl), {
    method: "DELETE",
    headers: { ...authHeaders(auth) }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_delete_asset:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_delete_asset:${response.status}`);
  }
}

export async function listAssets(apiBaseUrl: string): Promise<AssetRecord[]> {
  const response = await fetch(new URL("/api/assets", apiBaseUrl));

  if (!response.ok) {
    throw new Error(`failed_to_list_assets:${response.status}`);
  }

  const payload = (await response.json()) as { items: AssetRecord[] };
  return payload.items;
}

export interface ControlPlanePageState {
  tenants: TenantRecord[];
  selectedTenant?: TenantRecord;
  roomFilterTenantId?: string;
  templates: TemplateRecord[];
  selectedTemplate?: TemplateRecord;
  rooms: RoomRecord[];
  assets: AssetRecord[];
  selectedAsset?: AssetRecord;
  selectedRoom?: RoomRecord;
  selectedRoomManifest?: RoomManifestRecord;
  selectedRoomDiagnostics: RuntimeDiagnosticRecord[];
  roomLink?: string;
  publishStatus: "idle" | "publishing" | "published" | "failed";
  statusMessage?: string;
}

export function createControlPlanePageState(): ControlPlanePageState {
  return {
    templates: [],
    tenants: [],
    roomFilterTenantId: undefined,
    rooms: [],
    assets: [],
    selectedRoomDiagnostics: [],
    publishStatus: "idle",
    statusMessage: "idle"
  };
}
