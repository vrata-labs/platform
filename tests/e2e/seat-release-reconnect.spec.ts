import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { inlineSceneBundleUrl } from "./scene-bundle-fixtures.js";
import type { RuntimeTestApi } from "../../apps/runtime-web/src/testing/runtime-test-api.js";
import { createLegacyStagingRoom, releaseLegacyStagingRoom } from "./staging-legacy-room";

async function seatState(page: Page) {
  return page.evaluate(() => {
    const d = (window as any).__VRATA_DEBUG__;
    return { connected: d?.roomStateConnected, participantId: d?.participantId,
      seatId: d?.currentSeatId, occupancy: d?.seatOccupancy, root: d?.localPose?.root };
  });
}

async function verifyReleaseOnReconnect(page: Page, request: APIRequestContext, staging: boolean) {
  const token = process.env.STAGING_ADMIN_TOKEN ?? (staging ? "" : "test-admin-token");
  expect(token, "admin token required for isolated regression room").not.toBe("");
  const headers = { "x-vrata-admin-token": token };
  const source = inlineSceneBundleUrl({ sceneId: "seat-release-reconnect", label: "Seat reconnect regression" });
  const manifest = JSON.parse(decodeURIComponent(source.slice(source.indexOf(",") + 1)));
  manifest.anchors = { teleportFloorY: 0, seatAnchors: [{ id: "seat-a", position: { x: 0, y: 0, z: 1 }, seatHeight: .48, yaw: 0, radius: .35 }] };
  const created = await createLegacyStagingRoom(request, "seat-reconnect", { headers, data: {
    tenantId: "demo-tenant", templateId: "personal-workspace-basic", name: "Seat reconnect regression", guestAllowed: true,
    sceneBundleUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`,
    avatarConfig: { avatarsEnabled: true, avatarSeatsEnabled: true, avatarFallbackCapsulesEnabled: false }
  } });
  expect(created.ok()).toBe(true);
  const { roomId } = await created.json();
  const observer = await page.context().newPage();
  try {
    await page.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      let transport: WebSocket | undefined;
      window.WebSocket = class extends NativeSocket {
        constructor(address: string | URL, protocols?: string | string[]) {
          super(address, protocols);
          if (new URL(String(address)).searchParams.has("roomId")) transport = this;
        }
      };
      // Keep authentication inside the browser. Do not return or record socket
      // addresses/invite tokens. Multiple sockets are supported by room-state.
      (window as any).__holdParticipantSession = () => new Promise<void>((resolve, reject) => {
        if (!transport) { reject(new Error("room-state transport missing")); return; }
        const hold = new NativeSocket(transport.url);
        (window as any).__heldParticipantSocket = hold;
        hold.addEventListener("error", () => reject(new Error("session socket failed")), { once: true });
        hold.addEventListener("message", event => {
          if (JSON.parse(String(event.data)).type === "room_state") resolve();
        }, { once: true });
      });
    });
    const invite = await request.post(`/api/rooms/${roomId}/invites`, { headers, data: { role: "host", expiresInSeconds: 600 } });
    expect(invite.ok()).toBe(true);
    const link = new URL((await invite.json()).inviteLink);
    link.searchParams.set("debug", "1"); link.searchParams.set("scenefit", "0"); link.searchParams.set("roomstatedelay", "50");
    await page.goto(`${link.pathname}${link.search}`);
    if (await page.locator("#guest-onboarding").isVisible()) {
      await page.locator("#guest-name-input").fill("Reconnect host");
      await page.locator("#guest-enter-without-audio").click();
    }
    await observer.addInitScript(() => sessionStorage.setItem("vrata.participantId", `observer-${crypto.randomUUID()}`));
    await observer.goto(`/rooms/${roomId}?debug=1&scenefit=0`);
    if (await observer.locator("#guest-onboarding").isVisible()) {
      await observer.locator("#guest-name-input").fill("Reconnect observer");
      await observer.locator("#guest-enter-without-audio").click();
    }
    await expect.poll(async () => (await seatState(page)).connected).toBe(true);
    await expect.poll(async () => (await seatState(observer)).connected).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__.sceneDebug?.state)).toBe("loaded");
    const participantId = (await seatState(page)).participantId;
    expect(await page.evaluate(() => (window as Window & { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.requestSeatClaimById("seat-a"))).toBe(true);
    await expect.poll(async () => ({ local: (await seatState(page)).seatId, remote: (await seatState(observer)).occupancy["seat-a"] })).toEqual({ local: "seat-a", remote: participantId });
    await page.evaluate(() => (window as any).__holdParticipantSession());
    expect(await page.evaluate(() => {
      const api = (window as Window & { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__;
      api.forceRoomStateReconnect();
      return api.teleportToFloor(0, 4);
    })).toBe(true);
    await expect.poll(async () => (await seatState(page)).connected, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => ({
      local: (await seatState(page)).seatId,
      localOccupant: (await seatState(page)).occupancy["seat-a"] ?? null,
      remoteOccupant: (await seatState(observer)).occupancy["seat-a"] ?? null
    }), { timeout: 15_000 }).toEqual({ local: null, localOccupant: null, remoteOccupant: null });
    expect((await seatState(page)).root).toMatchObject({ x: 0, y: 0, z: 4 });
  } finally {
    await observer.close();
    await page.goto("about:blank");
    expect((await releaseLegacyStagingRoom(request, roomId, { headers })).ok()).toBe(true);
  }
}

test("seat release survives reconnect while another socket keeps the participant session alive", async ({ page, request }) => {
  test.setTimeout(90_000);
  await verifyReleaseOnReconnect(page, request, false);
});

test("@staging seat release is acknowledged after reconnect with a retained participant session", async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifyReleaseOnReconnect(page, request, true);
});
