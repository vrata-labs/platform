import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const stagingRoomId = process.env.STAGING_ROOM_ID ?? "demo-room";
const stagingAdminToken = process.env.STAGING_ADMIN_TOKEN ?? "vrata-stage-admin";
const stagingBaseUrl = process.env.BASE_URL ?? "https://158.160.10.234.sslip.io";
const stagingAssetBaseUrl = process.env.STAGING_ASSET_BASE_URL ?? `${new URL(stagingBaseUrl).protocol}//state.${new URL(stagingBaseUrl).host}`;
const stagingSceneBundleVersion = process.env.STAGING_SCENE_BUNDLE_VERSION;

type ExpectedBundleUrl = string | RegExp;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function versionedSceneBundleUrl(sceneId: string): string {
  return stagingSceneBundleVersion
    ? `${stagingAssetBaseUrl}/assets/scenes/${sceneId}/${stagingSceneBundleVersion}/scene.json`
    : `${stagingAssetBaseUrl}/assets/scenes/${sceneId}/scene.json`;
}

function expectedVersionedOrLegacySceneBundleUrl(sceneId: string): ExpectedBundleUrl {
  if (stagingSceneBundleVersion) {
    return versionedSceneBundleUrl(sceneId);
  }
  return new RegExp(`^${escapeRegExp(`${stagingAssetBaseUrl}/assets/scenes/${sceneId}/`)}(?:[0-9a-fA-F]{40}/)?scene\\.json$`);
}

function bundleUrlMatches(actual: string | undefined, expected: ExpectedBundleUrl): boolean {
  if (!actual) return false;
  return typeof expected === "string" ? actual === expected : expected.test(actual);
}

const hallSceneBundleUrl = versionedSceneBundleUrl("sense-hall2-v1");
const blueOfficeSceneBundleUrl = versionedSceneBundleUrl("sense-blueoffice-glb-v4");

const stagingSceneRooms = [
  {
    name: "Hall",
    roomId: process.env.STAGING_HALL_ROOM_ID ?? "42db8225-f671-4e46-9c28-9381d66a948c",
    expectedBundleUrl: expectedVersionedOrLegacySceneBundleUrl("sense-hall2-v1"),
    timeoutMs: 45000,
    requireLoadedState: true
  },
  {
    name: "BlueOffice",
    roomId: process.env.STAGING_BLUEOFFICE_ROOM_ID ?? "0b537d34-7b92-4b51-854a-8c64cfb4c114",
    expectedBundleUrl: expectedVersionedOrLegacySceneBundleUrl("sense-blueoffice-glb-v4"),
    timeoutMs: 45000,
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

async function getJsonWithRetry<T>(request: APIRequestContext, path: string, timeoutMs: number, headers?: Record<string, string>): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await request.get(path, headers ? { headers } : undefined);
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

async function getDiagnosticsWithRetry(request: APIRequestContext, roomId: string, timeoutMs: number): Promise<DiagnosticsPayload> {
  return getJsonWithRetry<DiagnosticsPayload>(request, `/api/rooms/${roomId}/diagnostics`, timeoutMs, {
    "x-vrata-admin-token": stagingAdminToken
  });
}

async function expectSceneRoomLoaded(
  page: Page,
  request: APIRequestContext,
  roomId: string,
  timeoutMs: number,
  expectedBundleUrl: ExpectedBundleUrl,
  requireLoadedState: boolean
): Promise<void> {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.locator("#room-name")).not.toContainText("Loading room", { timeout: timeoutMs });

  const manifest = await getJsonWithRetry<{ sceneBundle?: { url?: string } }>(request, `/api/rooms/${roomId}/manifest`, timeoutMs);
  expect(bundleUrlMatches(manifest.sceneBundle?.url, expectedBundleUrl)).toBeTruthy();
  const loadedBundleUrl = manifest.sceneBundle?.url;
  expect(loadedBundleUrl).toBeTruthy();

  if (!requireLoadedState) {
    const diagnostics = await getDiagnosticsWithRetry(request, roomId, timeoutMs);
    expect(Array.isArray(diagnostics.items)).toBeTruthy();
    return;
  }

  await expect.poll(async () => {
    const diagnostics = await getDiagnosticsWithRetry(request, roomId, timeoutMs);
    const loadedItem = diagnostics.items.find((item) =>
      item.sceneDebug?.bundleUrl === loadedBundleUrl && item.sceneDebug?.state === "loaded"
    );
    return {
      loaded: loadedItem !== undefined,
      state: loadedItem?.sceneDebug?.state ?? null,
      bundleUrl: loadedItem?.sceneDebug?.bundleUrl ?? null
    };
  }, {
    timeout: timeoutMs,
    intervals: [1000, 2000, 3000, 5000]
  }).toEqual({
    loaded: true,
    state: "loaded",
    bundleUrl: loadedBundleUrl
  });
}

async function readVrataDebug(page: Page): Promise<{
  roomStateConnected?: boolean;
  sceneBundleState?: string | null;
  remoteAvatarReliableCount?: number;
  remoteAvatarPoseCount?: number;
  remoteAvatarParticipants?: Array<{
    hasReliableState?: boolean;
    hasPoseFrame?: boolean;
    presenceSeen?: boolean;
    leftHandVisible?: boolean;
    rightHandVisible?: boolean;
  }>;
  } | undefined> {
  return page.evaluate(() => (window as Window & {
    __VRATA_DEBUG__?: {
      roomStateConnected?: boolean;
      sceneBundleState?: string | null;
      remoteAvatarReliableCount?: number;
      remoteAvatarPoseCount?: number;
      remoteAvatarParticipants?: Array<{
        hasReliableState?: boolean;
        hasPoseFrame?: boolean;
        presenceSeen?: boolean;
        leftHandVisible?: boolean;
        rightHandVisible?: boolean;
      }>;
    };
  }).__VRATA_DEBUG__);
}

async function readSelfAvatarDebug(page: Page): Promise<{
  avatarDebug?: {
    inputMode?: string | null;
    visibilityState?: string | null;
    controllerProfile?: string | null;
    xrInputProfile?: string | null;
  };
  avatarSnapshot?: {
    inputMode?: string | null;
    visibilityState?: string | null;
    leftHand?: { x: number; y: number; z: number; visible: boolean };
    rightHand?: { x: number; y: number; z: number; visible: boolean };
  };
  avatarPoseTransport?: {
    targetHz?: number;
  };
  xrAvatarDebug?: {
    profile?: string | null;
  } | null;
  interactionRay?: {
    active?: boolean;
    mode?: string | null;
    targetKind?: string | null;
    seatId?: string | null;
  };
  localPosition?: {
    x?: number;
    z?: number;
  };
  currentSeatId?: string | null;
  statusLine?: string | null;
  sceneBundleState?: string | null;
  roomStateConnected?: boolean;
  xrAxes?: {
    moveX?: number;
    moveY?: number;
    turnX?: number;
    turnY?: number;
  };
} | undefined> {
  return page.evaluate(() => (window as Window & {
    __VRATA_DEBUG__?: {
      avatarDebug?: {
        inputMode?: string | null;
        visibilityState?: string | null;
        controllerProfile?: string | null;
        xrInputProfile?: string | null;
      };
      avatarSnapshot?: {
        inputMode?: string | null;
        visibilityState?: string | null;
        leftHand?: { x: number; y: number; z: number; visible: boolean };
        rightHand?: { x: number; y: number; z: number; visible: boolean };
      };
      avatarPoseTransport?: {
        targetHz?: number;
      };
      xrAvatarDebug?: {
        profile?: string | null;
      } | null;
      interactionRay?: {
        active?: boolean;
        mode?: string | null;
        targetKind?: string | null;
        seatId?: string | null;
      };
      localPosition?: {
        x?: number;
        z?: number;
      };
      currentSeatId?: string | null;
      statusLine?: string | null;
      sceneBundleState?: string | null;
      roomStateConnected?: boolean;
      xrAxes?: {
        moveX?: number;
        moveY?: number;
        turnX?: number;
        turnY?: number;
      };
    };
  }).__VRATA_DEBUG__);
}

test.describe("@staging runtime HUD space selector", () => {
  // Public staging runs can hit transient scene or RTC startup misses on a cold VM.
  test.describe.configure({ retries: 1 });

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

  test("audio device controls are visible for the configured staging room", async ({ page }) => {
    await page.goto(`/rooms/${stagingRoomId}`);
    await expect.poll(async () => {
      return await page.locator("#mic-select").count();
    }, {
      timeout: 15000,
      intervals: [1000, 2000, 3000]
    }).toBe(1);
    await expect(page.locator("#mic-select")).toBeVisible();
    await expect(page.locator("#speaker-select")).toBeVisible();
    await expect(page.locator("#audio-device-status")).toBeVisible();
    await expect(page.locator("#mic-level-fill").locator("..")).toBeVisible();
    await expect(page.locator("#speaker-level-fill").locator("..")).toBeVisible();
  });

  test("public diagnostics page validates staging media connectivity", async ({ page }) => {
    test.setTimeout(90000);
    await page.goto(`/diagnostics?roomId=${encodeURIComponent(stagingRoomId)}&autorun=1&skipMic=1&timeoutMs=12000`, { waitUntil: "domcontentloaded" });

    await expect.poll(async () => {
      return await page.evaluate(() => {
        const report = (window as Window & {
          __VRATA_CONNECTIVITY_DIAGNOSTICS__?: {
            summary?: { failed: number };
            checks?: Array<{ name: string; code: string; status: string; details?: { webrtc?: { available?: boolean; transports?: unknown[] } } }>;
          };
        }).__VRATA_CONNECTIVITY_DIAGNOSTICS__;
        const media = report?.checks?.find((check) => check.name === "media");
        return {
          failed: report?.summary?.failed ?? null,
          mediaStatus: media?.status ?? null,
          mediaCode: media?.code ?? null,
          webrtcAvailable: media?.details?.webrtc?.available ?? false,
          hasTransport: (media?.details?.webrtc?.transports?.length ?? 0) > 0
        };
      });
    }, {
      timeout: 60000,
      intervals: [1000, 2000, 3000, 5000]
    }).toEqual({
      failed: 0,
      mediaStatus: "ok",
      mediaCode: "media_ok",
      webrtcAvailable: true,
      hasTransport: true
    });

    const reportText = await page.locator("#diagnostics-json").inputValue();
    expect(reportText).toContain('"room_state_ws_ok"');
    expect(reportText).toContain('"media_ok"');
    expect(reportText).toContain("accessToken=[redacted]");
    expect(reportText).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/);
  });

  test("voice diagnostics bind LiveKit audio to spatial sources on staging", async ({ browser, request }) => {
    test.setTimeout(90000);
    const targetName = `Staging Voice Diagnostics ${Date.now()}`;
    let roomId: string | null = null;

    try {
      const createRoomResponse = await request.post("/api/rooms", {
        headers: {
          "x-vrata-admin-token": stagingAdminToken
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
            avatarSeatsEnabled: true
          }
        }
      });
      expect(createRoomResponse.ok()).toBeTruthy();
      const room = await createRoomResponse.json() as { roomId: string };
      roomId = room.roomId;

      const listener = await browser.newPage();
      const source = await browser.newPage();
      try {
        await listener.goto(`/rooms/${room.roomId}?debug=1&audiomock=1&name=VoiceListener`, { waitUntil: "domcontentloaded" });
        await source.goto(`/rooms/${room.roomId}?debug=1&audiomock=1&bot=line&name=VoiceSource&botSpeed=1`, { waitUntil: "domcontentloaded" });

        await expect.poll(async () => {
          const debug = await listener.evaluate(() => (window as Window & {
            __VRATA_DEBUG__?: { remoteAvatarCount?: number; roomStateConnected?: boolean };
          }).__VRATA_DEBUG__);
          return {
            connected: debug?.roomStateConnected ?? false,
            remoteAvatarCount: debug?.remoteAvatarCount ?? 0
          };
        }, {
          timeout: 30000,
          intervals: [1000, 2000, 3000]
        }).toEqual({ connected: true, remoteAvatarCount: 1 });

        await Promise.all([
          listener.click("#join-audio"),
          source.click("#join-audio")
        ]);

        await expect.poll(async () => {
          const debug = await listener.evaluate(() => (window as Window & {
            __VRATA_DEBUG__?: {
              media?: {
                audioState?: string;
                publishedAudio?: boolean;
                audioSource?: string;
                subscribedAudioCount?: number;
              };
              localMicLevel?: number;
              speakerOutputLevel?: number;
              remoteParticipants?: Array<{ participantId?: string; hasAudioNode?: boolean; activeAudio?: boolean }>;
              spatialAudio?: {
                remoteSources?: Array<{
                  participantId?: string;
                  attachedTo?: string;
                  hasAudioNode?: boolean;
                  pannerActive?: boolean;
                  audioLevel?: number;
                }>;
              };
            };
          }).__VRATA_DEBUG__);
          const participant = debug?.remoteParticipants?.find((item) => item.participantId);
          const spatialSource = debug?.spatialAudio?.remoteSources?.find((item) => item.participantId === participant?.participantId);
          return {
            audioState: debug?.media?.audioState ?? null,
            publishedAudio: debug?.media?.publishedAudio ?? false,
            audioSource: debug?.media?.audioSource ?? null,
            subscribedAudioCount: debug?.media?.subscribedAudioCount ?? 0,
            localMicActive: (debug?.localMicLevel ?? 0) > 0,
            speakerLevelPresent: typeof debug?.speakerOutputLevel === "number",
            participantActiveAudio: participant?.activeAudio ?? false,
            spatialAttachedTo: spatialSource?.attachedTo ?? null,
            spatialHasAudioNode: spatialSource?.hasAudioNode ?? false,
            spatialPannerActive: spatialSource?.pannerActive ?? false,
            spatialAudioLevelPresent: typeof spatialSource?.audioLevel === "number"
          };
        }, {
          timeout: 45000,
          intervals: [1000, 2000, 3000]
        }).toEqual({
          audioState: "joined",
          publishedAudio: true,
          audioSource: "mock",
          subscribedAudioCount: 1,
          localMicActive: true,
          speakerLevelPresent: true,
          participantActiveAudio: true,
          spatialAttachedTo: "head",
          spatialHasAudioNode: true,
          spatialPannerActive: true,
          spatialAudioLevelPresent: true
        });
      } finally {
        await listener.close();
        await source.close();
      }
    } finally {
      if (roomId) {
        const deleteResponse = await request.delete(`/api/rooms/${roomId}`, {
          headers: {
            "x-vrata-admin-token": stagingAdminToken
          }
        });
        expect(deleteResponse.ok()).toBeTruthy();
      }
    }
  });

  test("staging selector exposes canonical rooms with avatars enabled", async ({ request, baseURL }) => {
    const spacesResponse = await request.get(`/api/rooms/${stagingRoomId}/spaces`);
    expect(spacesResponse.ok()).toBeTruthy();
    const payload = await spacesResponse.json() as {
      items: Array<{ roomId: string; name: string; roomLink: string }>;
    };

    expect(payload.items.every((item) => item.roomLink.startsWith(baseURL ?? ""))).toBeTruthy();

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
          "x-vrata-admin-token": stagingAdminToken
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
      await expect.poll(async () => {
        const currentUrl = page.url();
        const roomName = await page.locator("#room-name").textContent();
        return {
          currentUrl,
          roomName: roomName ?? ""
        };
      }, {
        timeout: 30000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        currentUrl: `${baseURL}/rooms/${targetRoom.roomId}`,
        roomName: `showroom-basic - ${targetRoom.roomId}`
      });
    } finally {
      if (targetRoomId) {
        try {
          const deleteResponse = await request.delete(`/api/rooms/${targetRoomId}`, {
            headers: {
              "x-vrata-admin-token": stagingAdminToken
            }
          });
          expect(deleteResponse.ok()).toBeTruthy();
        } catch {
          // Test timeout should not mask the real selector failure cause.
        }
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
      await expect.poll(async () => {
        const currentValue = await page.locator("#space-select").inputValue();
        const currentUrl = page.url();
        const roomName = await page.locator("#room-name").textContent();
        return {
          currentValue,
          currentUrl,
          roomIdPresent: (roomName ?? "").includes(
            target.endsWith(`/rooms/${stagingRoomId}`)
              ? stagingRoomId
              : target.endsWith(`/rooms/${stagingSceneRooms[0]!.roomId}`)
                ? stagingSceneRooms[0]!.roomId
                : stagingSceneRooms[1]!.roomId
          )
        };
      }, {
        timeout: 30000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        currentValue: target,
        currentUrl: target,
        roomIdPresent: true
      });
    }
  });

  for (const sceneRoom of stagingSceneRooms) {
    test(`scene room smoke: ${sceneRoom.name}`, async ({ page, request }) => {
      test.setTimeout(sceneRoom.timeoutMs + 45000);
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
          "x-vrata-admin-token": stagingAdminToken
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
            __VRATA_DEBUG__?: {
              remoteAvatarReliableCount?: number;
              remoteAvatarPoseCount?: number;
              remoteAvatarParticipants?: Array<{ hasReliableState?: boolean; hasPoseFrame?: boolean; presenceSeen?: boolean }>;
            };
          }).__VRATA_DEBUG__);
          const debugB = await pageB.evaluate(() => (window as Window & {
            __VRATA_DEBUG__?: {
              remoteAvatarReliableCount?: number;
              remoteAvatarPoseCount?: number;
              remoteAvatarParticipants?: Array<{ hasReliableState?: boolean; hasPoseFrame?: boolean; presenceSeen?: boolean }>;
            };
          }).__VRATA_DEBUG__);

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
            "x-vrata-admin-token": stagingAdminToken
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
      await pageA.goto(`/rooms/${stagingRoomId}?debug=1&bot=line`, { waitUntil: "domcontentloaded" });
      await pageB.goto(`/rooms/${stagingRoomId}?debug=1&bot=line`, { waitUntil: "domcontentloaded" });

      await expect.poll(async () => {
        const debugA = await readVrataDebug(pageA);
        const debugB = await readVrataDebug(pageB);
        return {
          aConnected: debugA?.roomStateConnected ?? false,
          bConnected: debugB?.roomStateConnected ?? false
        };
      }, {
        timeout: 30000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        aConnected: true,
        bConnected: true
      });

      await expect.poll(async () => {
        const debugA = await readVrataDebug(pageA);
        const debugB = await readVrataDebug(pageB);
        return {
          aReady: (debugA?.remoteAvatarReliableCount ?? 0) >= 1
            && (debugA?.remoteAvatarPoseCount ?? 0) >= 1
            && Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible)),
          bReady: (debugB?.remoteAvatarReliableCount ?? 0) >= 1
            && (debugB?.remoteAvatarPoseCount ?? 0) >= 1
            && Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible))
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

  test("staging bridges API fallback presence with realtime room-state clients", async ({ browser, request }) => {
    const targetName = `Staging Mixed Presence ${Date.now()}`;
    let roomId: string | null = null;

    try {
      const createRoomResponse = await request.post("/api/rooms", {
        headers: {
          "x-vrata-admin-token": stagingAdminToken
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
      const room = await createRoomResponse.json() as { roomId: string };
      roomId = room.roomId;

      const realtimePage = await browser.newPage();
      const fallbackPage = await browser.newPage();
      try {
        await realtimePage.goto(`/rooms/${room.roomId}?debug=1&bot=line`, { waitUntil: "domcontentloaded" });
        await fallbackPage.goto(`/rooms/${room.roomId}?debug=1&failroomstate=1&bot=line`, { waitUntil: "domcontentloaded" });

        await expect.poll(async () => {
          const realtimeDebug = await realtimePage.evaluate(() => (window as Window & {
            __VRATA_DEBUG__?: {
              roomStateConnected?: boolean;
              remoteAvatarCount?: number;
              remoteAvatarParticipants?: Array<{ presenceSeen?: boolean }>;
            };
          }).__VRATA_DEBUG__);
          const fallbackDebug = await fallbackPage.evaluate(() => (window as Window & {
            __VRATA_DEBUG__?: {
              remoteAvatarCount?: number;
              remoteAvatarParticipants?: Array<{ presenceSeen?: boolean }>;
            };
          }).__VRATA_DEBUG__);

          return {
            realtimeConnected: realtimeDebug?.roomStateConnected ?? false,
            realtimeSeesFallback: (realtimeDebug?.remoteAvatarCount ?? 0) >= 1
              && Boolean(realtimeDebug?.remoteAvatarParticipants?.some((item) => item.presenceSeen)),
            fallbackSeesRealtime: (fallbackDebug?.remoteAvatarCount ?? 0) >= 1
              && Boolean(fallbackDebug?.remoteAvatarParticipants?.some((item) => item.presenceSeen))
          };
        }, {
          timeout: 45000,
          intervals: [1000, 2000, 3000]
        }).toEqual({
          realtimeConnected: true,
          realtimeSeesFallback: true,
          fallbackSeesRealtime: true
        });
      } finally {
        await realtimePage.close();
        await fallbackPage.close();
      }
    } finally {
      if (roomId) {
        const deleteResponse = await request.delete(`/api/rooms/${roomId}`, {
          headers: {
            "x-vrata-admin-token": stagingAdminToken
          }
        });
        expect(deleteResponse.ok()).toBeTruthy();
      }
    }
  });

  test("staging keeps baseline avatar presence by default and isolates experimental leg IK behind query override", async ({ page }) => {
    test.setTimeout(90000);

    await page.goto(`/rooms/${stagingRoomId}?debug=1`, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => {
      const debug = await page.evaluate(() => (window as Window & {
        __VRATA_DEBUG__?: {
          avatarPresenceMode?: string;
          featureFlags?: { avatarLegIkEnabled?: boolean };
        };
      }).__VRATA_DEBUG__);

      return {
        mode: debug?.avatarPresenceMode ?? null,
        avatarLegIkEnabled: debug?.featureFlags?.avatarLegIkEnabled ?? null
      };
    }, {
      timeout: 25000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      mode: "baseline",
      avatarLegIkEnabled: false
    });

    await page.goto(`/rooms/${stagingRoomId}?debug=1&avatarik=1`, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => {
      const debug = await page.evaluate(() => (window as Window & {
        __VRATA_DEBUG__?: {
          avatarPresenceMode?: string;
          featureFlags?: { avatarLegIkEnabled?: boolean };
        };
      }).__VRATA_DEBUG__);

      return {
        mode: debug?.avatarPresenceMode ?? null,
        avatarLegIkEnabled: debug?.featureFlags?.avatarLegIkEnabled ?? null
      };
    }, {
      timeout: 25000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      mode: "experimental-leg-ik",
      avatarLegIkEnabled: true
    });
  });

  test("staging mock VR keeps self avatar in hands-only mode without jittery fallback changes", async ({ page }) => {
    await page.goto(`/rooms/${stagingRoomId}?debug=1&avatarvrmock=1`);

    await expect.poll(async () => {
      const debug = await readSelfAvatarDebug(page);
      return {
        inputMode: debug?.avatarDebug?.inputMode ?? null,
        visibilityState: debug?.avatarDebug?.visibilityState ?? null,
        controllerProfile: debug?.avatarDebug?.controllerProfile ?? null,
        xrInputProfile: debug?.avatarDebug?.xrInputProfile ?? null,
        snapshotInputMode: debug?.avatarSnapshot?.inputMode ?? null,
        snapshotVisibility: debug?.avatarSnapshot?.visibilityState ?? null,
        leftVisible: debug?.avatarSnapshot?.leftHand?.visible ?? null,
        rightVisible: debug?.avatarSnapshot?.rightHand?.visible ?? null,
        targetHzReady: (debug?.avatarPoseTransport?.targetHz ?? 0) >= 20,
        xrProfile: debug?.xrAvatarDebug?.profile ?? null
      };
    }, {
      timeout: 25000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      inputMode: "vr-controller",
      visibilityState: "hands-only",
      controllerProfile: "vr_no_controllers",
      xrInputProfile: "none",
      snapshotInputMode: "vr-controller",
      snapshotVisibility: "hands-only",
      leftVisible: true,
      rightVisible: true,
      targetHzReady: true,
      xrProfile: "none"
    });

    const first = await readSelfAvatarDebug(page);
    await page.waitForTimeout(1500);
    const second = await readSelfAvatarDebug(page);

    const leftDx = Math.abs((second?.avatarSnapshot?.leftHand?.x ?? 0) - (first?.avatarSnapshot?.leftHand?.x ?? 0));
    const leftDy = Math.abs((second?.avatarSnapshot?.leftHand?.y ?? 0) - (first?.avatarSnapshot?.leftHand?.y ?? 0));
    const leftDz = Math.abs((second?.avatarSnapshot?.leftHand?.z ?? 0) - (first?.avatarSnapshot?.leftHand?.z ?? 0));
    const rightDx = Math.abs((second?.avatarSnapshot?.rightHand?.x ?? 0) - (first?.avatarSnapshot?.rightHand?.x ?? 0));
    const rightDy = Math.abs((second?.avatarSnapshot?.rightHand?.y ?? 0) - (first?.avatarSnapshot?.rightHand?.y ?? 0));
    const rightDz = Math.abs((second?.avatarSnapshot?.rightHand?.z ?? 0) - (first?.avatarSnapshot?.rightHand?.z ?? 0));

    expect(Math.max(leftDx, leftDy, leftDz, rightDx, rightDy, rightDz)).toBeLessThan(0.001);
  });

  test("staging hall web drag-release does not trigger teleport click", async ({ page }) => {
    const hallRoomId = stagingSceneRooms[0]!.roomId;
    await page.goto(`/rooms/${hallRoomId}?debug=1`);

    await expect.poll(async () => {
      const debug = await readSelfAvatarDebug(page);
      return {
        connected: Boolean(debug?.statusLine),
        currentSeatId: debug?.currentSeatId ?? null
      };
    }, {
      timeout: 25000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      connected: true,
      currentSeatId: null
    });

    await page.mouse.move(300, 300);
    await page.mouse.down();
    await page.mouse.move(520, 360, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    const debug = await readSelfAvatarDebug(page);
    expect(debug?.statusLine ?? "").not.toContain("Teleported");
    expect(debug?.currentSeatId ?? null).toBeNull();
  });

  test("staging hall debug fit preserves spawn floor height", async ({ page }) => {
    const hallSceneRoom = stagingSceneRooms[0]!;
    test.setTimeout(hallSceneRoom.timeoutMs + 15000);
    const hallRoomId = hallSceneRoom.roomId;
    await page.goto(`/rooms/${hallRoomId}?debug=1`);

    await expect.poll(async () => {
      return page.evaluate(() => {
        const debug = (window as Window & {
          __VRATA_DEBUG__?: {
            statusLine?: string | null;
            sceneBundleState?: string | null;
            avatarSnapshot?: {
              root?: { y?: number | null } | null;
            } | null;
          };
        }).__VRATA_DEBUG__;
        return {
          statusReady: Boolean(debug?.statusLine),
          sceneBundleState: debug?.sceneBundleState ?? null,
          rootY: debug?.avatarSnapshot?.root?.y ?? null
        };
      });
    }, {
      timeout: hallSceneRoom.timeoutMs,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      statusReady: true,
      sceneBundleState: "loaded",
      rootY: 0
    });
  });

  test("staging canonical hall avatarvr seat and teleport exit flow works", async ({ page }) => {
    test.setTimeout(60000);
    const hallRoomId = stagingSceneRooms[0]!.roomId;
    await page.goto(`/rooms/${hallRoomId}?debug=1&scenefit=0&avatarvrmock=1`);

    await expect.poll(async () => {
      const debug = await readSelfAvatarDebug(page);
      return {
        sceneBundleState: debug?.sceneBundleState ?? null,
        roomStateConnected: debug?.roomStateConnected ?? false,
        inputMode: debug?.avatarSnapshot?.inputMode ?? null,
        visibility: debug?.avatarSnapshot?.visibilityState ?? null
      };
    }, {
      timeout: 45000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      sceneBundleState: "loaded",
      roomStateConnected: true,
      inputMode: "vr-controller",
      visibility: "hands-only"
    });

    await expect.poll(async () => {
      return page.evaluate(() => (window as Window & {
        __VRATA_TEST__?: { claimSeatById?: (seatId: string) => boolean };
      }).__VRATA_TEST__?.claimSeatById?.("hall-seat-a") ?? false);
    }, {
      timeout: 10000,
      intervals: [500, 1000, 1500]
    }).toBeTruthy();

    await expect.poll(async () => {
      const debug = await readSelfAvatarDebug(page);
      return {
        currentSeatId: debug?.currentSeatId ?? null
      };
    }, {
      timeout: 15000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      currentSeatId: "hall-seat-a"
    });

    await expect.poll(async () => {
      return page.evaluate(() => (window as Window & {
        __VRATA_TEST__?: { teleportToFloor?: (x: number, z: number) => boolean };
      }).__VRATA_TEST__?.teleportToFloor?.(0, -4) ?? false);
    }, {
      timeout: 10000,
      intervals: [500, 1000, 1500]
    }).toBeTruthy();

    await expect.poll(async () => {
      const debug = await readSelfAvatarDebug(page);
      return {
        currentSeatId: debug?.currentSeatId ?? null,
        localPositionZ: Number((debug?.localPosition?.z ?? 0).toFixed(1))
      };
    }, {
      timeout: 15000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      currentSeatId: null,
      localPositionZ: -4
    });
  });

  test("staging fresh hall mock VR can target and claim a seat through XR interaction path", async ({ page, request }) => {
    test.setTimeout(90000);

    const targetName = `Staging Hall Mock VR Seat ${Date.now()}`;
    let roomId: string | null = null;
    try {
      const createRoomResponse = await request.post("/api/rooms", {
        headers: {
          "x-vrata-admin-token": stagingAdminToken
        },
        data: {
          tenantId: "demo-tenant",
          templateId: "meeting-room-basic",
          name: targetName,
          guestAllowed: true,
          sceneBundleUrl: hallSceneBundleUrl,
          avatarConfig: {
            avatarsEnabled: true,
            avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
            avatarQualityProfile: "desktop-standard",
            avatarFallbackCapsulesEnabled: true,
            avatarSeatsEnabled: true
          }
        }
      });
      expect(createRoomResponse.ok()).toBeTruthy();
      const room = await createRoomResponse.json() as { roomId: string };
      roomId = room.roomId;

      await page.goto(`/rooms/${room.roomId}?debug=1&avatarvrmock=1`);

      await expect.poll(async () => {
        const debug = await readSelfAvatarDebug(page);
        return {
          sceneBundleState: debug?.sceneBundleState ?? null,
          roomStateConnected: debug?.roomStateConnected ?? false,
          inputMode: debug?.avatarSnapshot?.inputMode ?? null,
          visibility: debug?.avatarSnapshot?.visibilityState ?? null
        };
      }, {
        timeout: 45000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        sceneBundleState: "loaded",
        roomStateConnected: true,
        inputMode: "vr-controller",
        visibility: "hands-only"
      });

      await expect.poll(async () => {
        return page.evaluate(() => (window as Window & {
          __VRATA_TEST__?: { forceXrInteractionAtSeat?: (seatId: string) => boolean };
        }).__VRATA_TEST__?.forceXrInteractionAtSeat?.("hall-seat-a") ?? false);
      }, {
        timeout: 20000,
        intervals: [1000, 2000, 3000]
      }).toBeTruthy();

      await expect.poll(async () => {
        const debug = await readSelfAvatarDebug(page);
        return {
          rayActive: debug?.interactionRay?.active ?? false,
          targetKind: debug?.interactionRay?.targetKind ?? null,
          seatId: debug?.interactionRay?.seatId ?? null
        };
      }, {
        timeout: 10000,
        intervals: [500, 1000, 1500]
      }).toEqual({
        rayActive: true,
        targetKind: "seat",
        seatId: "hall-seat-a"
      });

      await page.evaluate(() => {
        (window as Window & {
          __VRATA_TEST__?: {
            setSyntheticXrState?: (state: {
              rightController: { x: number; y: number; z: number };
              rightGrip?: { x: number; y: number; z: number } | null;
              rayDirection: { x: number; y: number; z: number };
              axes?: { moveX?: number; moveY?: number; turnX?: number; turnY?: number };
              triggerPressed?: boolean;
              rayVisible?: boolean;
            } | null) => boolean;
          };
        }).__VRATA_TEST__?.setSyntheticXrState?.({
          rightController: { x: 0.54, y: 0.88, z: -0.81 },
          rightGrip: { x: 0.57, y: 0.88, z: -0.81 },
          rayDirection: { x: 0.74, y: -0.45, z: -0.51 },
          axes: { turnX: 0, turnY: -1, moveX: 0, moveY: 0 },
          triggerPressed: true,
          rayVisible: true
        });
      });

      await expect.poll(async () => {
        const debug = await readSelfAvatarDebug(page);
        return {
          currentSeatId: debug?.currentSeatId ?? null
        };
      }, {
        timeout: 15000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        currentSeatId: "hall-seat-a"
      });

      await page.evaluate(() => {
        (window as Window & {
          __VRATA_TEST__?: { setSyntheticXrState?: (state: null) => boolean };
        }).__VRATA_TEST__?.setSyntheticXrState?.(null);
      });
    } finally {
      if (roomId) {
        const deleteResponse = await request.delete(`/api/rooms/${roomId}`, {
          headers: {
            "x-vrata-admin-token": stagingAdminToken
          }
        });
        expect(deleteResponse.ok()).toBeTruthy();
      }
    }
  });

  test("staging fresh BlueOffice mock VR writes XR telemetry history for ray and trigger actions", async ({ page, request }) => {
    test.setTimeout(90000);

    const targetName = `Staging BlueOffice Mock VR Telemetry ${Date.now()}`;
    let roomId: string | null = null;
    try {
      const createRoomResponse = await request.post("/api/rooms", {
        headers: {
          "x-vrata-admin-token": stagingAdminToken
        },
        data: {
          tenantId: "demo-tenant",
          templateId: "meeting-room-basic",
          name: targetName,
          guestAllowed: true,
          sceneBundleUrl: blueOfficeSceneBundleUrl,
          avatarConfig: {
            avatarsEnabled: true,
            avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
            avatarQualityProfile: "desktop-standard",
            avatarFallbackCapsulesEnabled: true,
            avatarSeatsEnabled: true
          }
        }
      });
      expect(createRoomResponse.ok()).toBeTruthy();
      const room = await createRoomResponse.json() as { roomId: string };
      roomId = room.roomId;

      await page.goto(`/rooms/${room.roomId}?debug=1&avatarvrmock=1`);
      await expect.poll(async () => {
        const debug = await readSelfAvatarDebug(page);
        return {
          sceneBundleState: debug?.sceneBundleState ?? null,
          roomStateConnected: debug?.roomStateConnected ?? false,
          inputMode: debug?.avatarSnapshot?.inputMode ?? null,
          visibility: debug?.avatarSnapshot?.visibilityState ?? null
        };
      }, {
        timeout: 45000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        sceneBundleState: "loaded",
        roomStateConnected: true,
        inputMode: "vr-controller",
        visibility: "hands-only"
      });

      await expect.poll(async () => {
        return page.evaluate(() => (window as Window & {
          __VRATA_TEST__?: { forceXrInteractionAtSeat?: (seatId: string) => boolean };
        }).__VRATA_TEST__?.forceXrInteractionAtSeat?.("blueoffice-seat-a") ?? false);
      }, {
        timeout: 20000,
        intervals: [1000, 2000, 3000]
      }).toBeTruthy();

      await page.evaluate(() => {
        (window as Window & {
          __VRATA_TEST__?: {
            setSyntheticXrState?: (state: {
              rightController: { x: number; y: number; z: number };
              rightGrip?: { x: number; y: number; z: number } | null;
              rayDirection: { x: number; y: number; z: number };
              axes?: { moveX?: number; moveY?: number; turnX?: number; turnY?: number };
              triggerPressed?: boolean;
              rayVisible?: boolean;
            } | null) => boolean;
          };
        }).__VRATA_TEST__?.setSyntheticXrState?.({
          rightController: { x: 1.54, y: 0.88, z: -0.81 },
          rightGrip: { x: 1.57, y: 0.88, z: -0.81 },
          rayDirection: { x: 0.74, y: -0.45, z: -0.51 },
          axes: { turnX: 0, turnY: -1, moveX: 0, moveY: 0 },
          triggerPressed: true,
          rayVisible: true
        });
      });

      await expect.poll(async () => {
        const debug = await readSelfAvatarDebug(page);
        return {
          currentSeatId: debug?.currentSeatId ?? null
        };
      }, {
        timeout: 15000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        currentSeatId: "blueoffice-seat-a"
      });

      await page.evaluate(() => {
        (window as Window & {
          __VRATA_TEST__?: {
            setSyntheticXrState?: (state: null) => boolean;
          };
        }).__VRATA_TEST__?.setSyntheticXrState?.(null);
      });

      await expect.poll(async () => {
        const telemetryResponse = await request.get(`/api/rooms/${room.roomId}/xr-telemetry`, {
          headers: {
            "x-vrata-admin-token": stagingAdminToken
          }
        });
        const payload = await telemetryResponse.json() as {
          items?: Array<{
            history?: Array<{ kind?: string | null; kinds?: string[]; currentSeatId?: string | null }>;
          }>;
        };
        const history = (payload.items ?? []).flatMap((item) => item.history ?? []);
        return {
          hasRayOn: history.some((item) => item.kind === "ray_on" || item.kinds?.includes("ray_on")),
          hasTriggerPress: history.some((item) => item.kind === "trigger_press" || item.kinds?.includes("trigger_press")),
          hasSeatClaim: history.some((item) => item.kind === "seat_claim" || item.kinds?.includes("seat_claim")),
          hasSeatState: history.some((item) => item.currentSeatId === "blueoffice-seat-a")
        };
      }, {
        timeout: 15000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        hasRayOn: true,
        hasTriggerPress: true,
        hasSeatClaim: true,
        hasSeatState: true
      });
    } finally {
      if (roomId) {
        const deleteResponse = await request.delete(`/api/rooms/${roomId}`, {
          headers: {
            "x-vrata-admin-token": stagingAdminToken
          }
        });
        expect(deleteResponse.ok()).toBeTruthy();
      }
    }
  });

  test("staging desktop observer keeps remote mock VR hands visible", async ({ browser, request }) => {
    const targetName = `Staging Avatar Mock VR ${Date.now()}`;
    let roomId: string | null = null;

    try {
      const createRoomResponse = await request.post("/api/rooms", {
        headers: {
          "x-vrata-admin-token": stagingAdminToken
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
      const room = await createRoomResponse.json() as { roomId: string };
      roomId = room.roomId;

      const vrPage = await browser.newPage();
      const webPage = await browser.newPage();
      try {
        await vrPage.goto(`/rooms/${room.roomId}?debug=1&avatarvrmock=1`, { waitUntil: "domcontentloaded" });
        await webPage.goto(`/rooms/${room.roomId}?debug=1`, { waitUntil: "domcontentloaded" });

        await expect.poll(async () => {
          const vrDebug = await readSelfAvatarDebug(vrPage);
          const webDebug = await webPage.evaluate(() => (window as Window & {
            __VRATA_DEBUG__?: {
              remoteAvatarReliableStates?: Array<{ inputMode?: string | null }>;
              remoteParticipants?: Array<{
                participantId?: string | null;
                root?: { x?: number | null; y?: number | null; z?: number | null; yaw?: number | null };
                body?: { x?: number | null; y?: number | null; z?: number | null; yaw?: number | null };
                head?: { x?: number | null; y?: number | null; z?: number | null; yaw?: number | null; pitch?: number | null };
                appliedRootYaw?: number | null;
                appliedHeadYaw?: number | null;
              }>;
              remoteAvatarParticipants?: Array<{
                participantId?: string | null;
                inputMode?: string | null;
                presenceSeen?: boolean;
                hasReliableState?: boolean;
                hasPoseFrame?: boolean;
                leftHandVisible?: boolean;
                rightHandVisible?: boolean;
              }>;
            };
          }).__VRATA_DEBUG__);
          const remoteVrParticipant = webDebug?.remoteAvatarParticipants?.find((item) =>
            item.inputMode === "vr-controller"
            && item.presenceSeen
            && item.hasReliableState
            && item.hasPoseFrame
            && item.leftHandVisible
            && item.rightHandVisible
          );
          const remoteVrModel = webDebug?.remoteParticipants?.find((item) =>
            item.participantId === remoteVrParticipant?.participantId
          );
          const root = remoteVrModel?.root;
          const body = remoteVrModel?.body;
          const head = remoteVrModel?.head;
          const headAboveRoot = typeof root?.y === "number" && typeof head?.y === "number"
            ? head.y - root.y
            : null;
          const bodyAboveRoot = typeof root?.y === "number" && typeof body?.y === "number"
            ? body.y - root.y
            : null;
          const bodyRootDistance = typeof root?.x === "number" && typeof root?.z === "number" && typeof body?.x === "number" && typeof body?.z === "number"
            ? Math.hypot(body.x - root.x, body.z - root.z)
            : null;

          return {
            vrHandsOnly: vrDebug?.avatarSnapshot?.visibilityState ?? null,
            vrControllerProfile: vrDebug?.avatarDebug?.controllerProfile ?? null,
            remoteReliableVr: Boolean(webDebug?.remoteAvatarReliableStates?.some((item) => item.inputMode === "vr-controller")),
            remoteVrHands: Boolean(remoteVrParticipant),
            remoteVrRootHeadBody: Boolean(remoteVrParticipant)
              && typeof root?.yaw === "number"
              && typeof body?.yaw === "number"
              && typeof head?.yaw === "number"
              && typeof remoteVrModel?.appliedRootYaw === "number"
              && typeof remoteVrModel?.appliedHeadYaw === "number"
              && (headAboveRoot ?? 0) > 1.2
              && (headAboveRoot ?? 0) < 2.1
              && (bodyAboveRoot ?? 0) > 0.5
              && (bodyAboveRoot ?? 0) < (headAboveRoot ?? 0)
              && (bodyRootDistance ?? 1) < 0.05
          };
        }, {
          timeout: 60000,
          intervals: [1000, 2000, 3000]
        }).toEqual({
          vrHandsOnly: "hands-only",
          vrControllerProfile: "vr_no_controllers",
          remoteReliableVr: true,
          remoteVrHands: true,
          remoteVrRootHeadBody: true
        });
      } finally {
        await vrPage.close();
        await webPage.close();
      }
    } finally {
      if (roomId) {
        const deleteResponse = await request.delete(`/api/rooms/${roomId}`, {
          headers: {
            "x-vrata-admin-token": stagingAdminToken
          }
        });
        expect(deleteResponse.ok()).toBeTruthy();
      }
    }
  });

  test("staging synthetic XR harness can ray, turn and trigger-seat in BlueOffice", async ({ page }) => {
    const blueOfficeSceneRoom = stagingSceneRooms[1]!;
    test.setTimeout(blueOfficeSceneRoom.timeoutMs + 30000);
    const blueOfficeRoomId = blueOfficeSceneRoom.roomId;
    await page.goto(`/rooms/${blueOfficeRoomId}?debug=1&avatarvrmock=1`, { waitUntil: "domcontentloaded" });

    await expect.poll(async () => {
      const debug = await readSelfAvatarDebug(page);
      return {
        sceneBundleState: debug?.sceneBundleState ?? null,
        inputMode: debug?.avatarSnapshot?.inputMode ?? null,
        visibility: debug?.avatarSnapshot?.visibilityState ?? null
      };
    }, {
      timeout: blueOfficeSceneRoom.timeoutMs,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      sceneBundleState: "loaded",
      inputMode: "vr-controller",
      visibility: "hands-only"
    });

    const initialYaw = await page.evaluate(() => window.__VRATA_DEBUG__?.xrAvatarDebug?.playerRoot?.yaw ?? null);

    await page.evaluate(() => {
      window.__VRATA_TEST__?.setSyntheticXrState?.({
        rightController: { x: 1.54, y: 0.88, z: -0.81 },
        rightGrip: { x: 1.57, y: 0.88, z: -0.81 },
        rayDirection: { x: 0.74, y: -0.45, z: -0.51 },
        axes: { turnX: 0, turnY: -1, moveX: 0, moveY: 0 },
        triggerPressed: false,
        rayVisible: true
      });
    });

    await expect.poll(async () => {
      const debug = await readSelfAvatarDebug(page);
      return {
        active: debug?.interactionRay?.active ?? false,
        target: debug?.interactionRay?.targetKind ?? null,
        seatId: debug?.interactionRay?.seatId ?? null
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 1500]
    }).toEqual({
      active: true,
      target: "floor",
      seatId: null
    });

    await page.evaluate(() => {
      window.__VRATA_TEST__?.setSyntheticXrState?.({
        rightController: { x: 1.54, y: 0.88, z: -0.81 },
        rightGrip: { x: 1.57, y: 0.88, z: -0.81 },
        rayDirection: { x: 0.74, y: -0.45, z: -0.51 },
        axes: { turnX: -0.6, turnY: 0, moveX: 0, moveY: 0 },
        triggerPressed: false,
        rayVisible: false
      });
    });

    await expect.poll(async () => {
      return page.evaluate(() => window.__VRATA_DEBUG__?.xrAvatarDebug?.playerRoot?.yaw ?? null);
    }, {
      timeout: 5000,
      intervals: [250, 500, 1000]
    }).not.toBe(initialYaw);

    await page.evaluate(() => {
      window.__VRATA_TEST__?.forceXrInteractionAtSeat?.("blueoffice-seat-a");
      window.__VRATA_TEST__?.setSyntheticXrState?.({
        rightController: { x: 1.54, y: 0.88, z: -0.81 },
        rightGrip: { x: 1.57, y: 0.88, z: -0.81 },
        rayDirection: { x: 0.74, y: -0.45, z: -0.51 },
        axes: { turnX: 0, turnY: -1, moveX: 0, moveY: 0 },
        triggerPressed: true,
        rayVisible: true
      });
    });

    await expect.poll(async () => {
      const debug = await readSelfAvatarDebug(page);
      return {
        currentSeatId: debug?.currentSeatId ?? null
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 1500]
    }).toEqual({
      currentSeatId: "blueoffice-seat-a"
    });

    await page.evaluate(() => {
      window.__VRATA_TEST__?.setSyntheticXrState?.(null);
    });
  });

  test("hall keeps avatar sync working between two web clients on staging", async ({ browser }) => {
    test.setTimeout(120000);
    const hallRoomId = stagingSceneRooms[0]!.roomId;
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    try {
      await pageA.goto(`/rooms/${hallRoomId}?debug=1&bot=line`);
      await pageB.goto(`/rooms/${hallRoomId}?debug=1&bot=line`);

      await expect.poll(async () => {
        const debugA = await readVrataDebug(pageA);
        const debugB = await readVrataDebug(pageB);
        return {
          aLoaded: debugA?.sceneBundleState ?? null,
          bLoaded: debugB?.sceneBundleState ?? null,
          aReady: (debugA?.remoteAvatarReliableCount ?? 0) >= 1
            && (debugA?.remoteAvatarPoseCount ?? 0) >= 1
            && Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame)),
          bReady: (debugB?.remoteAvatarReliableCount ?? 0) >= 1
            && (debugB?.remoteAvatarPoseCount ?? 0) >= 1
            && Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame))
        };
      }, {
        timeout: 90000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        aLoaded: "loaded",
        bLoaded: "loaded",
        aReady: true,
        bReady: true
      });
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });

  test("hall keeps avatar hands visible between two web clients on staging", async ({ browser }) => {
    test.setTimeout(120000);
    const hallRoomId = stagingSceneRooms[0]!.roomId;
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    try {
      await pageA.goto(`/rooms/${hallRoomId}?debug=1&bot=line`);
      await pageB.goto(`/rooms/${hallRoomId}?debug=1&bot=line`);

      await expect.poll(async () => {
        const debugA = await readVrataDebug(pageA);
        const debugB = await readVrataDebug(pageB);
        return {
          aLoaded: debugA?.sceneBundleState ?? null,
          bLoaded: debugB?.sceneBundleState ?? null,
          aHandsReady: Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible)),
          bHandsReady: Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible))
        };
      }, {
        timeout: 90000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        aLoaded: "loaded",
        bLoaded: "loaded",
        aHandsReady: true,
        bHandsReady: true
      });

      await pageA.waitForTimeout(2500);
      await expect.poll(async () => {
        const debugA = await readVrataDebug(pageA);
        const debugB = await readVrataDebug(pageB);
        return {
          aHandsStable: Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible)),
          bHandsStable: Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && item.leftHandVisible && item.rightHandVisible))
        };
      }, {
        timeout: 15000,
        intervals: [1000, 2000, 3000]
      }).toEqual({
        aHandsStable: true,
        bHandsStable: true
      });
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });
});
