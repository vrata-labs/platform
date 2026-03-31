import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const stagingRoomId = process.env.STAGING_ROOM_ID ?? "demo-room";
const stagingAdminToken = process.env.STAGING_ADMIN_TOKEN ?? "noah-stage-admin";

const stagingSceneRooms = [
  {
    name: "Hall",
    roomId: process.env.STAGING_HALL_ROOM_ID ?? "42db8225-f671-4e46-9c28-9381d66a948c",
    expectedBundleUrl: "/assets/scenes/sense-hall2-v1/scene.json",
    timeoutMs: 20000
  },
  {
    name: "BlueOffice",
    roomId: process.env.STAGING_BLUEOFFICE_ROOM_ID ?? "0b537d34-7b92-4b51-854a-8c64cfb4c114",
    expectedBundleUrl: "/assets/scenes/sense-blueoffice-glb-v4/scene.json",
    timeoutMs: 25000
  },
  {
    name: "ArtGallery",
    roomId: process.env.STAGING_ARTGALLERY_ROOM_ID ?? "c17bcb81-fcd2-4432-94be-688f16a61037",
    expectedBundleUrl: "/assets/scenes/sense-artgallery-glb-v2/scene.json",
    timeoutMs: 35000
  }
] as const;

type DiagnosticsPayload = {
  items: Array<{
    note?: string;
    sceneDebug?: {
      state?: string;
      bundleUrl?: string;
    };
  }>;
};

async function expectSceneRoomLoaded(
  page: Page,
  request: APIRequestContext,
  roomId: string,
  timeoutMs: number,
  expectedBundleUrl: string
): Promise<void> {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.locator("#room-name")).not.toContainText("Loading room", { timeout: timeoutMs });

  await expect.poll(async () => {
    const diagnosticsResponse = await request.get(`/api/rooms/${roomId}/diagnostics`);
    const diagnostics = (await diagnosticsResponse.json()) as DiagnosticsPayload;
    const notes = diagnostics.items.map((item) => item.note).filter(Boolean);
    const loadedItem = diagnostics.items.find((item) =>
      item.sceneDebug?.bundleUrl === expectedBundleUrl && item.sceneDebug?.state === "loaded"
    );
    return {
      loaded: notes.includes("scene_bundle_loaded") && notes.includes("runtime_booted"),
      state: loadedItem?.sceneDebug?.state ?? null,
      bundleUrl: loadedItem?.sceneDebug?.bundleUrl ?? null
    };
  }, {
    timeout: timeoutMs,
    intervals: [1000, 2000, 3000, 5000]
  }).toEqual({
    loaded: true,
    state: "loaded",
    bundleUrl: expectedBundleUrl
  });
}

test.describe("@staging runtime HUD space selector", () => {
  test("staging suite uses public HTTPS base URL", async ({ request, baseURL }) => {
    expect(baseURL).toBeTruthy();
    const url = new URL(baseURL!);
    expect(url.protocol).toBe("https:");

    const response = await request.get("/health");
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    expect(payload.service).toBe("api");
  });

  test("selector is visible for the configured staging room", async ({ page }) => {
    await page.goto(`/rooms/${stagingRoomId}`);
    await expect(page.locator("#room-name")).not.toContainText("Loading room");
    await expect(page.locator("#space-select")).toBeVisible();

    await expect.poll(async () => {
      const options = await page.locator("#space-select option").allTextContents();
      return options.length;
    }, {
      timeout: 15000,
      intervals: [1000, 2000, 3000]
    }).toBeGreaterThanOrEqual(2);
  });

  test("selector switches to a freshly created staging target room", async ({ page, baseURL, request }) => {
    const createRoomResponse = await request.post("/api/rooms", {
      headers: {
        "x-noah-admin-token": stagingAdminToken
      },
      data: {
        tenantId: "demo-tenant",
        templateId: "showroom-basic",
        name: "Staging Selector Target",
        guestAllowed: true
      }
    });
    expect(createRoomResponse.ok()).toBeTruthy();
    const targetRoom = await createRoomResponse.json() as { roomId: string; roomLink: string };

    await page.goto(`/rooms/${stagingRoomId}`);
    const targetRoomLink = new URL(targetRoom.roomLink, baseURL).toString();

    await expect.poll(async () => {
      const isDisabled = await page.locator("#space-select").isDisabled();
      const values = await page.locator("#space-select option").evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value)
      );
      return {
        isDisabled,
        hasTarget: values.includes(targetRoomLink)
      };
    }, {
      timeout: 15000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      isDisabled: false,
      hasTarget: true
    });

    await page.selectOption("#space-select", { value: targetRoomLink });
    await page.waitForURL(`**/rooms/${targetRoom.roomId}`);
    await expect(page.locator("#room-name")).toContainText(targetRoom.roomId);
  });

  for (const sceneRoom of stagingSceneRooms) {
    test(`scene room smoke: ${sceneRoom.name}`, async ({ page, request }) => {
      test.setTimeout(sceneRoom.timeoutMs + 15000);
      await expectSceneRoomLoaded(
        page,
        request,
        sceneRoom.roomId,
        sceneRoom.timeoutMs,
        sceneRoom.expectedBundleUrl
      );
    });
  }
});
