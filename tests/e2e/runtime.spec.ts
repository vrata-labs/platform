import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("room shell loads and presence is registered", async ({ page, request }) => {
  await page.goto("/rooms/demo-room");
  await page.waitForTimeout(3000);

  await expect(page.locator("#room-name")).toContainText("meeting-room-basic - demo-room");
  await expect(page.locator("#status-line")).toContainText("Joined as");
  await expect(page.locator("#room-state-line")).toContainText(/Room-state:/);
  await expect(page.locator("#start-share")).toBeEnabled();

  const debug = await page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: unknown }).__NOAH_DEBUG__);
  expect(debug).toBeTruthy();
  const debugState = debug as { roomStateConnected?: boolean; roomStateUrl?: string };
  expect(debugState.roomStateUrl).toContain("127.0.0.1:2567");

  const presenceResponse = await request.get("/api/rooms/demo-room/presence");
  const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
  expect(presence.items.length).toBeGreaterThan(0);

  const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
  const diagnostics = (await diagnosticsResponse.json()) as { items: Array<{ note?: string }> };
  expect(diagnostics.items.some((item) => item.note === "runtime_booted")).toBeTruthy();
});

test("room-state service health endpoint responds", async () => {
  const response = await fetch("http://127.0.0.1:2567/health");
  expect(response.ok).toBeTruthy();
  const payload = await response.json();
  expect(payload.service).toBe("room-state");
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
  await expect(page.locator("#template-detail")).toContainText("meeting-room-basic");
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
  await expect(page.locator("#room-detail")).toContainText('"diagnostics"');
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

test("control plane can create tenant and use it for new room", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#tenant-name-input", "E2E Tenant");
  await page.click("#create-tenant");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#tenants-list")).toContainText("E2E Tenant");
  await expect(page.locator("#tenant-select")).toContainText("E2E Tenant");
  await page.reload();
  await expect(page.locator("#room-filter-tenant")).toContainText("E2E Tenant");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Tenant Room");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#room-detail")).toContainText("Tenant Room");
  await expect(page.locator("#rooms-list")).toContainText("Tenant Room");
});

test("control plane can update and delete tenant without dependencies", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#tenant-name-input", "Mutable Tenant");
  await page.click("#create-tenant");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#tenants-list")).toContainText("Mutable Tenant");
  await page.fill("#tenant-name-input", "Updated Tenant");
  await page.click("#update-tenant");
  await expect(page.locator("#publish-status")).toContainText("updated");
  await expect(page.locator("#tenants-list")).toContainText("Updated Tenant");
  await page.click("#delete-tenant");
  await expect(page.locator("#publish-status")).toContainText("deleted");
});

test("control plane blocks tenant delete when rooms depend on it", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#tenant-name-input", "Bound Tenant");
  await page.click("#create-tenant");
  await expect(page.locator("#publish-status")).toContainText("published");
  await page.fill("#room-name-input", "Bound Tenant Room");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await page.click("#delete-tenant");
  await expect(page.locator("#publish-status")).toContainText("failed");
});

test("control plane uploads asset metadata through the browser UI", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#asset-kind-input", "logo");
  await page.fill("#asset-url-input", "https://example.com/test-logo.glb");
  await page.fill("#asset-processed-url-input", "https://cdn.example.com/test-logo.glb");
  await page.click("#create-asset");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#assets-list")).toContainText("https://example.com/test-logo.glb");
  await expect(page.locator("#assets-list")).toContainText("https://cdn.example.com/test-logo.glb");
  await expect(page.locator("#assets-list")).toContainText("validated");
});

test("control plane can update and delete asset without room dependencies", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#asset-kind-input", "logo");
  await page.fill("#asset-url-input", "https://example.com/mutable.glb");
  await page.click("#create-asset");
  await expect(page.locator("#publish-status")).toContainText("published");
  await page.locator('#assets-list button').filter({ hasText: 'https://example.com/mutable.glb' }).first().click();
  await page.fill("#asset-url-input", "https://example.com/updated.glb");
  await page.fill("#asset-processed-url-input", "https://cdn.example.com/updated.glb");
  await page.selectOption("#asset-status-select", "pending");
  await page.click("#update-asset");
  await expect(page.locator("#publish-status")).toContainText("updated");
  await expect(page.locator("#assets-list")).toContainText("https://example.com/updated.glb");
  await expect(page.locator("#assets-list")).toContainText("https://cdn.example.com/updated.glb");
  await expect(page.locator("#assets-list")).toContainText("pending");
  await page.click("#delete-asset");
  await expect(page.locator("#publish-status")).toContainText("deleted");
});

test("control plane blocks asset delete when attached to a room", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#asset-kind-input", "wall-graphic");
  await page.fill("#asset-url-input", "https://example.com/bound.glb");
  await page.click("#create-asset");
  await expect(page.locator("#publish-status")).toContainText("published");
  const assetValue = await page.locator('#asset-select option').filter({ hasText: 'wall-graphic: https://example.com/bound.glb' }).first().getAttribute('value');
  expect(assetValue).toBeTruthy();
  await page.selectOption('#asset-select', String(assetValue));
  await page.selectOption('#template-select', 'showroom-basic');
  await page.fill('#room-name-input', 'Room Using Asset');
  await page.click('#create-room');
  await expect(page.locator('#publish-status')).toContainText('published');
  await page.locator('#assets-list button').filter({ hasText: 'https://example.com/bound.glb' }).first().click();
  await page.click('#delete-asset');
  await expect(page.locator('#publish-status')).toContainText('failed');
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
  await page.selectOption('#template-select', 'showroom-basic');
  await page.fill("#room-name-input", "Asset Attached Room");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#rooms-list")).toContainText("assets:1");
  const href = await page.locator("#room-link").getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(String(href));
  await page.waitForTimeout(2000);
  await expect(page.locator("#branding-line")).toContainText("Attached assets: wall-graphic [validated]");
});

test("control plane blocks rejected asset attachment to room", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#asset-kind-input", "logo");
  await page.fill("#asset-url-input", "https://example.com/rejected.glb");
  await page.selectOption("#asset-status-select", "rejected");
  await page.click("#create-asset");
  await expect(page.locator("#publish-status")).toContainText("published");
  const rejectedAssetValue = await page.locator('#asset-select option').filter({ hasText: 'logo: https://example.com/rejected.glb' }).first().getAttribute('value');
  expect(rejectedAssetValue).toBeTruthy();
  await page.selectOption('#asset-select', String(rejectedAssetValue));
  await page.fill('#room-name-input', 'Rejected Asset Room');
  await page.click('#create-room');
  await expect(page.locator('#publish-status')).toContainText('failed:rejected_asset_not_attachable');
});

test("control plane blocks asset kinds that do not fit template slots", async ({ page }) => {
  await page.goto('/control-plane');
  await page.fill('#admin-token-input', 'test-admin-token');
  await page.fill('#asset-kind-input', 'hero-screen');
  await page.fill('#asset-url-input', 'https://example.com/hero.glb');
  await page.selectOption('#template-select', 'showroom-basic');
  await page.click('#create-asset');
  await expect(page.locator('#publish-status')).toContainText('published');
  const assetValue = await page.locator('#asset-select option').filter({ hasText: 'hero-screen: https://example.com/hero.glb' }).first().getAttribute('value');
  expect(assetValue).toBeTruthy();
  await page.selectOption('#asset-select', String(assetValue));
  await page.fill('#room-name-input', 'Wrong Slot Room');
  await page.click('#create-room');
  await expect(page.locator('#publish-status')).toContainText('failed:asset_kind_not_supported_by_template');
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

test("control plane can disable guest access for a room", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Members Only Room");
  await page.uncheck("#guest-access-input");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  const href = await page.locator("#room-link").getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(String(href));
  await page.waitForTimeout(2000);
  await expect(page.locator("#guest-access-line")).toContainText("Guest access: members only");
});

test("control plane can update selected room settings", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Updatable Room");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await page.fill("#room-name-input", "Updated Room");
  await page.fill("#primary-color-input", "#22aa88");
  await page.click("#update-room");
  await expect(page.locator("#publish-status")).toContainText("updated");
  await expect(page.locator("#room-detail")).toContainText("Updated Room");
  await expect(page.locator("#room-detail")).toContainText("#22aa88");
});

test("control plane can delete selected room", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Delete Me Room");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#room-detail")).toContainText("Delete Me Room");
  await page.click("#delete-room");
  await expect(page.locator("#publish-status")).toContainText("deleted");
  await expect(page.locator("#room-detail")).toContainText("Select a room to inspect details");
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

test("fault-injected mic denied keeps room usable without audio", async ({ page, request }) => {
  await page.goto("/rooms/demo-room?failaudio=mic_denied&debug=1");
  await page.waitForTimeout(2500);
  await page.click("#join-audio");
  await page.waitForTimeout(1000);

  await expect(page.locator("#status-line")).toContainText("Microphone blocked");

  const debug = await page.evaluate(() => (window as Window & {
    __NOAH_DEBUG__?: { issueCode?: string | null; degradedMode?: string; audioState?: string };
  }).__NOAH_DEBUG__);
  expect(debug?.issueCode).toBe("mic_denied");
  expect(debug?.degradedMode).toBe("audio_unavailable");
  expect(debug?.audioState).toBe("degraded");

  const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
  const diagnostics = (await diagnosticsResponse.json()) as { items: Array<{ note?: string; issueCode?: string }> };
  expect(diagnostics.items.some((item) => item.note === "mic_denied" && item.issueCode === "mic_denied")).toBeTruthy();
});

test("fault-injected room-state failure falls back to API mode", async ({ page, request }) => {
  await page.goto("/rooms/demo-room?failroomstate=1&debug=1");
  await page.waitForTimeout(3000);

  await expect(page.locator("#room-state-line")).toContainText("fallback API");

  const debug = await page.evaluate(() => (window as Window & {
    __NOAH_DEBUG__?: { issueCode?: string | null; roomStateMode?: string; degradedMode?: string };
  }).__NOAH_DEBUG__);
  expect(debug?.issueCode).toBe("room_state_failed");
  expect(debug?.roomStateMode).toBe("fallback");
  expect(debug?.degradedMode).toBe("api_fallback");

  const presenceResponse = await request.get("/api/rooms/demo-room/presence");
  const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
  expect(presence.items.length).toBeGreaterThan(0);
});
