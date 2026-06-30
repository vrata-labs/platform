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
  visibility?: "public" | "unlisted" | "private";
  sceneBundleUrl?: string;
  assetIds?: string[];
  guestAllowed?: boolean;
  avatarConfig?: {
    avatarsEnabled: boolean;
    avatarCatalogUrl?: string;
    avatarQualityProfile: "mobile-lite" | "desktop-standard" | "xr";
    avatarFallbackCapsulesEnabled: boolean;
    avatarSeatsEnabled?: boolean;
  };
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
  sessionToken?: string;
}

export interface RoomRecord {
  roomId: string;
  tenantId: string;
  templateId: string;
  name: string;
  visibility?: "public" | "unlisted" | "private";
  sceneBundleUrl?: string;
  assetIds?: string[];
  guestAllowed?: boolean;
  avatarConfig?: {
    avatarsEnabled: boolean;
    avatarCatalogUrl?: string;
    avatarQualityProfile: "mobile-lite" | "desktop-standard" | "xr";
    avatarFallbackCapsulesEnabled: boolean;
    avatarSeatsEnabled?: boolean;
  };
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
  sceneBundle?: {
    url: string;
  };
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
  avatars?: {
    avatarsEnabled: boolean;
    avatarCatalogUrl?: string;
    avatarQualityProfile: "mobile-lite" | "desktop-standard" | "xr";
    avatarPoseBinaryEnabled: boolean;
    avatarLipsyncEnabled: boolean;
    avatarLegIkEnabled: boolean;
    avatarFallbackCapsulesEnabled: boolean;
    avatarSeatsEnabled: boolean;
    avatarCustomizationEnabled: boolean;
  };
  access: {
    joinMode: "link";
    guestAllowed: boolean;
    visibility?: "public" | "unlisted" | "private";
  };
}

export interface RoomInviteRecord {
  inviteId: string;
  roomId: string;
  role: "guest" | "member" | "host" | "admin";
  waitingRoomEnabled: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  createdBy?: string | null;
  revokedBy?: string | null;
  inviteLink?: string;
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

export interface SceneBundleRecord {
  bundleId: string;
  storageKey: string;
  publicUrl: string;
  checksum?: string;
  sizeBytes?: number;
  contentType: string;
  provider: "minio-default" | "s3-compatible";
  version: string;
  status?: "active" | "obsolete" | "cleanup-ready";
  isCurrent?: boolean;
  createdAt: string;
}

export interface SceneBundleVersionInput {
  storageKey: string;
  publicUrl?: string;
  checksum?: string;
  sizeBytes?: number;
  contentType?: string;
  provider?: "minio-default" | "s3-compatible";
  version: string;
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
  return {
    ...(auth?.adminToken ? { "x-vrata-admin-token": auth.adminToken } : {}),
    ...(auth?.sessionToken ? { "authorization": `Bearer ${auth.sessionToken}` } : {})
  };
}

export async function createRoom(apiBaseUrl: string, input: RoomCreateInput, auth?: ControlPlaneAuth): Promise<RoomRecord> {
  const response = await fetch(new URL("/api/rooms", apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_create_room:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_create_room:${response.status}`);
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
    const payload = await response.json().catch(() => ({ error: `failed_to_update_room:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_update_room:${response.status}`);
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

export async function listRooms(apiBaseUrl: string, auth?: ControlPlaneAuth): Promise<RoomRecord[]> {
  const response = await fetch(new URL("/api/rooms", apiBaseUrl), {
    headers: { ...authHeaders(auth) }
  });

  if (!response.ok) {
    throw new Error(`failed_to_list_rooms:${response.status}`);
  }

  const payload = (await response.json()) as { items: RoomRecord[] };
  return payload.items;
}

export async function fetchRoomManifest(apiBaseUrl: string, roomId: string, auth?: ControlPlaneAuth): Promise<RoomManifestRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/manifest`, apiBaseUrl), {
    headers: { ...authHeaders(auth) }
  });

  if (!response.ok) {
    throw new Error(`failed_to_fetch_room_manifest:${response.status}`);
  }

  return (await response.json()) as RoomManifestRecord;
}

export async function listRoomInvites(apiBaseUrl: string, roomId: string, auth?: ControlPlaneAuth): Promise<RoomInviteRecord[]> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/invites`, apiBaseUrl), {
    headers: { ...authHeaders(auth) }
  });
  if (!response.ok) {
    throw new Error(`failed_to_list_room_invites:${response.status}`);
  }
  const payload = (await response.json()) as { items: RoomInviteRecord[] };
  return payload.items;
}

export async function createRoomInvite(apiBaseUrl: string, roomId: string, input: { expiresInSeconds?: number; waitingRoomEnabled?: boolean }, auth?: ControlPlaneAuth): Promise<RoomInviteRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/invites`, apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_create_room_invite:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_create_room_invite:${response.status}`);
  }
  return (await response.json()) as RoomInviteRecord;
}

export async function revokeRoomInvite(apiBaseUrl: string, roomId: string, inviteId: string, auth?: ControlPlaneAuth): Promise<RoomInviteRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/invites/${inviteId}/revoke`, apiBaseUrl), {
    method: "POST",
    headers: { ...authHeaders(auth) }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_revoke_room_invite:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_revoke_room_invite:${response.status}`);
  }
  return (await response.json()) as RoomInviteRecord;
}

export async function listWaitingRoomRequests(apiBaseUrl: string, roomId: string, auth?: ControlPlaneAuth): Promise<WaitingRoomRequestRecord[]> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/waiting-room`, apiBaseUrl), {
    headers: { ...authHeaders(auth) }
  });
  if (!response.ok) {
    throw new Error(`failed_to_list_waiting_room:${response.status}`);
  }
  const payload = (await response.json()) as { items: WaitingRoomRequestRecord[] };
  return payload.items;
}

export async function decideWaitingRoomRequest(apiBaseUrl: string, roomId: string, requestId: string, decision: "approve" | "reject", auth?: ControlPlaneAuth): Promise<WaitingRoomRequestRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/waiting-room/${requestId}/${decision}`, apiBaseUrl), {
    method: "POST",
    headers: { ...authHeaders(auth) }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_decide_waiting_room:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_decide_waiting_room:${response.status}`);
  }
  return (await response.json()) as WaitingRoomRequestRecord;
}

export async function fetchRoomDiagnostics(apiBaseUrl: string, roomId: string, auth?: ControlPlaneAuth): Promise<RuntimeDiagnosticRecord[]> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/diagnostics`, apiBaseUrl), {
    headers: { ...authHeaders(auth) }
  });

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

export async function listSceneBundles(apiBaseUrl: string): Promise<SceneBundleRecord[]> {
  const response = await fetch(new URL("/api/scene-bundles", apiBaseUrl));
  if (!response.ok) {
    throw new Error(`failed_to_list_scene_bundles:${response.status}`);
  }
  const payload = (await response.json()) as { items: SceneBundleRecord[] };
  return payload.items;
}

export async function listSceneBundleVersions(apiBaseUrl: string, bundleId: string): Promise<SceneBundleRecord[]> {
  const response = await fetch(new URL(`/api/scene-bundles/${bundleId}/versions`, apiBaseUrl));
  if (!response.ok) {
    throw new Error(`failed_to_list_scene_bundle_versions:${response.status}`);
  }
  const payload = (await response.json()) as { items: SceneBundleRecord[] };
  return payload.items;
}

export async function createSceneBundleVersion(apiBaseUrl: string, bundleId: string, input: SceneBundleVersionInput, auth?: ControlPlaneAuth): Promise<SceneBundleRecord> {
  const response = await fetch(new URL(`/api/scene-bundles/${bundleId}/versions`, apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_create_scene_bundle_version:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_create_scene_bundle_version:${response.status}`);
  }
  return (await response.json()) as SceneBundleRecord;
}

export async function setCurrentSceneBundleVersion(apiBaseUrl: string, bundleId: string, version: string, auth?: ControlPlaneAuth): Promise<SceneBundleRecord> {
  const response = await fetch(new URL(`/api/scene-bundles/${bundleId}/current`, apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ version })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_set_current_scene_bundle_version:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_set_current_scene_bundle_version:${response.status}`);
  }
  return (await response.json()) as SceneBundleRecord;
}

export async function updateSceneBundleVersionStatus(apiBaseUrl: string, bundleId: string, version: string, status: NonNullable<SceneBundleRecord["status"]>, auth?: ControlPlaneAuth): Promise<SceneBundleRecord> {
  const response = await fetch(new URL(`/api/scene-bundles/${bundleId}/versions/${version}/status`, apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ status })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_update_scene_bundle_status:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_update_scene_bundle_status:${response.status}`);
  }
  return (await response.json()) as SceneBundleRecord;
}

export async function bindRoomSceneBundle(apiBaseUrl: string, roomId: string, bundleId: string, auth?: ControlPlaneAuth, version?: string): Promise<RoomRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/bind-scene-bundle`, apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify({ bundleId, version })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `failed_to_bind_scene_bundle:${response.status}` }));
    throw new Error(payload.error ?? `failed_to_bind_scene_bundle:${response.status}`);
  }

  return (await response.json()) as RoomRecord;
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
  sceneBundles: SceneBundleRecord[];
  sceneBundleVersions: SceneBundleRecord[];
  assets: AssetRecord[];
  selectedAsset?: AssetRecord;
  selectedRoom?: RoomRecord;
  selectedSceneBundle?: SceneBundleRecord;
  selectedRoomManifest?: RoomManifestRecord;
  selectedRoomDiagnostics: RuntimeDiagnosticRecord[];
  selectedRoomInvites: RoomInviteRecord[];
  selectedWaitingRoomRequests: WaitingRoomRequestRecord[];
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
    sceneBundles: [],
    sceneBundleVersions: [],
    assets: [],
    selectedRoomDiagnostics: [],
    selectedRoomInvites: [],
    selectedWaitingRoomRequests: [],
    publishStatus: "idle",
    statusMessage: "idle"
  };
}
