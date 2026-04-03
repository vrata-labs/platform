interface RoomManifest {
  roomId: string;
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
  };
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
  };
}

export interface PresenceState {
  participantId: string;
  displayName: string;
  mode: "desktop" | "mobile" | "vr";
  rootTransform: {
    x: number;
    y: number;
    z: number;
  };
  headTransform?: {
    x: number;
    y: number;
    z: number;
  };
  bodyTransform?: {
    x: number;
    y: number;
    z: number;
  };
  muted: boolean;
  activeMedia: {
    audio: boolean;
    screenShare: boolean;
  };
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

export async function fetchRoomManifest(apiBaseUrl: string, roomId: string): Promise<RoomManifest> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/manifest`, apiBaseUrl));

  if (!response.ok) {
    throw new Error(`failed_to_load_manifest:${response.status}`);
  }

  return (await response.json()) as RoomManifest;
}

export async function fetchRuntimeSpaces(apiBaseUrl: string, roomId: string, search = ""): Promise<RuntimeSpaceOption[]> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/spaces${search}`, apiBaseUrl));

  if (!response.ok) {
    throw new Error(`failed_to_list_runtime_spaces:${response.status}`);
  }

  const payload = (await response.json()) as { items: RuntimeSpaceRecord[] };
  return formatSpaceOptions(payload.items);
}

export interface RuntimeBootResult {
  roomId: string;
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
  avatarConfig: RoomManifest["avatars"];
  envFlags: {
    enterVr: boolean;
    audioJoin: boolean;
    screenShare: boolean;
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
  };
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
  userAgent: string
): Promise<RuntimeBootResult> {
  const manifest = await fetchRoomManifest(apiBaseUrl, roomId);
  const health = await fetchRuntimeHealth(apiBaseUrl);
  const healthFeatures = health.features ?? {};

  return {
    roomId: manifest.roomId,
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
    avatarConfig: manifest.avatars,
    envFlags: {
      enterVr: healthFeatures.xrEnabled ?? true,
      audioJoin: healthFeatures.voiceEnabled ?? true,
      screenShare: healthFeatures.screenShareEnabled ?? true,
      roomStateRealtime: healthFeatures.roomStateRealtimeEnabled ?? true,
      remoteDiagnostics: healthFeatures.remoteDiagnosticsEnabled ?? true,
      sceneBundles: healthFeatures.sceneBundlesEnabled ?? true,
      avatarsEnabled: healthFeatures.avatarsEnabled ?? true,
      avatarPoseBinaryEnabled: healthFeatures.avatarPoseBinaryEnabled ?? true,
      avatarLipsyncEnabled: healthFeatures.avatarLipsyncEnabled ?? false,
      avatarLegIkEnabled: healthFeatures.avatarLegIkEnabled ?? false,
      avatarSeatingEnabled: healthFeatures.avatarSeatingEnabled ?? false,
      avatarCustomizationEnabled: healthFeatures.avatarCustomizationEnabled ?? false,
      avatarFallbackCapsulesEnabled: healthFeatures.avatarFallbackCapsulesEnabled ?? true
    }
  };
}

export async function fetchMediaToken(
  apiBaseUrl: string,
  roomId: string,
  participantId: string
): Promise<MediaTokenResponse> {
  const response = await fetch(new URL("/api/tokens/media", apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
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
  participantId: string
): Promise<VoiceSessionPlan> {
  const manifest = await fetchRoomManifest(apiBaseUrl, roomId);
  const media = await fetchMediaToken(apiBaseUrl, roomId, participantId);

  return {
    roomId,
    participantId,
    livekitUrl: media.livekitUrl,
    token: media.token,
    spatialAudioEnabled: manifest.features.spatialAudio
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
  presence: PresenceState
): Promise<void> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/presence/${presence.participantId}`, apiBaseUrl), {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(presence)
  });

  if (!response.ok) {
    throw new Error(`failed_to_upsert_presence:${response.status}`);
  }
}

export async function removePresence(apiBaseUrl: string, roomId: string, participantId: string): Promise<void> {
  await fetch(new URL(`/api/rooms/${roomId}/presence/${participantId}`, apiBaseUrl), {
    method: "DELETE"
  });
}
