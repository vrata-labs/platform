import { expect, type APIRequestContext, type Page } from "@playwright/test";

export interface M05PosePoint {
  x: number;
  y: number;
  z: number;
}

export interface M05RemoteParticipant {
  participantId: string;
  mode: "desktop" | "mobile" | "vr";
  root: M05PosePoint & { yaw: number };
  head: M05PosePoint & { yaw: number; pitch: number };
  lastSeq: number;
  staleMs: number;
  updateHz: number;
  interpolationDelayMs: number;
  maxObservedJumpM: number;
  audioJoined: boolean;
  muted: boolean;
  speaking: boolean;
  activeAudio: boolean;
  hasVisualEntity: boolean;
  hasAudioNode: boolean;
  appliedRootYaw: number;
  appliedHeadYaw: number;
}

export interface M05DebugState {
  participantId?: string;
  mode?: "desktop" | "mobile" | "vr";
  roomStateConnected?: boolean;
  roomStateMode?: "colyseus" | "api_fallback" | "disconnected";
  remoteAvatarCount?: number;
  localPosition?: { x: number; z: number };
  localPose?: {
    root: M05PosePoint & { yaw: number };
    head: M05PosePoint & { yaw: number; pitch: number };
  };
  remoteParticipants?: M05RemoteParticipant[];
  media?: {
    audioState: "not_joined" | "joining" | "joined" | "muted" | "degraded" | "failed";
    audioJoined: boolean;
    muted: boolean;
    speaking: boolean;
    publishedAudio: boolean;
    audioSource?: "none" | "microphone" | "mock";
    subscribedAudioCount: number;
  };
  localMicLevel?: number;
  speakerOutputLevel?: number;
  spatialAudio?: {
    enabled: boolean;
    fallback: boolean;
    listener: M05PosePoint & { yaw: number };
    remoteSources: Array<M05PosePoint & {
      participantId: string;
      attachedTo: "head" | "body" | "root";
      hasAudioNode?: boolean;
      pannerActive?: boolean;
      audioLevel?: number;
    }>;
  };
  botMode?: string;
  issueCode?: string | null;
  degradedMode?: string;
}

export async function createM05Room(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name,
      avatarConfig: {
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "desktop-standard",
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: true
      }
    }
  });
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { roomId: string };
  return payload.roomId;
}

export function roomPath(roomId: string, query: string): string {
  return `/rooms/${roomId}?${query}`;
}

export async function readM05Debug(page: Page): Promise<M05DebugState | null> {
  return page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: unknown }).__VRATA_DEBUG__ ?? null) as Promise<M05DebugState | null>;
}

export async function waitForM05Debug(page: Page): Promise<void> {
  await expect.poll(async () => {
    const debug = await readM05Debug(page);
    return Boolean(debug?.participantId && debug.localPose && debug.media && debug.spatialAudio && Array.isArray(debug.remoteParticipants));
  }, {
    timeout: 15000,
    intervals: [250, 500, 1000]
  }).toBeTruthy();
}

export async function waitForRemoteCount(page: Page, expectedCount: number, timeout = 20000): Promise<void> {
  await expect.poll(async () => {
    const debug = await readM05Debug(page);
    return debug?.remoteAvatarCount ?? -1;
  }, {
    timeout,
    intervals: [500, 1000, 2000]
  }).toBe(expectedCount);
}

export async function waitForConnectedOrFallback(page: Page): Promise<void> {
  await expect.poll(async () => {
    const debug = await readM05Debug(page);
    return debug?.roomStateMode ?? null;
  }, {
    timeout: 15000,
    intervals: [500, 1000, 2000]
  }).toMatch(/^(colyseus|api_fallback)$/);
}
