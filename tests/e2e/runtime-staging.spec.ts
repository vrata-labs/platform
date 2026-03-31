import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const stagingRoomId = process.env.STAGING_ROOM_ID ?? "demo-room";
const stagingAdminToken = process.env.STAGING_ADMIN_TOKEN ?? "noah-stage-admin";

const stagingSceneRooms = [
  {
    name: "Hall",
    roomId: process.env.STAGING_HALL_ROOM_ID ?? "42db8225-f671-4e46-9c28-9381d66a948c",
    expectedBundleUrl: "/assets/scenes/sense-hall2-v1/scene.json",
    timeoutMs: 20000,
    requireLoadedState: true
  },
  {
    name: "BlueOffice",
    roomId: process.env.STAGING_BLUEOFFICE_ROOM_ID ?? "0b537d34-7b92-4b51-854a-8c64cfb4c114",
    expectedBundleUrl: "/assets/scenes/sense-blueoffice-glb-v4/scene.json",
    timeoutMs: 25000,
    requireLoadedState: true
  },
  {
    name: "LectureHall",
    roomId: process.env.STAGING_LECTUREHALL_ROOM_ID ?? "c79f7f2c-2680-493b-9f8e-b6cd69802fdb",
    expectedBundleUrl: "/assets/scenes/sense-lecturehall-glb-v2/scene.json",
    timeoutMs: 30000,
    requireLoadedState: false
  },
  {
    name: "Showroom",
    roomId: process.env.STAGING_SHOWROOM_ROOM_ID ?? "003f5e72-90fe-4901-9dca-8be83f74e01a",
    expectedBundleUrl: "/assets/scenes/sense-showroom-glb-v3/scene.json",
    timeoutMs: 30000,
    requireLoadedState: false
  },
  {
    name: "MeetingSmall",
    roomId: process.env.STAGING_MEETINGSMALL_ROOM_ID ?? "1a90118c-635c-478b-9448-33eb76a45f50",
    expectedBundleUrl: "/assets/scenes/sense-meeting-small-glb-v2/scene.json",
    timeoutMs: 30000,
    requireLoadedState: false
  },
  {
    name: "Cinema",
    roomId: process.env.STAGING_CINEMA_ROOM_ID ?? "b51f3193-1af8-4b0b-935f-b89f16e0016a",
    expectedBundleUrl: "/assets/scenes/sense-cinema-glb-v1/scene.json",
    timeoutMs: 30000,
    requireLoadedState: false
  },
  {
    name: "Anastasia",
    roomId: process.env.STAGING_ANASTASIA_ROOM_ID ?? "85be9531-03d3-495b-9a4a-69c4b833acc7",
    expectedBundleUrl: "/assets/scenes/sense-anastasia-glb-v1/scene.json",
    timeoutMs: 30000,
    requireLoadedState: false
  },
  {
    name: "NewGallery",
    roomId: process.env.STAGING_NEWGALLERY_ROOM_ID ?? "d53bde42-7952-4cd6-9c3f-2b06a7254c04",
    expectedBundleUrl: "/assets/scenes/sense-newgallery-glb-v2/scene.json",
    timeoutMs: 45000,
    requireLoadedState: false
  },
  {
    name: "ArtGallery",
    roomId: process.env.STAGING_ARTGALLERY_ROOM_ID ?? "c17bcb81-fcd2-4432-94be-688f16a61037",
    expectedBundleUrl: "/assets/scenes/sense-artgallery-glb-v2/scene.json",
    timeoutMs: 35000,
    requireLoadedState: true
  },
  {
    name: "Standup",
    roomId: process.env.STAGING_STANDUP_ROOM_ID ?? "af85fed9-8b17-4f06-ae15-5355057d7200",
    expectedBundleUrl: "/assets/scenes/sense-standup-glb-v1/scene.json",
    timeoutMs: 30000,
    requireLoadedState: false
  },
  {
    name: "OporaRussia",
    roomId: process.env.STAGING_OPORARUSSIA_ROOM_ID ?? "d686c23e-78b5-4f55-a47f-b380114d5d1a",
    expectedBundleUrl: "/assets/scenes/sense-opora-russia-glb-v1/scene.json",
    timeoutMs: 30000,
    requireLoadedState: false
  },
  {
    name: "SergOffice",
    roomId: process.env.STAGING_SERGOFFICE_ROOM_ID ?? "ba67301b-14f4-4c88-ba7f-2b63e0c1c332",
    expectedBundleUrl: "/assets/scenes/sense-serg-office-glb-v1/scene.json",
    timeoutMs: 30000,
    requireLoadedState: false
  },
  {
    name: "CinemaModeler",
    roomId: process.env.STAGING_CINEMAMODELER_ROOM_ID ?? "c28e17b5-7b26-408b-926e-aa93fef9915e",
    expectedBundleUrl: "/assets/scenes/sense-cinema-modeler-glb-v1/scene.json",
    timeoutMs: 30000,
    requireLoadedState: false
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

async function getJsonWithRetry<T>(request: APIRequestContext, path: string, timeoutMs: number): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await request.get(path);
      if (!response.ok()) {
        throw new Error(`http_${response.status()}`);
      }
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("staging_request_failed");
}

async function expectSceneRoomLoaded(
  page: Page,
  request: APIRequestContext,
  roomId: string,
  timeoutMs: number,
  expectedBundleUrl: string,
  requireLoadedState: boolean
): Promise<void> {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.locator("#room-name")).not.toContainText("Loading room", { timeout: timeoutMs });

  const manifest = await getJsonWithRetry<{ sceneBundle?: { url?: string } }>(request, `/api/rooms/${roomId}/manifest`, timeoutMs);
  expect(manifest.sceneBundle?.url).toBe(expectedBundleUrl);

  if (!requireLoadedState) {
    const diagnostics = await getJsonWithRetry<DiagnosticsPayload>(request, `/api/rooms/${roomId}/diagnostics`, timeoutMs);
    expect(Array.isArray(diagnostics.items)).toBeTruthy();
    return;
  }

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
        sceneRoom.expectedBundleUrl,
        sceneRoom.requireLoadedState
      );
    });
  }
});
