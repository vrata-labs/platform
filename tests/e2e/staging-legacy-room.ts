import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fixtures from "./staging-legacy-fixtures.json";
import { completeGuestEntry } from "./guest-entry";
import { identityProtocolOf } from "./staging-identity";

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
  // Floor 2 freezes the persisted legacy session lifecycle: v2 authority replaces it, so only
  // floor 1 resets it. Retained rooms therefore keep their v2 Host slot between runs.
  const lifecycle = await identityProtocolOf(request) === 2 ? {} : { sessionControl: {} };
  return request.patch(`/api/rooms/${roomId}`, { ...options, data: {
    roomType: "standard", visibility: "public", guestAllowed: true, sceneBundleUrl: null,
    features: { voice: true, spatialAudio: true, screenShare: true },
    avatarConfig: { avatarsEnabled: true, avatarCatalogUrl: "/assets/avatars/catalog.v1.json", avatarQualityProfile: "desktop-standard", avatarFallbackCapsulesEnabled: true, avatarSeatsEnabled: true },
    ...overrides, status: "active", disabledAt: null, disabledBy: null,
    ...lifecycle, personalState: {}
  } });
}

/** A real invitation link with extra runtime query parameters; the caller revokes it. */
export async function stagingInvitation(request: APIRequestContext, roomId: string, headers: Record<string, string>,
  role: "host" | "member", query: Record<string, string> = {}) {
  const response = await request.post(`/api/rooms/${roomId}/invites`, { headers, data: { role, expiresInSeconds: 900 } });
  expect(response.ok()).toBe(true);
  const { inviteId, inviteLink } = await response.json() as { inviteId: string; inviteLink: string };
  const link = new URL(inviteLink);
  for (const [key, value] of Object.entries(query)) link.searchParams.set(key, value);
  return { link: `${link.pathname}${link.search}`,
    revoke: async () => { expect((await request.post(`/api/rooms/${roomId}/invites/${inviteId}/revoke`, { headers })).ok()).toBe(true); } };
}

/** Enters through a Host invitation on either floor. A retained floor-2 room keeps the Host slot
 * of an earlier run, so the administrator moves it to the participant this run just admitted. */
export async function enterStagingRoomAsHost(page: Page, request: APIRequestContext, roomId: string, headers: Record<string, string>,
  displayName: string, query: Record<string, string> = {}) {
  const invitation = await stagingInvitation(request, roomId, headers, "host", query);
  try {
    await page.goto(invitation.link);
    await completeGuestEntry(page, displayName);
    if (await identityProtocolOf(request) === 2) {
      const role = () => page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role as string | undefined);
      await expect.poll(role, { timeout: 15_000 }).toMatch(/^(host|member)$/);
      if (await role() !== "host") {
        const participantId = await page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId as string);
        // Transfer targets a present participant; presence follows the room-state join.
        await expect.poll(async () => (await request.post(`/api/rooms/${roomId}/host/transfer`, { headers, data: { participantId } })).status(),
          { timeout: 20_000 }).toBe(200);
        await expect.poll(role, { timeout: 20_000 }).toBe("host");
      }
    }
  } catch (error) { await invitation.revoke().catch(() => undefined); throw error; }
  return invitation;
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
