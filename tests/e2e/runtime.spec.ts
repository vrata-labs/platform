import { expect, test } from "@playwright/test";

test("room shell loads and presence is registered", async ({ page, request }) => {
  await page.goto("/rooms/demo-room");
  await page.waitForTimeout(3000);

  await expect(page.locator("#room-name")).toContainText("meeting-room-basic - demo-room");
  await expect(page.locator("#status-line")).toContainText("Joined as");

  const debug = await page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: unknown }).__NOAH_DEBUG__);
  expect(debug).toBeTruthy();

  const presenceResponse = await request.get("/api/rooms/demo-room/presence");
  const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
  expect(presence.items.length).toBeGreaterThan(0);

  const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
  const diagnostics = (await diagnosticsResponse.json()) as { items: Array<{ note?: string }> };
  expect(diagnostics.items.some((item) => item.note === "runtime_booted")).toBeTruthy();
});

test("two participants can coexist in same room", async ({ browser, request }) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await pageA.goto("http://127.0.0.1:4000/rooms/demo-room");
  await pageB.goto("http://127.0.0.1:4000/rooms/demo-room");
  await pageA.waitForTimeout(4000);
  await pageB.waitForTimeout(4000);

  const debugA = await pageA.evaluate(() => (window as Window & { __NOAH_DEBUG__?: { remoteAvatarCount: number } }).__NOAH_DEBUG__);
  const debugB = await pageB.evaluate(() => (window as Window & { __NOAH_DEBUG__?: { remoteAvatarCount: number } }).__NOAH_DEBUG__);

  expect(debugA?.remoteAvatarCount).toBeGreaterThanOrEqual(1);
  expect(debugB?.remoteAvatarCount).toBeGreaterThanOrEqual(1);

  const presenceResponse = await request.get("http://127.0.0.1:4000/api/rooms/demo-room/presence");
  const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
  expect(presence.items.length).toBeGreaterThanOrEqual(2);

  await pageA.close();
  await pageB.close();
});

test("bot mode emits movement diagnostics automatically", async ({ page, request }) => {
  await page.goto("/rooms/demo-room?bot=orbit&debug=1");
  await page.waitForTimeout(5000);

  const debug = await page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: { botMode: string; localPosition: { x: number; z: number } } }).__NOAH_DEBUG__);
  expect(debug?.botMode).toBe("orbit");
  expect(Math.abs(debug?.localPosition.x ?? 0) + Math.abs(debug?.localPosition.z ?? 0)).toBeGreaterThan(0.5);

  const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
  const diagnostics = (await diagnosticsResponse.json()) as {
    items: Array<{ botMode?: string; localPosition: { x: number; z: number } }>;
  };
  const recent = diagnostics.items.slice(-3);
  expect(recent.length).toBeGreaterThan(0);
  expect(recent.some((item) => Math.abs(item.localPosition.x) + Math.abs(item.localPosition.z) > 0.5)).toBeTruthy();
});

test("room creation API returns a usable room link", async ({ page, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    data: {
      tenantId: "demo-tenant",
      templateId: "showroom-basic",
      name: "E2E Room",
      features: {
        voice: true,
        spatialAudio: true,
        screenShare: false
      }
    }
  });
  expect(createRoomResponse.ok()).toBeTruthy();

  const room = (await createRoomResponse.json()) as { roomId: string; roomLink: string; manifest: { template: string } };
  expect(room.manifest.template).toBe("showroom-basic");

  await page.goto(room.roomLink.replace("http://127.0.0.1:4000", "http://127.0.0.1:4000"));
  await page.waitForTimeout(3000);
  await expect(page.locator("#room-name")).toContainText(`showroom-basic - ${room.roomId}`);
});

test("diagnostics capture multi-client remote visibility", async ({ browser, request }) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await pageA.goto("http://127.0.0.1:4000/rooms/demo-room?debug=1");
  await pageB.goto("http://127.0.0.1:4000/rooms/demo-room?bot=line&debug=1");
  await pageA.waitForTimeout(5000);
  await pageB.waitForTimeout(5000);

  const diagnosticsResponse = await request.get("http://127.0.0.1:4000/api/rooms/demo-room/diagnostics");
  const diagnostics = (await diagnosticsResponse.json()) as {
    items: Array<{ participantId: string; remoteAvatarCount: number; remoteTargets: Array<{ id: string }> }>;
  };

  expect(diagnostics.items.some((item) => item.remoteAvatarCount >= 1)).toBeTruthy();
  expect(diagnostics.items.some((item) => item.remoteTargets.length >= 1)).toBeTruthy();

  await pageA.close();
  await pageB.close();
});
