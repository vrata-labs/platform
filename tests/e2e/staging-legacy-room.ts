import { expect, test, type APIRequestContext } from "@playwright/test";
import fixtures from "./staging-legacy-fixtures.json";

type FixtureKey = keyof typeof fixtures;
type RequestOptions = NonNullable<Parameters<APIRequestContext["post"]>[1]>;
const retainedRooms = new Set<string>();

// Legacy behavior is exercised against rooms created before catalog activation.
// New product creates are covered separately; the API never admits deprecated
// creates or scene overrides just to accommodate these regression fixtures.
export async function createLegacyStagingRoom(request: APIRequestContext, key: FixtureKey, options: RequestOptions) {
  const input = options.data as Record<string, unknown>;
  expect(input.templateId).toBe(fixtures[key]);
  const response = await request.get("/api/templates");
  expect(response.ok()).toBe(true);
  const catalog = await response.json();
  if (catalog.items.some((row: { templateId: string; currentVersion: string }) => row.templateId === input.templateId && row.currentVersion === "0.1.0")) {
    return request.post("/api/rooms", options);
  }
  const roomId = `qa-legacy-${key}-${test.info().retry}`;
  const existing = await request.get(`/api/rooms/${roomId}`, { headers: options.headers });
  expect(existing.ok(), `Provision the pinned Wave 2 fixture ${roomId} before activation`).toBe(true);
  const room = await existing.json();
  expect(room.templateId).toBe(fixtures[key]);
  expect(room.templateVersion).toBe("0.1.0");
  retainedRooms.add(roomId);
  const { templateId: _templateId, tenantId: _tenantId, ...overrides } = input;
  return request.patch(`/api/rooms/${roomId}`, { ...options, data: {
    roomType: "standard", visibility: "public", guestAllowed: true, sceneBundleUrl: null,
    features: { voice: true, spatialAudio: true, screenShare: true },
    avatarConfig: { avatarsEnabled: true, avatarCatalogUrl: "/assets/avatars/catalog.v1.json", avatarQualityProfile: "desktop-standard", avatarFallbackCapsulesEnabled: true, avatarSeatsEnabled: true },
    ...overrides, status: "active", disabledAt: null, disabledBy: null,
    sessionControl: {}, personalState: {}
  } });
}

export async function releaseLegacyStagingRoom(request: APIRequestContext, roomId: string, options: RequestOptions) {
  const match = /^qa-legacy-(.+)-[01]$/.exec(roomId);
  if (match && Object.hasOwn(fixtures, match[1]!)) {
    const documents = await request.get(`/api/rooms/${roomId}/documents`, { headers: options.headers });
    if (documents.ok()) {
      for (const document of (await documents.json()).items ?? []) {
        expect((await request.delete(`/api/rooms/${roomId}/documents/${document.documentId}`, { headers: options.headers })).ok()).toBe(true);
      }
    }
    const response = await request.post(`/api/rooms/${roomId}/disable`, options);
    if (response.ok()) retainedRooms.delete(roomId);
    return response;
  }
  return request.delete(`/api/rooms/${roomId}`, options);
}

export async function disableRetainedStagingRooms(request: APIRequestContext, token: string) {
  for (const roomId of retainedRooms) {
    const response = await releaseLegacyStagingRoom(request, roomId, { headers: { "x-vrata-admin-token": token } });
    expect(response.ok(), `disable retained fixture ${roomId}`).toBe(true);
    retainedRooms.delete(roomId);
  }
}
