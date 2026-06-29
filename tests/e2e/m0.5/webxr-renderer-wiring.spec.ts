import { expect, test, type Page } from "@playwright/test";

import { readM05Debug, waitForM05Debug } from "./helpers";

async function fulfillHealth(page: Page, xrEnabled: boolean): Promise<void> {
  await page.route("**/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        features: {
          xrEnabled,
          voiceEnabled: true,
          screenShareEnabled: true,
          spatialAudioEnabled: true,
          roomStateRealtimeEnabled: true,
          remoteDiagnosticsEnabled: true,
          sceneBundlesEnabled: true,
          avatarsEnabled: true,
          avatarPoseBinaryEnabled: true,
          avatarFallbackCapsulesEnabled: true
        }
      })
    });
  });
}

test("M0.5 WebXR renderer wiring hides VR entry when XR flag is disabled", async ({ page }) => {
  await fulfillHealth(page, false);

  await page.goto("/rooms/demo-room?debug=1&name=XrDisabled");
  await waitForM05Debug(page);

  await expect.poll(async () => {
    const debug = await readM05Debug(page);
    return debug?.xrSession ?? null;
  }, {
    timeout: 10000,
    intervals: [250, 500, 1000]
  }).toMatchObject({
    rendererXrEnabled: true,
    animationLoop: "xr_compatible",
    cameraRig: "local_pose_controller",
    transformSync: "room_state_presence",
    featureEnabled: false,
    enterVrVisible: false,
    sessionState: "disabled"
  });
  await expect(page.locator(".vr-button")).toHaveCount(0);
  await expect(page.locator("#compatibility-status")).toContainText("VR unavailable");
});

test("M0.5 WebXR enter failure is reported without crashing the room", async ({ page }) => {
  await fulfillHealth(page, true);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "xr", {
      configurable: true,
      value: {
        addEventListener() {},
        isSessionSupported: async () => true,
        requestSession: async () => {
          throw new DOMException("XR blocked by test", "NotAllowedError");
        }
      }
    });
  });

  await page.goto("/rooms/demo-room?debug=1&name=XrFailure");
  await waitForM05Debug(page);
  await expect(page.locator(".vr-button")).toContainText("Enter VR");

  await page.locator(".vr-button").click();

  await expect.poll(async () => {
    const debug = await readM05Debug(page);
    return {
      issueCode: debug?.issueCode ?? null,
      sessionState: debug?.xrSession?.sessionState ?? null,
      lastErrorCode: debug?.xrSession?.lastErrorCode ?? null
    };
  }, {
    timeout: 10000,
    intervals: [250, 500, 1000]
  }).toEqual({
    issueCode: "xr_enter_failed",
    sessionState: "failed",
    lastErrorCode: "NotAllowedError"
  });

  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.locator("#room-name")).toContainText("demo-room");
  await expect(page.locator(".vr-button")).toContainText("Retry VR");
});
