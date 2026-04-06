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

async function readNoahDebug(page: Page): Promise<{
  roomStateConnected?: boolean;
  remoteAvatarReliableCount?: number;
  remoteAvatarPoseCount?: number;
  avatarDebug?: {
    locomotionState?: string | null;
    qualityMode?: string | null;
    skatingMetric?: number;
    footingCorrectionActive?: boolean;
    bodyLean?: number;
  };
  remoteAvatarParticipants?: Array<{
    hasReliableState?: boolean;
    hasPoseFrame?: boolean;
    presenceSeen?: boolean;
    locomotionState?: string;
    qualityMode?: string;
    skatingMetric?: number;
    leftHandVisible?: boolean;
    rightHandVisible?: boolean;
  }>;
} | undefined> {
  return page.evaluate(() => (window as Window & {
    __NOAH_DEBUG__?: {
      roomStateConnected?: boolean;
      remoteAvatarReliableCount?: number;
      remoteAvatarPoseCount?: number;
      avatarDebug?: {
        locomotionState?: string | null;
        qualityMode?: string | null;
        skatingMetric?: number;
        footingCorrectionActive?: boolean;
        bodyLean?: number;
      };
      remoteAvatarParticipants?: Array<{
        hasReliableState?: boolean;
        hasPoseFrame?: boolean;
        presenceSeen?: boolean;
        locomotionState?: string;
        qualityMode?: string;
        skatingMetric?: number;
        leftHandVisible?: boolean;
        rightHandVisible?: boolean;
      }>;
    };
  }).__NOAH_DEBUG__);
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

  test("staging selector exposes canonical rooms with avatars enabled", async ({ request, baseURL }) => {
    const spacesResponse = await request.get(`/api/rooms/${stagingRoomId}/spaces`);
    expect(spacesResponse.ok()).toBeTruthy();
    const payload = await spacesResponse.json() as {
      items: Array<{ roomId: string; name: string; roomLink: string }>;
    };

    expect(payload.items.every((item) => item.roomLink.startsWith(baseURL ?? ""))).toBeTruthy();
    expect(payload.items.some((item) => item.name.startsWith("Stage "))).toBeFalsy();
    expect(payload.items.some((item) => item.name === "Staging Selector Target")).toBeFalsy();

    const names = payload.items.map((item) => item.name);
    for (const expected of ["Demo Room", "Hall", "BlueOffice", "LectureHall", "Showroom", "MeetingSmall", "Cinema", "Anastasia", "NewGallery", "ArtGallery", "Standup", "OporaRussia", "SergOffice", "CinemaModeler"]) {
      expect(names).toContain(expected);
    }

    const manifestResponse = await request.get(`/api/rooms/${stagingRoomId}/manifest`);
    expect(manifestResponse.ok()).toBeTruthy();
    const manifest = await manifestResponse.json() as {
      avatars?: { avatarsEnabled?: boolean; avatarPoseBinaryEnabled?: boolean };
    };
    expect(manifest.avatars?.avatarsEnabled).toBe(true);
    expect(manifest.avatars?.avatarPoseBinaryEnabled).toBe(true);
  });

  test("selector switches to a freshly created staging target room", async ({ page, baseURL, request }) => {
    const targetName = `Staging Selector Target ${Date.now()}`;
    let targetRoomId: string | null = null;
    try {
      const createRoomResponse = await request.post("/api/rooms", {
        headers: {
          "x-noah-admin-token": stagingAdminToken
        },
        data: {
          tenantId: "demo-tenant",
          templateId: "showroom-basic",
          name: targetName,
          guestAllowed: true
        }
      });
      expect(createRoomResponse.ok()).toBeTruthy();
      const targetRoom = await createRoomResponse.json() as { roomId: string; roomLink: string };
      targetRoomId = targetRoom.roomId;

      await page.goto(`/rooms/${stagingRoomId}`);
      const targetRoomLink = new URL(targetRoom.roomLink, baseURL).toString();

      await expect.poll(async () => {
        const isDisabled = await page.locator("#space-select").isDisabled();
        const values = await page.locator("#space-select option").evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value)
        );
        return {
          isDisabled,
          hasTarget: values.includes(targetRoomLink),
          secureTarget: targetRoomLink.startsWith(baseURL ?? "")
        };
      }, {
        timeout: 15000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        isDisabled: false,
        hasTarget: true,
        secureTarget: true
      });

      await page.selectOption("#space-select", { value: targetRoomLink });
      await page.waitForURL(`**/rooms/${targetRoom.roomId}`);
      await expect(page.locator("#room-name")).toContainText(targetRoom.roomId);
    } finally {
      if (targetRoomId) {
        const deleteResponse = await request.delete(`/api/rooms/${targetRoomId}`, {
          headers: {
            "x-noah-admin-token": stagingAdminToken
          }
        });
        expect(deleteResponse.ok()).toBeTruthy();
      }
    }
  });

  test("selector survives chained scene transitions across canonical rooms", async ({ page, baseURL }) => {
    test.setTimeout(90000);
    await page.goto(`/rooms/${stagingRoomId}`);

    const targets = [
      new URL(`/rooms/${stagingSceneRooms[0]!.roomId}`, baseURL).toString(),
      new URL(`/rooms/${stagingSceneRooms[1]!.roomId}`, baseURL).toString(),
      new URL(`/rooms/${stagingRoomId}`, baseURL).toString()
    ];

    for (const target of targets) {
      await expect(page.locator("#space-select")).toBeVisible();
      await page.selectOption("#space-select", { value: target });
      await page.waitForURL(target.replace(baseURL ?? "", "**"));
      await expect(page.locator("#space-select")).toBeVisible();
      await expect(page.locator("#room-name")).not.toContainText("Loading room", { timeout: 30000 });
      await expect.poll(async () => {
        const currentValue = await page.locator("#space-select").inputValue();
        return {
          currentValue
        };
      }, {
        timeout: 15000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        currentValue: target
      });
    }
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

  test("avatar-enabled staging room syncs remote reliable state and pose frames", async ({ browser, request }) => {
    const targetName = `Staging Avatar Sync ${Date.now()}`;
    let roomId: string | null = null;

    try {
      const createRoomResponse = await request.post("/api/rooms", {
        headers: {
          "x-noah-admin-token": stagingAdminToken
        },
        data: {
          tenantId: "demo-tenant",
          templateId: "meeting-room-basic",
          name: targetName,
          guestAllowed: true,
          avatarConfig: {
            avatarsEnabled: true,
            avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
            avatarQualityProfile: "desktop-standard",
            avatarFallbackCapsulesEnabled: true,
            avatarSeatsEnabled: false
          }
        }
      });
      expect(createRoomResponse.ok()).toBeTruthy();
      const room = await createRoomResponse.json() as { roomId: string; roomLink: string };
      roomId = room.roomId;

      const pageA = await browser.newPage();
      const pageB = await browser.newPage();
      try {
        await pageA.goto(`/rooms/${room.roomId}?debug=1&bot=line`);
        await pageB.goto(`/rooms/${room.roomId}?debug=1&bot=line`);

        await expect.poll(async () => {
          const debugA = await pageA.evaluate(() => (window as Window & {
            __NOAH_DEBUG__?: {
              remoteAvatarReliableCount?: number;
              remoteAvatarPoseCount?: number;
              remoteAvatarParticipants?: Array<{ hasReliableState?: boolean; hasPoseFrame?: boolean; presenceSeen?: boolean }>;
            };
          }).__NOAH_DEBUG__);
          const debugB = await pageB.evaluate(() => (window as Window & {
            __NOAH_DEBUG__?: {
              remoteAvatarReliableCount?: number;
              remoteAvatarPoseCount?: number;
              remoteAvatarParticipants?: Array<{ hasReliableState?: boolean; hasPoseFrame?: boolean; presenceSeen?: boolean }>;
            };
          }).__NOAH_DEBUG__);

          return {
            aReady: (debugA?.remoteAvatarReliableCount ?? 0) === 1
              && (debugA?.remoteAvatarPoseCount ?? 0) === 1
              && Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame)),
            bReady: (debugB?.remoteAvatarReliableCount ?? 0) === 1
              && (debugB?.remoteAvatarPoseCount ?? 0) === 1
              && Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame))
          };
        }, {
          timeout: 45000,
          intervals: [1000, 2000, 3000]
        }).toEqual({
          aReady: true,
          bReady: true
        });
      } finally {
        await pageA.close();
        await pageB.close();
      }
    } finally {
      if (roomId) {
        const deleteResponse = await request.delete(`/api/rooms/${roomId}`, {
          headers: {
            "x-noah-admin-token": stagingAdminToken
          }
        });
        expect(deleteResponse.ok()).toBeTruthy();
      }
    }
  });

  test("demo-room keeps avatar sync working between two clients on staging", async ({ browser }) => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    try {
      await pageA.goto(`/rooms/${stagingRoomId}?debug=1&bot=line`);
      await pageB.goto(`/rooms/${stagingRoomId}?debug=1&bot=line`);

      await expect.poll(async () => {
        const debugA = await readNoahDebug(pageA);
        const debugB = await readNoahDebug(pageB);
        return {
          aReady: (debugA?.remoteAvatarReliableCount ?? 0) >= 1
            && (debugA?.remoteAvatarPoseCount ?? 0) >= 1
            && Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible)),
          bReady: (debugB?.remoteAvatarReliableCount ?? 0) >= 1
            && (debugB?.remoteAvatarPoseCount ?? 0) >= 1
            && Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible))
        };
      }, {
        timeout: 25000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        aReady: true,
        bReady: true
      });
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });

  test("demo-room preserves legacy sync with phase three path disabled on staging", async ({ browser, request }) => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    try {
      const manifestResponse = await request.get(`/api/rooms/${stagingRoomId}/manifest`);
      expect(manifestResponse.ok()).toBeTruthy();
      const manifest = await manifestResponse.json() as {
        avatars?: { avatarLegIkEnabled?: boolean; avatarsEnabled?: boolean; avatarPoseBinaryEnabled?: boolean };
      };
      expect(manifest.avatars?.avatarsEnabled).toBe(true);
      expect(manifest.avatars?.avatarPoseBinaryEnabled).toBe(true);
      expect(manifest.avatars?.avatarLegIkEnabled).toBe(false);

      await pageA.goto(`/rooms/${stagingRoomId}?debug=1&bot=circle`);
      await pageB.goto(`/rooms/${stagingRoomId}?debug=1&bot=line`);

      await expect.poll(async () => {
        const debugA = await readNoahDebug(pageA);
        const debugB = await readNoahDebug(pageB);
        return {
          legacySyncOk: (debugA?.remoteAvatarReliableCount ?? 0) >= 1
            && (debugA?.remoteAvatarPoseCount ?? 0) >= 1
            && Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame)),
          localFallbackOk: Boolean(
            debugA?.avatarDebug?.qualityMode == null
            && (debugA?.avatarDebug?.skatingMetric ?? 0) === 0
            && (debugA?.avatarDebug?.bodyLean ?? 0) === 0
          ),
          remoteFallbackOk: Boolean(
            debugB?.remoteAvatarParticipants?.some((item) =>
              item.presenceSeen
              && item.hasReliableState
              && item.hasPoseFrame
              && item.qualityMode === "far"
              && (item.skatingMetric ?? 0) === 0
              && ["walk", "strafe", "backpedal", "turn", "idle"].includes(item.locomotionState ?? "")
            )
          )
        };
      }, {
        timeout: 30000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        legacySyncOk: true,
        localFallbackOk: true,
        remoteFallbackOk: true
      });
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });

  test("demo-room exposes phase three locomotion diagnostics when feature flag is forced on by query override", async ({ browser }) => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    try {
      await pageA.goto(`/rooms/${stagingRoomId}?debug=1&bot=circle&avatarik=1`);
      await pageB.goto(`/rooms/${stagingRoomId}?debug=1&bot=line&avatarik=1`);

      await expect.poll(async () => {
        const debugA = await readNoahDebug(pageA);
        const debugB = await readNoahDebug(pageB);
        return {
          localPhaseThreeOk: Boolean(
            debugA?.avatarDebug?.qualityMode === "near"
            && typeof debugA?.avatarDebug?.skatingMetric === "number"
            && typeof debugA?.avatarDebug?.bodyLean === "number"
          ),
          remotePhaseThreeOk: Boolean(
            debugB?.remoteAvatarParticipants?.some((item) =>
              item.presenceSeen
              && item.hasReliableState
              && item.hasPoseFrame
              && (item.qualityMode === "near" || item.qualityMode === "far")
              && typeof item.skatingMetric === "number"
              && ["walk", "strafe", "backpedal", "turn", "idle"].includes(item.locomotionState ?? "")
            )
          )
        };
      }, {
        timeout: 30000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        localPhaseThreeOk: true,
        remotePhaseThreeOk: true
      });
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });

  test("hall keeps avatar sync working between two web clients on staging", async ({ browser }) => {
    const hallRoomId = stagingSceneRooms[0]!.roomId;
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    try {
      await pageA.goto(`/rooms/${hallRoomId}?debug=1&bot=line`);
      await pageB.goto(`/rooms/${hallRoomId}?debug=1&bot=line`);

      await expect.poll(async () => {
        const debugA = await readNoahDebug(pageA);
        const debugB = await readNoahDebug(pageB);
        return {
          aReady: (debugA?.remoteAvatarReliableCount ?? 0) >= 1
            && (debugA?.remoteAvatarPoseCount ?? 0) >= 1
            && Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame)),
          bReady: (debugB?.remoteAvatarReliableCount ?? 0) >= 1
            && (debugB?.remoteAvatarPoseCount ?? 0) >= 1
            && Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame))
        };
      }, {
        timeout: 45000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        aReady: true,
        bReady: true
      });
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });

  test("hall keeps avatar hands visible between two web clients on staging", async ({ browser }) => {
    const hallRoomId = stagingSceneRooms[0]!.roomId;
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    try {
      await pageA.goto(`/rooms/${hallRoomId}?debug=1&bot=line`);
      await pageB.goto(`/rooms/${hallRoomId}?debug=1&bot=line`);

      await expect.poll(async () => {
        const debugA = await readNoahDebug(pageA);
        const debugB = await readNoahDebug(pageB);
        return {
          aHandsReady: Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible)),
          bHandsReady: Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible))
        };
      }, {
        timeout: 45000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        aHandsReady: true,
        bHandsReady: true
      });
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });

  test("hall keeps legacy avatar body path stable while phase three path is disabled on staging", async ({ browser }) => {
    const hallRoomId = stagingSceneRooms[0]!.roomId;
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    try {
      await pageA.goto(`/rooms/${hallRoomId}?debug=1&bot=circle`);
      await pageB.goto(`/rooms/${hallRoomId}?debug=1&bot=line`);

      await expect.poll(async () => {
        const debugA = await readNoahDebug(pageA);
        const debugB = await readNoahDebug(pageB);
        return {
          localFallback: Boolean(
            debugA?.avatarDebug?.qualityMode == null
            && (debugA?.avatarDebug?.skatingMetric ?? 0) === 0
            && (debugA?.avatarDebug?.bodyLean ?? 0) === 0
          ),
          remoteFallback: Boolean(
            debugB?.remoteAvatarParticipants?.some((item) =>
              item.presenceSeen
              && item.hasReliableState
              && item.hasPoseFrame
              && item.qualityMode === "far"
              && (item.skatingMetric ?? 0) === 0
            )
          )
        };
      }, {
        timeout: 45000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        localFallback: true,
        remoteFallback: true
      });
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });

  test("hall exposes phase three locomotion diagnostics when feature flag is forced on by query override", async ({ browser }) => {
    const hallRoomId = stagingSceneRooms[0]!.roomId;
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    try {
      await pageA.goto(`/rooms/${hallRoomId}?debug=1&bot=circle&avatarik=1`);
      await pageB.goto(`/rooms/${hallRoomId}?debug=1&bot=line&avatarik=1`);

      await expect.poll(async () => {
        const debugA = await readNoahDebug(pageA);
        const debugB = await readNoahDebug(pageB);
        return {
          localNaturalness: Boolean(
            debugA?.avatarDebug?.qualityMode === "near"
            && typeof debugA?.avatarDebug?.skatingMetric === "number"
            && typeof debugA?.avatarDebug?.bodyLean === "number"
          ),
          remoteNaturalness: Boolean(
            debugB?.remoteAvatarParticipants?.some((item) =>
              item.presenceSeen
              && item.hasReliableState
              && item.hasPoseFrame
              && (item.qualityMode === "near" || item.qualityMode === "far")
              && typeof item.skatingMetric === "number"
            )
          )
        };
      }, {
        timeout: 45000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        localNaturalness: true,
        remoteNaturalness: true
      });
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });
});
