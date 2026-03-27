import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("room shell loads and presence is registered", async ({ page, request }) => {
  await page.goto("/rooms/demo-room");
  await page.waitForTimeout(3000);

  await expect(page.locator("#room-name")).toContainText("meeting-room-basic - demo-room");
  await expect(page.locator("#status-line")).toContainText("Joined as");
  await expect(page.locator("#start-share")).toBeEnabled();

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
    headers: {
      "x-noah-admin-token": "test-admin-token"
    },
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

test("room creation API is forbidden without admin token", async ({ request }) => {
  const response = await request.post("/api/rooms", {
    data: {
      tenantId: "demo-tenant",
      templateId: "showroom-basic",
      name: "Forbidden Room"
    }
  });
  expect(response.status()).toBe(403);
});

test("room creation API rejects invalid template even with admin token", async ({ request }) => {
  const response = await request.post("/api/rooms", {
    headers: {
      "x-noah-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "bad-template",
      name: "Invalid Room"
    }
  });
  expect(response.status()).toBe(400);
  const payload = await response.json();
  expect(payload.error).toBe("invalid_template");
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

test("control plane creates a room through the browser UI", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Control Plane Room");
  await page.selectOption("#template-select", "showroom-basic");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#room-link")).not.toHaveText("");
  const href = await page.locator("#room-link").getAttribute("href");
  expect(href).toContain("/rooms/");
  await expect(page.locator("#rooms-list li").first()).toContainText("Control Plane Room");
  await page.locator("#rooms-list button").first().click();
  await expect(page.locator("#room-detail")).toContainText("Control Plane Room");
  await expect(page.locator("#room-detail")).toContainText('"manifest"');
});

test("control plane remembers admin token locally", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Remembered Token Room");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await page.reload();
  await expect(page.locator("#admin-token-input")).toHaveValue("test-admin-token");
});

test("control plane uploads asset metadata through the browser UI", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#asset-kind-input", "logo");
  await page.fill("#asset-url-input", "https://example.com/test-logo.glb");
  await page.click("#create-asset");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#assets-list li").first()).toContainText("https://example.com/test-logo.glb");
});

test("control plane rejects invalid asset extension", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#asset-kind-input", "logo");
  await page.fill("#asset-url-input", "https://example.com/invalid.png");
  await page.click("#create-asset");
  await expect(page.locator("#publish-status")).toContainText("failed:unsupported_extension");
});

test("control plane can attach selected assets to a room", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#asset-kind-input", "wall-graphic");
  await page.fill("#asset-url-input", "https://example.com/wall.glb");
  await page.click("#create-asset");
  await expect(page.locator("#publish-status")).toContainText("published");
  const wallAssetValue = await page.locator('#asset-select option').filter({ hasText: 'wall-graphic: https://example.com/wall.glb' }).first().getAttribute('value');
  expect(wallAssetValue).toBeTruthy();
  await page.selectOption("#asset-select", String(wallAssetValue));
  await page.fill("#room-name-input", "Asset Attached Room");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#rooms-list li").first()).toContainText("assets:1");
  const href = await page.locator("#room-link").getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(String(href));
  await page.waitForTimeout(2000);
  await expect(page.locator("#branding-line")).toContainText("Attached assets: wall-graphic");
});

test("control plane can create themed room", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Themed Room");
  await page.fill("#primary-color-input", "#ff6b3d");
  await page.fill("#accent-color-input", "#132a46");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  const href = await page.locator("#room-link").getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(String(href));
  await page.waitForTimeout(2000);
  await expect(page.locator("#room-name")).not.toHaveText("");
  await expect(page.locator("#branding-line")).toContainText(/Attached assets|No branded assets attached/);
});

test("control plane can disable voice and screen share for a room", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Feature Locked Room");
  await page.uncheck("#feature-voice-input");
  await page.uncheck("#feature-share-input");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  const href = await page.locator("#room-link").getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(String(href));
  await page.waitForTimeout(2000);
  await expect(page.locator("#join-audio")).toBeDisabled();
  await expect(page.locator("#start-share")).toBeDisabled();
});

test("mock screen share updates UI and diagnostics", async ({ page, request }) => {
  await page.goto("/rooms/demo-room?sharemock=1&debug=1");
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>("#start-share");
    return Boolean(button && !button.disabled);
  });
  await page.click("#start-share");
  await page.waitForTimeout(2500);

  await expect(page.locator("#join-audio")).toBeEnabled();

  const debug = await page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: { screenShareState: string } }).__NOAH_DEBUG__);
  expect(debug?.screenShareState).toBe("sharing");

  const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
  const diagnostics = (await diagnosticsResponse.json()) as { items: Array<{ note?: string; screenShareState?: string }> };
  expect(diagnostics.items.some((item) => item.note === "screenshare_mock_started")).toBeTruthy();

  await page.click("#stop-share");
  await page.waitForTimeout(1000);
  const debugAfter = await page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: { screenShareState: string } }).__NOAH_DEBUG__);
  expect(debugAfter?.screenShareState).toBe("stopped");
});
