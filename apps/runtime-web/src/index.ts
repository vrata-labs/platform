interface RoomManifest {
  roomId: string;
  template: string;
  features: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
}

interface MediaTokenResponse {
  token: string;
  expiresInSeconds: number;
  livekitUrl: string;
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
  muted: boolean;
  activeMedia: {
    audio: boolean;
    screenShare: boolean;
  };
  updatedAt: string;
}

export function resolveJoinMode(userAgent: string): "desktop" | "mobile" {
  return /android|iphone|ipad/i.test(userAgent) ? "mobile" : "desktop";
}

export function describeManifest(manifest: RoomManifest): string {
  return `${manifest.roomId}:${manifest.template}`;
}

export async function fetchRoomManifest(apiBaseUrl: string, roomId: string): Promise<RoomManifest> {
  const response = await fetch(new URL(`/api/rooms/${roomId}/manifest`, apiBaseUrl));

  if (!response.ok) {
    throw new Error(`failed_to_load_manifest:${response.status}`);
  }

  return (await response.json()) as RoomManifest;
}

export interface RuntimeBootResult {
  roomId: string;
  template: string;
  joinMode: "desktop" | "mobile";
  voiceEnabled: boolean;
  spatialAudioEnabled: boolean;
}

export interface VoiceSessionPlan {
  roomId: string;
  participantId: string;
  livekitUrl: string;
  token: string;
  spatialAudioEnabled: boolean;
}

export async function bootRuntime(
  apiBaseUrl: string,
  roomId: string,
  userAgent: string
): Promise<RuntimeBootResult> {
  const manifest = await fetchRoomManifest(apiBaseUrl, roomId);

  return {
    roomId: manifest.roomId,
    template: manifest.template,
    joinMode: resolveJoinMode(userAgent),
    voiceEnabled: manifest.features.voice,
    spatialAudioEnabled: manifest.features.spatialAudio
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
