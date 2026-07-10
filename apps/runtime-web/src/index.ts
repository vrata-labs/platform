import { createRoomAccessDebugState, type RoomAccessDebugState, type RoomPermission, type RoomRole } from "@vrata/shared-types";

interface RoomManifest {
  roomId: string;
  roomType?: "standard" | "personal";
  ownerParticipantId?: string | null;
  template: string;
  sceneBundle?: {
    url: string;
  };
  realtime: {
    roomStateUrl: string;
  };
  theme: {
    primaryColor: string;
    accentColor: string;
  };
  assets: Array<{
    assetId: string;
    kind: string;
    url: string;
    processedUrl?: string;
    validationStatus?: "pending" | "validated" | "rejected";
  }>;
  features: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
  avatars: {
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
    roleQueryAllowed: boolean;
    visibility: "public" | "unlisted" | "private";
  };
}

interface StateTokenResponse {
  token: string;
  expiresInSeconds: number;
  access: RoomAccessDebugState;
  role: RoomRole;
  permissions: RoomPermission[];
}

interface MediaTokenResponse {
  token: string;
  expiresInSeconds: number;
  livekitUrl: string;
}

interface RuntimeHealthResponse {
  features?: {
    xrEnabled?: boolean;
    voiceEnabled?: boolean;
    screenShareEnabled?: boolean;
    spatialAudioEnabled?: boolean;
    roomStateRealtimeEnabled?: boolean;
    remoteDiagnosticsEnabled?: boolean;
    sceneBundlesEnabled?: boolean;
    avatarsEnabled?: boolean;
    avatarPoseBinaryEnabled?: boolean;
    avatarLipsyncEnabled?: boolean;
    avatarLegIkEnabled?: boolean;
    avatarSeatingEnabled?: boolean;
    avatarCustomizationEnabled?: boolean;
    avatarFallbackCapsulesEnabled?: boolean;
    roomAccessPolicyEnabled?: boolean;
    hostControlsEnabled?: boolean;
    documentsEnabled?: boolean;
    notesEnabled?: boolean;
    personalRoomsEnabled?: boolean;
  };
}

export type RuntimeNoteScope = "shared" | "private";

export interface RuntimeNoteRecord {
  noteId: string;
  roomId: string;
  scope: RuntimeNoteScope;
  ownerParticipantId?: string | null;
  content: string;
  updatedAt: string | null;
  updatedBy?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
}

export interface RuntimeNoteVersionRecord {
  versionId: string;
  noteId: string;
  roomId: string;
  scope: RuntimeNoteScope;
  ownerParticipantId?: string | null;
  content: string;
  action: "save" | "restore" | "delete";
  restoredFromVersionId?: string | null;
  createdAt: string;
  createdBy?: string | null;
}

export interface RuntimeDocumentRecord {
  documentId: string;
  roomId: string;
  tenantId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  uploadedBy?: string | null;
  uploadedAt: string;
  linkedSurfaceId?: string | null;
  downloadUrl: string;
}

export interface RuntimePersonalPoseState {
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface RuntimePersonalState {
  lastPose?: RuntimePersonalPoseState | null;
}

export interface PresenceState {
  participantId: string;
  displayName: string;
  role?: RoomRole;
  permissions?: RoomPermission[];
  mode: "desktop" | "mobile" | "vr";
  rootTransform: {
    x: number;
    y: number;
    z: number;
    yaw?: number;
    pitch?: number;
    roll?: number;
  };
  headTransform?: {
    x: number;
    y: number;
    z: number;
    yaw?: number;
    pitch?: number;
    roll?: number;
  };
  bodyTransform?: {
    x: number;
    y: number;
    z: number;
    yaw?: number;
    pitch?: number;
    roll?: number;
  };
  audioJoined?: boolean;
  muted: boolean;
  speaking?: boolean;
  activeMedia: {
    audio: boolean;
    screenShare: boolean;
  };
  seq?: number;
  clientTimeMs?: number;
  serverTimeMs?: number;
  updatedAt: string;
}

export interface RuntimeSpaceRecord {
  roomId: string;
  tenantId: string;
  name: string;
  templateId: string;
  roomLink: string;
}

export interface RuntimeSpaceOption extends RuntimeSpaceRecord {
  label: string;
}

export interface RuntimePersonalRoomResponse {
  created: boolean;
  room: {
    roomId: string;
    tenantId: string;
    name: string;
    templateId: string;
    roomType?: "standard" | "personal";
    ownerParticipantId?: string | null;
  };
  roomLink: string;
}

export function resolveJoinMode(userAgent: string): "desktop" | "mobile" {
  return /android|iphone|ipad/i.test(userAgent) ? "mobile" : "desktop";
}

export function describeManifest(manifest: RoomManifest): string {
  return `${manifest.roomId}:${manifest.template}`;
}

export function formatSpaceOptions(spaces: RuntimeSpaceRecord[]): RuntimeSpaceOption[] {
  const nameCounts = new Map<string, number>();
  for (const space of spaces) {
    nameCounts.set(space.name, (nameCounts.get(space.name) ?? 0) + 1);
  }

  return spaces.map((space) => ({
    ...space,
    label: (nameCounts.get(space.name) ?? 0) > 1
      ? `${space.name} (${space.roomId.slice(0, 8)})`
      : space.name
  }));
}

export function resolveCurrentSpace(spaces: RuntimeSpaceRecord[], roomId: string): RuntimeSpaceRecord | null {
  return spaces.find((space) => space.roomId === roomId) ?? null;
}

export async function fetchRoomManifest(apiBaseUrl: string, roomId: string, sessionToken?: string): Promise<RoomManifest> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/manifest`, apiBaseUrl), {
    headers: sessionToken ? { "authorization": `Bearer ${sessionToken}` } : undefined
  });

  if (!response.ok) {
    throw new Error(`failed_to_load_manifest:${response.status}`);
  }

  return (await response.json()) as RoomManifest;
}

export async function fetchStateToken(apiBaseUrl: string, roomId: string, accessRequest: RuntimeAccessRequest): Promise<StateTokenResponse> {
  const response = await fetch(new URL("/api/tokens/state", apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      roomId,
      participantId: accessRequest.participantId,
      displayName: accessRequest.displayName,
      requestedRole: accessRequest.requestedRole,
      inviteToken: accessRequest.inviteToken
    })
  });

  if (response.status === 202 || response.status === 403 || response.status === 401) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; accessRequestId?: string; requestId?: string };
    if (payload.reason) {
      throw new RuntimeAccessError(response.status, payload.reason, payload.accessRequestId, payload.requestId);
    }
  }

  if (!response.ok) {
    throw new Error(`failed_to_load_state_token:${response.status}`);
  }

  return (await response.json()) as StateTokenResponse;
}

export async function fetchRuntimeSpaces(apiBaseUrl: string, roomId: string, search = ""): Promise<RuntimeSpaceOption[]> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/spaces${search}`, apiBaseUrl), {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`failed_to_list_runtime_spaces:${response.status}`);
  }

  const payload = (await response.json()) as { items: RuntimeSpaceRecord[] };
  return formatSpaceOptions(payload.items);
}

export async function openPersonalRoom(apiBaseUrl: string, input: { participantId: string; displayName: string }): Promise<RuntimePersonalRoomResponse> {
  const response = await fetch(new URL("/api/personal-room", apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_open_personal_room:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return (await response.json()) as RuntimePersonalRoomResponse;
}

export async function fetchPersonalRoomState(apiBaseUrl: string, roomId: string, sessionToken: string): Promise<RuntimePersonalState> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/personal-state`, apiBaseUrl), {
    headers: {
      "authorization": `Bearer ${sessionToken}`
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_load_personal_state:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { state: RuntimePersonalState }).state;
}

export async function savePersonalRoomState(apiBaseUrl: string, roomId: string, sessionToken: string, state: RuntimePersonalState): Promise<RuntimePersonalState> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/personal-state`, apiBaseUrl), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    },
    body: JSON.stringify(state)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_save_personal_state:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { state: RuntimePersonalState }).state;
}

export interface RuntimeBootResult {
  roomId: string;
  roomType: "standard" | "personal";
  ownerParticipantId?: string | null;
  template: string;
  sceneBundleUrl?: string;
  roomStateUrl: string;
  theme: {
    primaryColor: string;
    accentColor: string;
  };
  assets: Array<{
    assetId: string;
    kind: string;
    url: string;
    processedUrl?: string;
    validationStatus?: "pending" | "validated" | "rejected";
  }>;
  joinMode: "desktop" | "mobile";
  voiceEnabled: boolean;
  spatialAudioEnabled: boolean;
  screenShareEnabled: boolean;
  guestAllowed: boolean;
  access: RoomAccessDebugState & {
    token: string;
    expiresInSeconds: number;
    roleQueryAllowed: boolean;
  };
  avatarConfig: RoomManifest["avatars"];
  personalState: RuntimePersonalState;
  envFlags: {
    enterVr: boolean;
    audioJoin: boolean;
    screenShare: boolean;
    spatialAudio: boolean;
    roomStateRealtime: boolean;
    remoteDiagnostics: boolean;
    sceneBundles: boolean;
    avatarsEnabled: boolean;
    avatarPoseBinaryEnabled: boolean;
    avatarLipsyncEnabled: boolean;
    avatarLegIkEnabled: boolean;
    avatarSeatingEnabled: boolean;
    avatarCustomizationEnabled: boolean;
    avatarFallbackCapsulesEnabled: boolean;
    hostControlsEnabled: boolean;
    documentsEnabled: boolean;
    notesEnabled: boolean;
    personalRoomsEnabled: boolean;
  };
}

export interface RuntimeAccessRequest {
  participantId: string;
  displayName: string;
  requestedRole?: string | null;
  inviteToken?: string | null;
}

export class RuntimeAccessError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly accessRequestId?: string;
  readonly requestId?: string;

  constructor(status: number, reason: string, accessRequestId?: string, requestId?: string) {
    super(`room_access_denied:${reason}:${status}`);
    this.name = "RuntimeAccessError";
    this.status = status;
    this.reason = reason;
    this.accessRequestId = accessRequestId;
    this.requestId = requestId;
  }
}

export interface RuntimeSessionControlState {
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
  removedParticipants?: Record<string, { removedAt: string; removedBy?: string | null; reason?: string | null }>;
}

export interface RuntimeSessionControlResponse {
  state: RuntimeSessionControlState;
  participant?: {
    participantId: string;
    role: RoomRole;
    permissions: RoomPermission[];
    status: "active" | "blocked";
    reason?: string | null;
  } | null;
  token?: string;
  expiresInSeconds?: number;
  access?: RoomAccessDebugState;
  role?: RoomRole;
  permissions?: RoomPermission[];
}

export interface VoiceSessionPlan {
  roomId: string;
  participantId: string;
  livekitUrl: string;
  token: string;
  spatialAudioEnabled: boolean;
}

export async function fetchRuntimeHealth(apiBaseUrl: string): Promise<RuntimeHealthResponse> {
  const response = await fetch(new URL("/health", apiBaseUrl));

  if (!response.ok) {
    return {};
  }

  return (await response.json()) as RuntimeHealthResponse;
}

export async function bootRuntime(
  apiBaseUrl: string,
  roomId: string,
  userAgent: string,
  accessRequest?: RuntimeAccessRequest
): Promise<RuntimeBootResult> {
  const health = await fetchRuntimeHealth(apiBaseUrl);
  const healthFeatures = health.features ?? {};
  const accessResponse = accessRequest ? await fetchStateToken(apiBaseUrl, roomId, accessRequest) : null;
  const accessDebug = accessResponse?.access ?? createRoomAccessDebugState("guest");
  const manifest = await fetchRoomManifest(apiBaseUrl, roomId, accessResponse?.token);
  const personalState = manifest.roomType === "personal" && accessResponse?.token
    ? await fetchPersonalRoomState(apiBaseUrl, roomId, accessResponse.token).catch(() => ({}))
    : {};

  return {
    roomId: manifest.roomId,
    roomType: manifest.roomType ?? "standard",
    ownerParticipantId: manifest.ownerParticipantId ?? null,
    template: manifest.template,
    sceneBundleUrl: manifest.sceneBundle?.url,
    roomStateUrl: manifest.realtime.roomStateUrl,
    theme: manifest.theme,
    assets: manifest.assets,
    joinMode: resolveJoinMode(userAgent),
    voiceEnabled: manifest.features.voice,
    spatialAudioEnabled: manifest.features.spatialAudio,
    screenShareEnabled: manifest.features.screenShare,
    guestAllowed: manifest.access.guestAllowed,
    access: {
      ...accessDebug,
      token: accessResponse?.token ?? "",
      expiresInSeconds: accessResponse?.expiresInSeconds ?? 0,
      roleQueryAllowed: manifest.access.roleQueryAllowed ?? false
    },
    avatarConfig: manifest.avatars,
    personalState,
    envFlags: {
      enterVr: healthFeatures.xrEnabled ?? true,
      audioJoin: healthFeatures.voiceEnabled ?? true,
      screenShare: healthFeatures.screenShareEnabled ?? true,
      spatialAudio: healthFeatures.spatialAudioEnabled ?? true,
      roomStateRealtime: healthFeatures.roomStateRealtimeEnabled ?? true,
      remoteDiagnostics: healthFeatures.remoteDiagnosticsEnabled ?? true,
      sceneBundles: healthFeatures.sceneBundlesEnabled ?? true,
      avatarsEnabled: healthFeatures.avatarsEnabled ?? true,
      avatarPoseBinaryEnabled: healthFeatures.avatarPoseBinaryEnabled ?? true,
      avatarLipsyncEnabled: healthFeatures.avatarLipsyncEnabled ?? false,
      avatarLegIkEnabled: healthFeatures.avatarLegIkEnabled ?? false,
      avatarSeatingEnabled: healthFeatures.avatarSeatingEnabled ?? false,
      avatarCustomizationEnabled: healthFeatures.avatarCustomizationEnabled ?? false,
      avatarFallbackCapsulesEnabled: healthFeatures.avatarFallbackCapsulesEnabled ?? true,
      hostControlsEnabled: healthFeatures.hostControlsEnabled ?? true,
      documentsEnabled: healthFeatures.documentsEnabled ?? true,
      notesEnabled: healthFeatures.notesEnabled ?? true,
      personalRoomsEnabled: healthFeatures.personalRoomsEnabled ?? true
    }
  };
}

export async function listRoomDocuments(apiBaseUrl: string, roomId: string, sessionToken: string): Promise<RuntimeDocumentRecord[]> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/documents`, apiBaseUrl), {
    headers: {
      "authorization": `Bearer ${sessionToken}`
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_list_documents:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { items: RuntimeDocumentRecord[] }).items;
}

export async function uploadRoomDocument(apiBaseUrl: string, roomId: string, sessionToken: string, file: File): Promise<RuntimeDocumentRecord> {
  const form = new FormData();
  form.set("document", file);
  const response = await fetch(new URL(`/api/rooms/${roomId}/documents`, apiBaseUrl), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${sessionToken}`
    },
    body: form
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_upload_document:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { document: RuntimeDocumentRecord }).document;
}

export async function downloadRoomDocument(apiBaseUrl: string, document: RuntimeDocumentRecord, sessionToken: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(new URL(document.downloadUrl, apiBaseUrl), {
    headers: {
      "authorization": `Bearer ${sessionToken}`
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_download_document:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? document.filename;
  return { blob: await response.blob(), filename };
}

export async function deleteRoomDocument(apiBaseUrl: string, roomId: string, documentId: string, sessionToken: string): Promise<RuntimeDocumentRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/documents/${documentId}`, apiBaseUrl), {
    method: "DELETE",
    headers: {
      "authorization": `Bearer ${sessionToken}`
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_delete_document:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { document: RuntimeDocumentRecord }).document;
}

export async function selectRoomDocumentSurface(apiBaseUrl: string, roomId: string, documentId: string, surfaceId: string | null, sessionToken: string): Promise<RuntimeDocumentRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/documents/${documentId}/surface`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ surfaceId })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_select_document_surface:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { document: RuntimeDocumentRecord }).document;
}

export async function fetchRoomNote(apiBaseUrl: string, roomId: string, scope: RuntimeNoteScope, sessionToken: string): Promise<RuntimeNoteRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/notes/${scope}`, apiBaseUrl), {
    headers: {
      "authorization": `Bearer ${sessionToken}`
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_load_note:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { note: RuntimeNoteRecord }).note;
}

export async function saveRoomNote(apiBaseUrl: string, roomId: string, scope: RuntimeNoteScope, sessionToken: string, content: string): Promise<RuntimeNoteRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/notes/${scope}`, apiBaseUrl), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ content })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_save_note:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { note: RuntimeNoteRecord }).note;
}

export async function listRoomNoteVersions(apiBaseUrl: string, roomId: string, scope: RuntimeNoteScope, sessionToken: string): Promise<RuntimeNoteVersionRecord[]> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/notes/${scope}/versions`, apiBaseUrl), {
    headers: {
      "authorization": `Bearer ${sessionToken}`
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_load_note_versions:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { items: RuntimeNoteVersionRecord[] }).items;
}

export async function restoreRoomNoteVersion(apiBaseUrl: string, roomId: string, scope: RuntimeNoteScope, sessionToken: string, versionId: string): Promise<RuntimeNoteRecord> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/notes/${scope}/restore`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ versionId })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_restore_note:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  return ((await response.json()) as { note: RuntimeNoteRecord }).note;
}

export async function exportRoomNote(apiBaseUrl: string, roomId: string, scope: RuntimeNoteScope, sessionToken: string, format: "markdown" | "json"): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/notes/${scope}/export?format=${format}`, apiBaseUrl), {
    headers: {
      "authorization": `Bearer ${sessionToken}`
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_export_note:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `vrata-${roomId}-${scope}-notes.${format === "json" ? "json" : "md"}`;
  return { blob: await response.blob(), filename };
}

export async function exportRoomNotesArchive(apiBaseUrl: string, roomId: string, sessionToken: string, format: "json" | "zip"): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/notes/export?format=${format}`, apiBaseUrl), {
    headers: {
      "authorization": `Bearer ${sessionToken}`
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { reason?: string; error?: string };
    throw new Error(`failed_to_export_room_notes:${response.status}:${payload.reason ?? payload.error ?? "unknown"}`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `vrata-${roomId}-room-notes.${format}`;
  return { blob: await response.blob(), filename };
}

export async function fetchRoomSessionControl(apiBaseUrl: string, roomId: string, sessionToken: string): Promise<RuntimeSessionControlResponse> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/session-control`, apiBaseUrl), {
    headers: {
      "authorization": `Bearer ${sessionToken}`
    },
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`failed_to_load_session_control:${response.status}`);
  }
  return (await response.json()) as RuntimeSessionControlResponse;
}

export async function runRoomSessionControlAction(apiBaseUrl: string, roomId: string, sessionToken: string, action: "lock" | "unlock" | "end"): Promise<RuntimeSessionControlResponse> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/session-control/${action}`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`failed_to_run_session_control:${action}:${response.status}`);
  }
  return (await response.json()) as RuntimeSessionControlResponse;
}

export async function removeRoomParticipant(apiBaseUrl: string, roomId: string, sessionToken: string, participantId: string): Promise<RuntimeSessionControlResponse> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/participants/${encodeURIComponent(participantId)}/remove`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ reason: "host_removed" })
  });
  if (!response.ok) {
    throw new Error(`failed_to_remove_participant:${response.status}`);
  }
  return (await response.json()) as RuntimeSessionControlResponse;
}

export async function transferRoomHost(apiBaseUrl: string, roomId: string, sessionToken: string, participantId: string): Promise<RuntimeSessionControlResponse> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/host/transfer`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ participantId })
  });
  if (!response.ok) {
    throw new Error(`failed_to_transfer_host:${response.status}`);
  }
  return (await response.json()) as RuntimeSessionControlResponse;
}

export async function grantRoomPresenter(apiBaseUrl: string, roomId: string, sessionToken: string, participantId: string): Promise<RuntimeSessionControlResponse> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/presenters/${encodeURIComponent(participantId)}/grant`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`failed_to_grant_presenter:${response.status}`);
  }
  return (await response.json()) as RuntimeSessionControlResponse;
}

export async function revokeRoomPresenter(apiBaseUrl: string, roomId: string, sessionToken: string, participantId: string): Promise<RuntimeSessionControlResponse> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/presenters/${encodeURIComponent(participantId)}/revoke`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`failed_to_revoke_presenter:${response.status}`);
  }
  return (await response.json()) as RuntimeSessionControlResponse;
}

export async function fetchMediaToken(
  apiBaseUrl: string,
  roomId: string,
  participantId: string,
  sessionToken: string
): Promise<MediaTokenResponse> {
  const response = await fetch(new URL("/api/tokens/media", apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    },
    body: JSON.stringify({
      roomId,
      participantId,
      canPublishAudio: true,
      canPublishVideo: false
    })
  });

  if (!response.ok) {
    throw new Error(`failed_to_load_media_token:${response.status}`);
  }

  return (await response.json()) as MediaTokenResponse;
}

export async function planVoiceSession(
  apiBaseUrl: string,
  roomId: string,
  participantId: string,
  sessionToken: string
): Promise<VoiceSessionPlan> {
  const manifest = await fetchRoomManifest(apiBaseUrl, roomId, sessionToken);
  const health = await fetchRuntimeHealth(apiBaseUrl);
  const healthFeatures = health.features ?? {};
  const media = await fetchMediaToken(apiBaseUrl, roomId, participantId, sessionToken);

  return {
    roomId,
    participantId,
    livekitUrl: media.livekitUrl,
    token: media.token,
    spatialAudioEnabled: manifest.features.spatialAudio && (healthFeatures.spatialAudioEnabled ?? true)
  };
}

export async function listPresence(apiBaseUrl: string, roomId: string): Promise<PresenceState[]> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/presence`, apiBaseUrl));

  if (!response.ok) {
    throw new Error(`failed_to_list_presence:${response.status}`);
  }

  const payload = (await response.json()) as { items: PresenceState[] };
  return payload.items;
}

export async function upsertPresence(
  apiBaseUrl: string,
  roomId: string,
  presence: PresenceState,
  sessionToken: string
): Promise<void> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/presence/${presence.participantId}`, apiBaseUrl), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${sessionToken}`
    },
    body: JSON.stringify(presence)
  });

  if (!response.ok) {
    throw new Error(`failed_to_upsert_presence:${response.status}`);
  }
}

export async function removePresence(apiBaseUrl: string, roomId: string, participantId: string, sessionToken: string): Promise<void> {
  await fetch(new URL(`/api/rooms/${roomId}/presence/${participantId}`, apiBaseUrl), {
    method: "DELETE",
    headers: {
      "authorization": `Bearer ${sessionToken}`
    }
  });
}
