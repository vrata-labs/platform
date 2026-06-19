import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const e2eRoomStatePublicUrl = process.env.E2E_ROOM_STATE_PUBLIC_URL ?? "ws://127.0.0.1:2567";
const e2eRoomStateHost = new URL(e2eRoomStatePublicUrl).host;

function e2eRoomStateHealthUrl(): string {
  const url = new URL(e2eRoomStatePublicUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}

async function createAvatarRoom(request: APIRequestContext, name: string, sceneBundleUrl?: string): Promise<{ roomId: string; roomLink: string }> {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name,
      sceneBundleUrl,
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
  return (await createRoomResponse.json()) as { roomId: string; roomLink: string };
}

async function createAvatarHallRoom(request: APIRequestContext, name: string): Promise<{ roomId: string; roomLink: string }> {
  return createAvatarRoom(request, name, "/assets/scenes/sense-hall2-v1/scene.json");
}

async function readInteractionDebug(page: Page) {
  return page.evaluate(() => (window as Window & {
    __VRATA_DEBUG__?: {
      participantId?: string;
      roomStateConnected?: boolean;
      sceneBundleState?: string;
      localPosition?: { x: number; z: number };
      currentSeatId?: string | null;
      pendingSeatId?: string | null;
      seatOccupancy?: Record<string, string>;
      interactionRay?: {
        targetKind?: "none" | "floor" | "seat";
        seatId?: string | null;
      };
      statusLine?: string;
    };
  }).__VRATA_DEBUG__);
}

async function waitForHallInteractionReady(page: Page) {
  await expect.poll(async () => {
    const debug = await readInteractionDebug(page);
    return {
      roomStateConnected: debug?.roomStateConnected ?? false,
      sceneBundleState: debug?.sceneBundleState ?? null
    };
  }, {
    timeout: 20000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    roomStateConnected: true,
    sceneBundleState: "loaded"
  });
}

function isInactiveLipsyncSourceState(state: string | null): boolean {
  return state === "idle" || state === "muted" || state === "missing";
}

test("room shell loads and presence is registered", async ({ page, request }) => {
  await page.goto("/rooms/demo-room");
  await page.waitForTimeout(3000);

  await expect(page.locator("#room-name")).toContainText("meeting-room-basic - demo-room");
  await expect(page.locator("#status-line")).toContainText("Joined as");
  await expect(page.locator("#room-state-line")).toContainText(/Room-state:/);
  await expect(page.locator("#start-share")).toBeHidden();

  const debug = await page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: unknown }).__VRATA_DEBUG__);
  expect(debug).toBeTruthy();
  const debugState = debug as { roomStateConnected?: boolean; roomStateUrl?: string; access?: { token?: string } };
  expect(debugState.roomStateUrl).toContain(e2eRoomStateHost);
  expect(debugState.access?.token).toBe("[redacted]");

  const presenceResponse = await request.get("/api/rooms/demo-room/presence");
  const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
  expect(presence.items.length).toBeGreaterThan(0);

  await expect.poll(async () => {
    const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
    const diagnostics = (await diagnosticsResponse.json()) as { items: Array<{ note?: string }> };
    return diagnostics.items.some((item) => item.note === "runtime_booted");
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toBeTruthy();
});

test("room shell exposes audio device selectors and level meters", async ({ page }) => {
  await page.goto("/rooms/demo-room");

  await expect(page.locator("#mic-select")).toBeVisible();
  await expect(page.locator("#speaker-select")).toBeVisible();
  await expect(page.locator("#audio-device-status")).toBeVisible();
  await expect(page.locator("#mic-level-fill").locator(".."))
    .toBeVisible();
  await expect(page.locator("#speaker-level-fill").locator(".."))
    .toBeVisible();
  await expect(page.locator("#mic-select option").first()).toContainText("System default microphone");
  await expect(page.locator("#speaker-select option").first()).toContainText("System default speaker");
  await expect(page.locator("#audio-device-status")).not.toHaveText("");
});

test("mobile room HUD can collapse and scroll without covering the scene", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 520 });
  await page.goto("/rooms/demo-room?debug=1");

  const hud = page.locator(".hud");
  const summary = page.locator(".hud-summary");

  await expect(summary).toBeVisible();
  await expect(hud).toHaveJSProperty("open", true);

  const openMetrics = await hud.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const content = element.querySelector<HTMLElement>(".hud-content");
    return {
      bottom: rect.bottom,
      contentClientHeight: content?.clientHeight ?? 0,
      contentOverflowY: content ? getComputedStyle(content).overflowY : "",
      contentScrollHeight: content?.scrollHeight ?? 0,
      height: rect.height,
      viewportHeight: window.innerHeight
    };
  });

  expect(openMetrics.bottom).toBeLessThanOrEqual(openMetrics.viewportHeight);
  expect(openMetrics.height).toBeLessThanOrEqual(openMetrics.viewportHeight * 0.75);
  expect(openMetrics.contentOverflowY).toBe("auto");
  expect(openMetrics.contentScrollHeight).toBeGreaterThan(openMetrics.contentClientHeight);

  await summary.click();
  await expect(hud).toHaveJSProperty("open", false);

  const collapsedHeight = await hud.evaluate((element) => element.getBoundingClientRect().height);
  expect(collapsedHeight).toBeLessThan(openMetrics.height);
});

test("mobile unsupported media APIs disable audio and share controls with diagnostics", async ({ browser }) => {
  const mobileContext = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1"
  });
  await mobileContext.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => []
      }
    });
  });
  const mobilePage = await mobileContext.newPage();

  try {
    await mobilePage.goto("/rooms/demo-room?role=host&debug=1");

    await expect(mobilePage.locator("#join-audio")).toBeDisabled();
    await expect(mobilePage.locator("#join-audio")).toContainText("Audio Unsupported");
    await expect(mobilePage.locator("#start-share")).toBeDisabled();
    await expect(mobilePage.locator("#start-share")).toContainText("Share Unsupported");
    await expect(mobilePage.locator("#audio-device-status")).toContainText("Microphone unsupported");
    await expect(mobilePage.locator("#audio-device-status")).toContainText("Screen share unsupported");

    const debug = await mobilePage.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: {
        mediaCapabilities?: {
          audioInput?: { supported?: boolean; reason?: string };
          screenShare?: { supported?: boolean; reason?: string };
        };
        screenShareState?: string;
      };
    }).__VRATA_DEBUG__);
    expect(debug?.mediaCapabilities?.audioInput?.supported).toBe(false);
    expect(debug?.mediaCapabilities?.audioInput?.reason).toBe("get_user_media_missing");
    expect(debug?.mediaCapabilities?.screenShare?.supported).toBe(false);
    expect(debug?.mediaCapabilities?.screenShare?.reason).toBe("get_display_media_missing");
    expect(debug?.screenShareState).toBe("unsupported");
  } finally {
    await mobileContext.close();
  }
});

test("mobile right-side drag turns the camera", async ({ browser }) => {
  const mobileContext = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  });
  const mobilePage = await mobileContext.newPage();

  async function dispatchTouch(type: "touchstart" | "touchmove" | "touchend", clientX: number, clientY: number): Promise<void> {
    await mobilePage.evaluate(({ type, clientX, clientY }) => {
      const canvas = document.querySelector("canvas");
      if (!canvas) {
        throw new Error("canvas missing");
      }
      const touch = new Touch({
        identifier: 1,
        target: canvas,
        clientX,
        clientY
      });
      canvas.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [touch],
        targetTouches: type === "touchend" ? [] : [touch],
        changedTouches: [touch]
      }));
    }, { type, clientX, clientY });
  }

  try {
    await mobilePage.goto("/rooms/demo-room?debug=1");
    await mobilePage.locator("canvas").waitFor();

    const yawBefore = await mobilePage.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: { localPose?: { root?: { yaw?: number } } };
    }).__VRATA_DEBUG__?.localPose?.root?.yaw ?? 0);

    await dispatchTouch("touchstart", 340, 420);
    await dispatchTouch("touchmove", 260, 420);
    await dispatchTouch("touchend", 260, 420);

    await expect.poll(async () => mobilePage.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: { localPose?: { root?: { yaw?: number } } };
    }).__VRATA_DEBUG__?.localPose?.root?.yaw ?? 0), {
      timeout: 5000,
      intervals: [100, 250, 500]
    }).not.toBe(yawBefore);
  } finally {
    await mobileContext.close();
  }
});

test("room-state service health endpoint responds", async () => {
  const response = await fetch(e2eRoomStateHealthUrl());
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

  const debugA = await pageA.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { remoteAvatarCount: number } }).__VRATA_DEBUG__);
  const debugB = await pageB.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { remoteAvatarCount: number } }).__VRATA_DEBUG__);

  expect(debugA?.remoteAvatarCount).toBeGreaterThanOrEqual(1);
  expect(debugB?.remoteAvatarCount).toBeGreaterThanOrEqual(1);

  const presenceResponse = await request.get("http://127.0.0.1:4000/api/rooms/demo-room/presence");
  const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
  expect(presence.items.length).toBeGreaterThanOrEqual(2);

  await pageA.close();
  await pageB.close();
});

test("API fallback presence stays visible to realtime room-state clients", async ({ browser, request }) => {
  const room = await createAvatarRoom(request, `Mixed Presence ${Date.now()}`);
  const realtimePage = await browser.newPage();
  const fallbackPage = await browser.newPage();

  try {
    await realtimePage.goto(`http://127.0.0.1:4000/rooms/${room.roomId}?debug=1&bot=line`);
    await fallbackPage.goto(`http://127.0.0.1:4000/rooms/${room.roomId}?debug=1&failroomstate=1&bot=line`);

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
          roomStateConnected?: boolean;
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
      timeout: 30000,
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
});

test("bot mode emits movement diagnostics automatically", async ({ page, request }) => {
  await page.goto("/rooms/demo-room?bot=line&botStart=0,0&debug=1");

  await expect.poll(async () => {
    const debug = await page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { botMode: string; localPosition: { x: number; z: number } } }).__VRATA_DEBUG__);
    expect(debug?.botMode).toBe("line");
    return Math.max(Math.abs(debug?.localPosition.x ?? 0), Math.abs(debug?.localPosition.z ?? 0));
  }, {
    timeout: 10000,
    intervals: [1000, 2000, 3000]
  }).toBeGreaterThan(0.5);

  const debug = await page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { botMode: string; localPosition: { x: number; z: number } } }).__VRATA_DEBUG__);
  expect(debug?.botMode).toBe("line");

  await expect.poll(async () => {
    const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
    const diagnostics = (await diagnosticsResponse.json()) as {
      items: Array<{ localPosition: { x: number; z: number } }>;
    };
    return diagnostics.items.some((item) => Math.abs(item.localPosition.x) + Math.abs(item.localPosition.z) > 0.5);
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBeTruthy();
});

test("avatar sandbox exposes avatar diagnostics and persists them via diagnostics API", async ({ page, request }) => {
  await page.goto("/rooms/demo-room?avatarsandbox=1&debug=1");

  await expect.poll(async () => {
    const debug = await page.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: {
        avatarDebug?: {
          state?: string;
          presetCount?: number;
          selectedAvatarId?: string | null;
          fallbackActive?: boolean;
        };
      };
    }).__VRATA_DEBUG__);

    return {
      state: debug?.avatarDebug?.state,
      presetCount: debug?.avatarDebug?.presetCount ?? 0,
      selectedAvatarId: debug?.avatarDebug?.selectedAvatarId ?? null,
      fallbackActive: debug?.avatarDebug?.fallbackActive ?? true
    };
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    state: "loaded",
    presetCount: 10,
    selectedAvatarId: "preset-01",
    fallbackActive: false
  });

  await expect.poll(async () => {
    const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
    const diagnostics = (await diagnosticsResponse.json()) as {
      items: Array<{
        note?: string;
        avatarDebug?: { state?: string; presetCount?: number; fallbackReason?: string | null };
      }>;
    };

    return diagnostics.items.some((item) => item.note === "avatar_sandbox_booted"
      && item.avatarDebug?.state === "loaded"
      && item.avatarDebug?.presetCount === 10
      && !item.avatarDebug?.fallbackReason);
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toBeTruthy();
});

test("avatar sandbox falls back cleanly on invalid catalog url", async ({ page, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Broken Room",
      avatarConfig: {
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/missing-catalog.v1.json",
        avatarQualityProfile: "desktop-standard",
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: false
      }
    }
  });
  expect(createRoomResponse.ok()).toBeTruthy();
  const room = (await createRoomResponse.json()) as { roomLink: string; roomId: string };

  await page.goto(`${room.roomLink}?avatarsandbox=1&debug=1`);

  await expect.poll(async () => {
    const debug = await page.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: {
        avatarDebug?: { state?: string; fallbackActive?: boolean; fallbackReason?: string | null };
      };
    }).__VRATA_DEBUG__);
    return {
      state: debug?.avatarDebug?.state,
      fallbackActive: debug?.avatarDebug?.fallbackActive ?? false,
      fallbackReason: debug?.avatarDebug?.fallbackReason ?? null
    };
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    state: "failed",
    fallbackActive: true,
    fallbackReason: "failed_to_load_avatar_catalog:404"
  });

  await expect.poll(async () => {
    const diagnosticsResponse = await request.get(`/api/rooms/${room.roomId}/diagnostics`);
    const diagnostics = (await diagnosticsResponse.json()) as {
      items: Array<{ note?: string; avatarDebug?: { fallbackReason?: string | null } }>;
    };
    return diagnostics.items.some((item) => item.note === "avatar_sandbox_failed" && item.avatarDebug?.fallbackReason === "failed_to_load_avatar_catalog:404");
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toBeTruthy();
});

test("avatar-enabled room exposes local self-avatar diagnostics in normal room flow", async ({ page, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Runtime Room",
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
  const room = (await createRoomResponse.json()) as { roomId: string; roomLink: string };

  await page.goto(`${room.roomLink}?debug=1&bot=line`);

  await expect.poll(async () => {
    const debug = await page.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: {
        avatarDebug?: {
          state?: string;
          selectedAvatarId?: string | null;
          visibilityState?: string | null;
          locomotionState?: string | null;
          animationState?: string | null;
          controllerProfile?: string | null;
          inputMode?: string | null;
        };
        avatarSnapshot?: {
          avatarId?: string | null;
          visibilityState?: string | null;
          controllerProfile?: string | null;
          locomotionState?: string | null;
        };
        avatarTransportPreview?: {
          reliableState?: { avatarId?: string | null; inputMode?: string | null };
          poseFrame?: { root?: { x?: number | null }; locomotion?: { mode?: number | null } };
        };
      };
    }).__VRATA_DEBUG__);

    return {
      state: debug?.avatarDebug?.state ?? null,
      selectedAvatarId: debug?.avatarDebug?.selectedAvatarId ?? null,
      visibilityState: debug?.avatarDebug?.visibilityState ?? null,
      locomotionState: debug?.avatarDebug?.locomotionState ?? null,
      animationState: debug?.avatarDebug?.animationState ?? null,
      controllerProfile: debug?.avatarDebug?.controllerProfile ?? null,
      inputMode: debug?.avatarDebug?.inputMode ?? null,
      snapshotAvatarId: debug?.avatarSnapshot?.avatarId ?? null,
      snapshotVisibilityState: debug?.avatarSnapshot?.visibilityState ?? null,
      snapshotControllerProfile: debug?.avatarSnapshot?.controllerProfile ?? null,
      snapshotLocomotionState: debug?.avatarSnapshot?.locomotionState ?? null,
      transportAvatarId: debug?.avatarTransportPreview?.reliableState?.avatarId ?? null,
      transportInputMode: debug?.avatarTransportPreview?.reliableState?.inputMode ?? null,
      transportLocomotionMode: debug?.avatarTransportPreview?.poseFrame?.locomotion?.mode ?? null
    };
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    state: "loaded",
    selectedAvatarId: "preset-01",
      visibilityState: "hands-only",
    locomotionState: "walk",
    animationState: "idle",
    controllerProfile: "desktop_no_controllers",
    inputMode: "desktop",
    snapshotAvatarId: "preset-01",
      snapshotVisibilityState: "hands-only",
    snapshotControllerProfile: "desktop_no_controllers",
    snapshotLocomotionState: "walk",
    transportAvatarId: "preset-01",
    transportInputMode: "desktop",
    transportLocomotionMode: 1
  });

  await expect.poll(async () => {
    const diagnosticsResponse = await request.get(`/api/rooms/${room.roomId}/diagnostics`);
    const diagnostics = (await diagnosticsResponse.json()) as {
      items: Array<{
        note?: string;
        avatarDebug?: { state?: string; visibilityState?: string | null; locomotionState?: string | null; animationState?: string | null };
        avatarSnapshot?: { avatarId?: string | null; controllerProfile?: string | null };
        avatarTransportPreview?: {
          reliableState?: { avatarId?: string | null; inputMode?: string | null };
          poseFrame?: { seq?: number | null; locomotion?: { mode?: number | null } };
        };
      }>;
    };

    return diagnostics.items.some((item) => (item.note === "local_avatar_ready" || item.note === undefined)
      && item.avatarDebug?.state === "loaded"
      && item.avatarDebug?.visibilityState === "hands-only"
      && item.avatarDebug?.locomotionState === "walk"
      && item.avatarDebug?.animationState === "idle"
      && item.avatarSnapshot?.avatarId === "preset-01"
      && item.avatarSnapshot?.controllerProfile === "desktop_no_controllers"
      && item.avatarTransportPreview?.reliableState?.avatarId === "preset-01"
      && item.avatarTransportPreview?.reliableState?.inputMode === "desktop"
      && item.avatarTransportPreview?.poseFrame?.seq !== undefined
      && item.avatarTransportPreview?.poseFrame?.locomotion?.mode === 1);
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toBeTruthy();
});

test("avatar-enabled room diagnostics api exposes transport preview payload", async ({ page, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Transport Diagnostics Room",
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
  const room = (await createRoomResponse.json()) as { roomId: string; roomLink: string };

  await page.goto(`${room.roomLink}?debug=1&bot=line`);

  await expect.poll(async () => {
    const diagnosticsResponse = await request.get(`/api/rooms/${room.roomId}/diagnostics`);
    const diagnostics = (await diagnosticsResponse.json()) as {
      items: Array<{
        avatarTransportPreview?: {
          reliableState?: { avatarId?: string | null; inputMode?: string | null };
          poseFrame?: { seq?: number | null; locomotion?: { mode?: number | null } };
        };
      }>;
    };

    return diagnostics.items.some((item) => item.avatarTransportPreview?.reliableState?.avatarId === "preset-01"
      && item.avatarTransportPreview?.reliableState?.inputMode === "desktop"
      && (item.avatarTransportPreview?.poseFrame?.seq ?? 0) > 0
      && item.avatarTransportPreview?.poseFrame?.locomotion?.mode === 1);
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toBeTruthy();
});

test("avatar-enabled room exposes lipsync debug signals for local and remote avatars", async ({ browser, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Lipsync Diagnostics Room",
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
  const room = (await createRoomResponse.json()) as { roomId: string; roomLink: string };

  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  try {
    await pageA.goto(`${room.roomLink}?debug=1&bot=line`);
    await pageB.goto(`${room.roomLink}?debug=1&bot=line`);

    await expect.poll(async () => {
      const debugA = await pageA.evaluate(() => (window as Window & {
        __VRATA_DEBUG__?: {
          avatarDebug?: {
            mouthAmount?: number;
            speakingActive?: boolean;
            lipsyncSourceState?: string | null;
          };
          remoteAvatarParticipants?: Array<{
            mouthAmount?: number;
            speakingActive?: boolean;
            lipsyncSourceState?: string | null;
            hasReliableState?: boolean;
            hasPoseFrame?: boolean;
          }>;
        };
      }).__VRATA_DEBUG__);

      const localSourceState = debugA?.avatarDebug?.lipsyncSourceState ?? null;
      const remoteSourceState = debugA?.remoteAvatarParticipants?.[0]?.lipsyncSourceState ?? null;
      return {
        localMouthAmount: debugA?.avatarDebug?.mouthAmount ?? null,
        localSpeakingActive: debugA?.avatarDebug?.speakingActive ?? null,
        localSourceState,
        localSourceInactive: isInactiveLipsyncSourceState(localSourceState),
        remoteCount: debugA?.remoteAvatarParticipants?.length ?? 0,
        remoteMouthAmount: debugA?.remoteAvatarParticipants?.[0]?.mouthAmount ?? null,
        remoteSpeakingActive: debugA?.remoteAvatarParticipants?.[0]?.speakingActive ?? null,
        remoteSourceState,
        remoteSourceInactive: isInactiveLipsyncSourceState(remoteSourceState),
        remoteHasReliableState: debugA?.remoteAvatarParticipants?.[0]?.hasReliableState ?? false,
        remoteHasPoseFrame: debugA?.remoteAvatarParticipants?.[0]?.hasPoseFrame ?? false
      };
    }, {
      timeout: 15000,
      intervals: [1000, 2000, 3000]
    }).toEqual(expect.objectContaining({
      localMouthAmount: 0,
      localSpeakingActive: false,
      localSourceInactive: true,
      remoteCount: 1,
      remoteMouthAmount: 0,
      remoteSpeakingActive: false,
      remoteSourceInactive: true,
      remoteHasReliableState: true,
      remoteHasPoseFrame: true
    }));

    await expect.poll(async () => {
      const diagnosticsResponse = await request.get(`/api/rooms/${room.roomId}/diagnostics`);
      const diagnostics = (await diagnosticsResponse.json()) as {
        items: Array<{
          avatarDebug?: {
            mouthAmount?: number;
            speakingActive?: boolean;
            lipsyncSourceState?: string | null;
          };
          remoteAvatarParticipants?: Array<{
            mouthAmount?: number;
            speakingActive?: boolean;
            lipsyncSourceState?: string | null;
          }>;
        }>;
      };

      return diagnostics.items.some((item) => item.avatarDebug?.mouthAmount === 0
        && item.avatarDebug?.speakingActive === false
        && isInactiveLipsyncSourceState(item.avatarDebug?.lipsyncSourceState ?? null)
        && item.remoteAvatarParticipants?.some((participant) => participant.mouthAmount === 0
          && participant.speakingActive === false
          && isInactiveLipsyncSourceState(participant.lipsyncSourceState ?? null)));
    }, {
      timeout: 15000,
      intervals: [1000, 2000, 3000]
    }).toBeTruthy();
  } finally {
    await pageA.close();
    await pageB.close();
  }
});

test("avatar-enabled room syncs remote reliable state and pose frames between two clients", async ({ browser, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Remote Sync Room",
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
  const room = (await createRoomResponse.json()) as { roomLink: string };

  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  try {
    await pageA.goto(`${room.roomLink}?debug=1&bot=line`);
    await pageB.goto(`${room.roomLink}?debug=1&bot=line`);

    await expect.poll(async () => {
      const debugA = await pageA.evaluate(() => (window as Window & {
        __VRATA_DEBUG__?: {
          remoteAvatarReliableCount?: number;
          remoteAvatarPoseCount?: number;
          remoteAvatarPoseFrames?: Array<{ seq?: number | null }>;
          remoteAvatarParticipants?: Array<{ hasReliableState?: boolean; hasPoseFrame?: boolean; presenceSeen?: boolean; playbackDelayMs?: number }>;
          avatarPoseTransport?: { targetHz?: number; effectiveHz?: number; adaptivePlaybackDelayMs?: number };
        };
      }).__VRATA_DEBUG__);
      const debugB = await pageB.evaluate(() => (window as Window & {
        __VRATA_DEBUG__?: {
          remoteAvatarReliableCount?: number;
          remoteAvatarPoseCount?: number;
          remoteAvatarPoseFrames?: Array<{ seq?: number | null }>;
          remoteAvatarParticipants?: Array<{ hasReliableState?: boolean; hasPoseFrame?: boolean; presenceSeen?: boolean; playbackDelayMs?: number }>;
          avatarPoseTransport?: { targetHz?: number; effectiveHz?: number; adaptivePlaybackDelayMs?: number };
        };
      }).__VRATA_DEBUG__);

      return {
        aReliable: debugA?.remoteAvatarReliableCount ?? 0,
        aPose: debugA?.remoteAvatarPoseCount ?? 0,
        aSeqReady: (debugA?.remoteAvatarPoseFrames?.[0]?.seq ?? 0) > 0,
        aReady: Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame)),
        aAdaptiveRateReady: (debugA?.avatarPoseTransport?.targetHz ?? 0) >= 8 && (debugA?.avatarPoseTransport?.effectiveHz ?? 0) > 0,
        aPlaybackDelayReady: Boolean(debugA?.remoteAvatarParticipants?.every((item) => (item.playbackDelayMs ?? 0) >= 100 && (item.playbackDelayMs ?? 0) <= 140)),
        bReliable: debugB?.remoteAvatarReliableCount ?? 0,
        bPose: debugB?.remoteAvatarPoseCount ?? 0,
        bSeqReady: (debugB?.remoteAvatarPoseFrames?.[0]?.seq ?? 0) > 0,
        bReady: Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame)),
        bAdaptiveRateReady: (debugB?.avatarPoseTransport?.targetHz ?? 0) >= 8 && (debugB?.avatarPoseTransport?.effectiveHz ?? 0) > 0,
        bPlaybackDelayReady: Boolean(debugB?.remoteAvatarParticipants?.every((item) => (item.playbackDelayMs ?? 0) >= 100 && (item.playbackDelayMs ?? 0) <= 140))
      };
    }, {
      timeout: 20000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      aReliable: 1,
      aPose: 1,
      aSeqReady: true,
      aReady: true,
      aAdaptiveRateReady: true,
      aPlaybackDelayReady: true,
      bReliable: 1,
      bPose: 1,
      bSeqReady: true,
      bReady: true,
      bAdaptiveRateReady: true,
      bPlaybackDelayReady: true
    });

    const finalA = await pageA.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: {
        remoteAvatarPoseFrames?: Array<{ seq?: number | null }>;
      };
    }).__VRATA_DEBUG__);
    const finalB = await pageB.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: {
        remoteAvatarPoseFrames?: Array<{ seq?: number | null }>;
      };
    }).__VRATA_DEBUG__);

    expect((finalA?.remoteAvatarPoseFrames?.[0]?.seq ?? 0)).toBeGreaterThan(0);
    expect((finalB?.remoteAvatarPoseFrames?.[0]?.seq ?? 0)).toBeGreaterThan(0);
  } finally {
    await pageA.close();
    await pageB.close();
  }
});

test("avatar-enabled room keeps separate identities for same-browser tabs", async ({ browser, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Same Browser Tabs Room",
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
  const room = (await createRoomResponse.json()) as { roomLink: string };

  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  try {
    await pageA.goto(`${room.roomLink}?debug=1&bot=line`);
    await pageB.goto(`${room.roomLink}?debug=1&bot=line`);

    await expect.poll(async () => {
      const [idA, debugA, idB, debugB] = await Promise.all([
        pageA.evaluate(() => sessionStorage.getItem("vrata.participantId")),
        pageA.evaluate(() => (window as Window & {
          __VRATA_DEBUG__?: {
            remoteAvatarReliableCount?: number;
            remoteAvatarPoseCount?: number;
            remoteAvatarParticipants?: Array<{ presenceSeen?: boolean; hasReliableState?: boolean; hasPoseFrame?: boolean }>;
          };
        }).__VRATA_DEBUG__),
        pageB.evaluate(() => sessionStorage.getItem("vrata.participantId")),
        pageB.evaluate(() => (window as Window & {
          __VRATA_DEBUG__?: {
            remoteAvatarReliableCount?: number;
            remoteAvatarPoseCount?: number;
            remoteAvatarParticipants?: Array<{ presenceSeen?: boolean; hasReliableState?: boolean; hasPoseFrame?: boolean }>;
          };
        }).__VRATA_DEBUG__)
      ]);

      return {
        distinctIds: Boolean(idA && idB && idA !== idB),
        aReady: (debugA?.remoteAvatarReliableCount ?? 0) === 1
          && (debugA?.remoteAvatarPoseCount ?? 0) === 1
          && Boolean(debugA?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame)),
        bReady: (debugB?.remoteAvatarReliableCount ?? 0) === 1
          && (debugB?.remoteAvatarPoseCount ?? 0) === 1
          && Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame))
      };
    }, {
      timeout: 20000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      distinctIds: true,
      aReady: true,
      bReady: true
    });
  } finally {
    await context.close();
  }
});

test("avatar-enabled room recovers remote avatar state after late join and forced reconnect", async ({ browser, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Reconnect Room",
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
  const room = (await createRoomResponse.json()) as { roomLink: string };

  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  try {
    await pageA.goto(`${room.roomLink}?debug=1&bot=line`);

    await pageB.goto(`${room.roomLink}?debug=1&bot=line`);
    await expect.poll(async () => {
      const debugB = await pageB.evaluate(() => (window as Window & {
        __VRATA_DEBUG__?: {
          remoteAvatarParticipants?: Array<{ presenceSeen?: boolean; hasReliableState?: boolean; hasPoseFrame?: boolean }>;
        };
      }).__VRATA_DEBUG__);
      return Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame));
    }, {
      timeout: 20000,
      intervals: [1000, 2000, 3000]
    }).toBeTruthy();

    await pageA.evaluate(() => {
      (window as Window & { __VRATA_TEST__?: { forceRoomStateReconnect?: () => void } }).__VRATA_TEST__?.forceRoomStateReconnect?.();
    });

    await expect.poll(async () => {
      const debugA = await pageA.evaluate(() => (window as Window & {
        __VRATA_DEBUG__?: {
          avatarPoseTransport?: { reconnectRepublishCount?: number; effectiveHz?: number };
          roomStateConnected?: boolean;
        };
      }).__VRATA_DEBUG__);
      const debugB = await pageB.evaluate(() => (window as Window & {
        __VRATA_DEBUG__?: {
          remoteAvatarCount?: number;
          remoteAvatarReliableCount?: number;
          remoteAvatarPoseCount?: number;
          remoteAvatarParticipants?: Array<{
            participantId?: string;
            presenceSeen?: boolean;
            hasReliableState?: boolean;
            hasPoseFrame?: boolean;
            poseBufferDepth?: number;
          }>;
        };
      }).__VRATA_DEBUG__);
      return {
        reconnectRepublished: (debugA?.avatarPoseTransport?.reconnectRepublishCount ?? 0) > 0,
        reconnected: debugA?.roomStateConnected ?? false,
        remoteCount: debugB?.remoteAvatarCount ?? 0,
        reliableCount: debugB?.remoteAvatarReliableCount ?? 0,
        poseCount: debugB?.remoteAvatarPoseCount ?? 0,
        participantSlots: debugB?.remoteAvatarParticipants?.length ?? 0,
        remoteReady: Boolean(debugB?.remoteAvatarParticipants?.some((item) => item.presenceSeen && item.hasReliableState && item.hasPoseFrame && (item.poseBufferDepth ?? 0) > 0))
      };
    }, {
      timeout: 20000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      reconnectRepublished: true,
      reconnected: true,
      remoteCount: 1,
      reliableCount: 1,
      poseCount: 1,
      participantSlots: 1,
      remoteReady: true
    });
  } finally {
    await pageA.close();
    await pageB.close();
  }
});

test("avatar-enabled room keeps mobile self avatar hands-only on mobile user agent", async ({ browser, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Mobile Room",
      avatarConfig: {
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "mobile-lite",
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: false
      }
    }
  });
  expect(createRoomResponse.ok()).toBeTruthy();
  const room = (await createRoomResponse.json()) as { roomLink: string };

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  });
  const mobilePage = await mobileContext.newPage();

  try {
    await mobilePage.goto(`${room.roomLink}?debug=1`);
    await expect.poll(async () => {
      const debug = await mobilePage.evaluate(() => (window as Window & {
        __VRATA_DEBUG__?: {
          avatarDebug?: {
            state?: string;
            visibilityState?: string | null;
            controllerProfile?: string | null;
            inputMode?: string | null;
          };
        };
      }).__VRATA_DEBUG__);

      return {
        state: debug?.avatarDebug?.state ?? null,
        visibilityState: debug?.avatarDebug?.visibilityState ?? null,
        controllerProfile: debug?.avatarDebug?.controllerProfile ?? null,
        inputMode: debug?.avatarDebug?.inputMode ?? null
      };
    }, {
      timeout: 15000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      state: "loaded",
      visibilityState: "hands-only",
      controllerProfile: "mobile_touch_fallback",
      inputMode: "mobile"
    });
  } finally {
    await mobileContext.close();
  }
});

test("avatar-enabled room lets user switch self-avatar preset in normal room flow", async ({ page, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Switch Room",
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
  const room = (await createRoomResponse.json()) as { roomLink: string };

  await page.goto(`${room.roomLink}?debug=1`);
  await expect(page.locator("#avatar-sandbox-panel")).toBeVisible();
  await page.selectOption("#avatar-preset-select", "preset-02");

  await expect.poll(async () => {
    const debug = await page.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: {
        avatarDebug?: {
          state?: string;
          selectedAvatarId?: string | null;
        };
        avatarSnapshot?: {
          avatarId?: string | null;
        };
      };
    }).__VRATA_DEBUG__);
    return {
      state: debug?.avatarDebug?.state ?? null,
      selectedAvatarId: debug?.avatarDebug?.selectedAvatarId ?? null,
      snapshotAvatarId: debug?.avatarSnapshot?.avatarId ?? null
    };
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    state: "loaded",
    selectedAvatarId: "preset-02",
    snapshotAvatarId: "preset-02"
  });

  await expect(page.locator("#avatar-sandbox-status")).toContainText("preset-02");
});

test("avatar runtime keeps baseline path by default and exposes experimental leg IK only via query override", async ({ page, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Presence Mode Room",
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
  const room = (await createRoomResponse.json()) as { roomLink: string };

  await page.goto(`${room.roomLink}?debug=1`);
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
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    mode: "baseline",
    avatarLegIkEnabled: false
  });

  await page.goto(`${room.roomLink}?debug=1&avatarik=1`);
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
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    mode: "experimental-leg-ik",
    avatarLegIkEnabled: true
  });
});

test("room creation API returns a usable room link", async ({ page, request }) => {
  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
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

test("runtime HUD space selector lists guest-safe spaces and marks current room", async ({ page, request }) => {
  const uniqueSuffix = Date.now().toString(36);
  const sharedRoomName = `Shared Space Room ${uniqueSuffix}`;
  const privateRoomName = `Private Space Room ${uniqueSuffix}`;
  const sharedRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: sharedRoomName,
      guestAllowed: true
    }
  });
  expect(sharedRoomResponse.ok()).toBeTruthy();

  const privateRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: privateRoomName,
      guestAllowed: false
    }
  });
  expect(privateRoomResponse.ok()).toBeTruthy();

  await page.goto("/rooms/demo-room");
  await page.waitForTimeout(3000);

  const spaceSelect = page.locator("#space-select");
  await expect(spaceSelect).toBeVisible();
  await expect(spaceSelect).toHaveValue(/\/rooms\/demo-room$/);

  const optionTexts = await spaceSelect.locator("option").allTextContents();
  expect(optionTexts).toContain("Demo Room");
  expect(optionTexts).toContain(sharedRoomName);
  expect(optionTexts).not.toContain(privateRoomName);
});

test("runtime HUD space selector navigates to another space", async ({ page, request }) => {
  const targetRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "showroom-basic",
      name: "Switch Target Room",
      guestAllowed: true
    }
  });
  expect(targetRoomResponse.ok()).toBeTruthy();
  const targetRoom = (await targetRoomResponse.json()) as { roomId: string; roomLink: string };

  await page.goto("/rooms/demo-room");
  await page.waitForTimeout(3000);
  await page.selectOption("#space-select", { value: targetRoom.roomLink });
  await page.waitForURL(`**/rooms/${targetRoom.roomId}`);
  await expect(page.locator("#room-name")).toContainText(`showroom-basic - ${targetRoom.roomId}`);
});

test("runtime keeps current room usable when space selector is unavailable", async ({ page }) => {
  await page.goto("/rooms/demo-room?failspaces=1");
  await page.waitForTimeout(3000);

  await expect(page.locator("#room-name")).toContainText("meeting-room-basic - demo-room");
  await expect(page.locator("#space-select")).toBeDisabled();
  await expect(page.locator("#space-select-status")).toContainText("Spaces unavailable");
  await expect(page.locator("#status-line")).toContainText("Joined as");
});

test("two rooms load two different scene bundles", async ({ browser, request }) => {
  const hallRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Hall Scene Room",
      sceneBundleUrl: "/assets/scenes/the-hall-v1/scene.json"
    }
  });
  expect(hallRoomResponse.ok()).toBeTruthy();
  const hallRoom = (await hallRoomResponse.json()) as { roomLink: string; roomId: string };

  const officeRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Office Scene Room",
      sceneBundleUrl: "/assets/scenes/the-office-v1/scene.json"
    }
  });
  expect(officeRoomResponse.ok()).toBeTruthy();
  const officeRoom = (await officeRoomResponse.json()) as { roomLink: string; roomId: string };

  const hallPage = await browser.newPage();
  const officePage = await browser.newPage();

  await hallPage.goto(hallRoom.roomLink);
  await officePage.goto(officeRoom.roomLink);
  await hallPage.waitForTimeout(3000);
  await officePage.waitForTimeout(3000);

  await expect(hallPage.locator("#branding-line")).toContainText("Scene: The Hall V1");
  await expect(officePage.locator("#branding-line")).toContainText("Scene: The Office V1");

  const hallDebug = await hallPage.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { sceneBundleState?: string; sceneBundleUrl?: string; localPosition?: { x: number; z: number } } }).__VRATA_DEBUG__);
  const officeDebug = await officePage.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { sceneBundleState?: string; sceneBundleUrl?: string; localPosition?: { x: number; z: number } } }).__VRATA_DEBUG__);

  expect(hallDebug?.sceneBundleState).toBe("loaded");
  expect(officeDebug?.sceneBundleState).toBe("loaded");
  expect(hallDebug?.sceneBundleUrl).toContain("/assets/scenes/the-hall-v1/scene.json");
  expect(officeDebug?.sceneBundleUrl).toContain("/assets/scenes/the-office-v1/scene.json");

  await hallPage.close();
  await officePage.close();
});

test("@private-assets two rooms load two different real SenseTower scene assets", async ({ browser, request }) => {
  const hallRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Sense Hall Room",
      sceneBundleUrl: "/assets/scenes/sense-hall2-v1/scene.json"
    }
  });
  expect(hallRoomResponse.ok()).toBeTruthy();
  const hallRoom = (await hallRoomResponse.json()) as { roomLink: string };

  const officeRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Sense Office Room",
      sceneBundleUrl: "/assets/scenes/sense-office-v1/scene.json"
    }
  });
  expect(officeRoomResponse.ok()).toBeTruthy();
  const officeRoom = (await officeRoomResponse.json()) as { roomLink: string };

  const hallPage = await browser.newPage();
  const officePage = await browser.newPage();

  await hallPage.goto(hallRoom.roomLink);
  await officePage.goto(officeRoom.roomLink);
  await hallPage.waitForTimeout(5000);
  await officePage.waitForTimeout(5000);

  await expect(hallPage.locator("#branding-line")).toContainText("Scene: SenseTower Hall");
  await expect(officePage.locator("#branding-line")).toContainText("Scene: SenseTower Office");

  const hallDebug = await hallPage.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { sceneBundleState?: string; sceneBundleUrl?: string } }).__VRATA_DEBUG__);
  const officeDebug = await officePage.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { sceneBundleState?: string; sceneBundleUrl?: string } }).__VRATA_DEBUG__);

  expect(hallDebug?.sceneBundleState).toBe("loaded");
  expect(officeDebug?.sceneBundleState).toBe("loaded");
  expect(hallDebug?.sceneBundleUrl).toContain("/assets/scenes/sense-hall2-v1/scene.json");
  expect(officeDebug?.sceneBundleUrl).toContain("/assets/scenes/sense-office-v1/scene.json");

  await hallPage.close();
  await officePage.close();
});

test("Livadia Nicholas II office scene loads with readable diagnostics", async ({ page, request }) => {
  const roomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Livadia Nicholas II Office Room",
      sceneBundleUrl: "/assets/scenes/livadia-nicholas-office-v1/scene.json"
    }
  });
  expect(roomResponse.ok()).toBeTruthy();
  const room = (await roomResponse.json()) as { roomLink: string };

  await page.goto(`${room.roomLink}?debug=1&scenefit=0`);

  const readSceneDebug = async () => {
    return page.evaluate(() => {
      const debug = (window as Window & {
        __VRATA_DEBUG__?: {
          sceneBundleState?: string;
          sceneDebug?: {
            label?: string | null;
            state?: string | null;
            failureReason?: string | null;
            spawnApplied?: boolean;
            meshCount?: number;
            triangleEstimate?: number;
            missingAssets?: string[];
            boundingBox?: { size?: { x?: number; y?: number; z?: number } } | null;
            screenshot?: {
              averageColor?: { r?: number; g?: number; b?: number; a?: number };
              darkPixelRatio?: number;
            } | null;
          };
        };
      }).__VRATA_DEBUG__;
      const scene = debug?.sceneDebug;
      const average = scene?.screenshot?.averageColor;
      const luminance = average ? ((average.r ?? 0) + (average.g ?? 0) + (average.b ?? 0)) / 3 : 0;
      return {
        sceneBundleState: debug?.sceneBundleState ?? null,
        label: scene?.label ?? null,
        state: scene?.state ?? null,
        failureReason: scene?.failureReason ?? null,
        spawnApplied: scene?.spawnApplied ?? false,
        missingAssetCount: scene?.missingAssets?.length ?? -1,
        meshCount: scene?.meshCount ?? 0,
        triangleEstimate: scene?.triangleEstimate ?? 0,
        bounds: scene?.boundingBox?.size ?? null,
        alpha: average?.a ?? 0,
        darkPixelRatio: scene?.screenshot?.darkPixelRatio ?? 1,
        averageLuminance: luminance
      };
    });
  };

  await expect.poll(readSceneDebug, {
    timeout: 20000,
    intervals: [1000, 2000, 3000]
  }).toMatchObject({
    sceneBundleState: "loaded",
    label: "Livadia Nicholas II Office",
    state: "loaded",
    failureReason: null,
    spawnApplied: true,
    missingAssetCount: 0
  });
  await expect.poll(async () => {
    const debug = await readSceneDebug();
    return {
      alphaReady: debug.alpha >= 250,
      brightnessReady: debug.averageLuminance >= 40,
      darkRatioReady: debug.darkPixelRatio <= 0.7
    };
  }, {
    timeout: 10000,
    intervals: [1000, 2000]
  }).toEqual({
    alphaReady: true,
    brightnessReady: true,
    darkRatioReady: true
  });
  const sceneDebug = await readSceneDebug();

  expect(sceneDebug.meshCount).toBeLessThanOrEqual(300);
  expect(sceneDebug.triangleEstimate).toBeLessThan(120000);
  expect(sceneDebug.bounds?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(20);
  expect(sceneDebug.bounds?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(6);
  expect(sceneDebug.bounds?.z ?? Number.POSITIVE_INFINITY).toBeLessThan(20);
  expect(sceneDebug.alpha).toBeGreaterThanOrEqual(250);
  expect(sceneDebug.darkPixelRatio).toBeLessThanOrEqual(0.7);
  expect(sceneDebug.averageLuminance).toBeGreaterThanOrEqual(40);
});

test("scene bundle diagnostics include render and geometry debug info", async ({ page, request }) => {
  const roomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Debug Scene Room",
      sceneBundleUrl: "/assets/scenes/the-office-v1/scene.json"
    }
  });
  expect(roomResponse.ok()).toBeTruthy();
  const room = (await roomResponse.json()) as { roomId: string; roomLink: string };

  await page.goto(`${room.roomLink}?debug=1`);
  await page.waitForTimeout(5000);

  const diagnosticsResponse = await request.get(`/api/rooms/${room.roomId}/diagnostics`);
  const diagnostics = (await diagnosticsResponse.json()) as {
    items: Array<{
      note?: string;
      sceneDebug?: {
        state?: string;
        meshCount?: number;
        geometryCount?: number;
        screenshot?: {
          width?: number;
          pixelSamples?: Array<unknown>;
          dataUrl?: string;
        };
      };
    }>;
  };
  const loaded = [...diagnostics.items].reverse().find((item) => item.note === "scene_bundle_loaded");
  expect(loaded?.sceneDebug?.state).toBe("loaded");
  expect(loaded?.sceneDebug?.meshCount ?? 0).toBeGreaterThan(0);
  expect(loaded?.sceneDebug?.geometryCount ?? 0).toBeGreaterThan(0);
  expect(loaded?.sceneDebug?.screenshot?.width ?? 0).toBeGreaterThan(0);
  expect(loaded?.sceneDebug?.screenshot?.pixelSamples?.length ?? 0).toBeGreaterThan(0);
  expect((loaded?.sceneDebug?.screenshot?.dataUrl ?? "")).toContain("data:image/jpeg;base64,");
});

test("@private-assets avatar-enabled hall room supports interaction ray teleport, sit, switch and teleport exit", async ({ page, request }) => {
  const room = await createAvatarHallRoom(request, "Avatar Hall Interaction Room");

  await page.goto(`${room.roomLink}?debug=1`);
  await waitForHallInteractionReady(page);

  expect(await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { claimSeatById: (seatId: string) => boolean };
  }).__VRATA_TEST__?.claimSeatById("hall-seat-a") ?? false)).toBeTruthy();

  await expect.poll(async () => {
    const debug = await readInteractionDebug(page);
    return {
      currentSeatId: debug?.currentSeatId ?? null,
      occupiedByLocal: (debug?.seatOccupancy?.["hall-seat-a"] ?? null) === debug?.participantId
    };
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    currentSeatId: "hall-seat-a",
    occupiedByLocal: true
  });

  expect(await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { claimSeatById: (seatId: string) => boolean };
  }).__VRATA_TEST__?.claimSeatById("hall-seat-b") ?? false)).toBeTruthy();

  await expect.poll(async () => {
    const debug = await readInteractionDebug(page);
    return {
      currentSeatId: debug?.currentSeatId ?? null,
      seatAOccupied: Boolean(debug?.seatOccupancy?.["hall-seat-a"]),
      seatBOccupiedByLocal: (debug?.seatOccupancy?.["hall-seat-b"] ?? null) === debug?.participantId
    };
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    currentSeatId: "hall-seat-b",
    seatAOccupied: false,
    seatBOccupiedByLocal: true
  });

  expect(await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { teleportToFloor: (x: number, z: number) => boolean };
  }).__VRATA_TEST__?.teleportToFloor(0, -4) ?? false)).toBeTruthy();

  await expect.poll(async () => {
    const debug = await readInteractionDebug(page);
    return {
      currentSeatId: debug?.currentSeatId ?? null,
      seatBOccupied: Boolean(debug?.seatOccupancy?.["hall-seat-b"]),
      localPositionZ: Number((debug?.localPosition?.z ?? 0).toFixed(1))
    };
  }, {
    timeout: 15000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    currentSeatId: null,
    seatBOccupied: false,
    localPositionZ: -4
  });
});

test.fixme("@private-assets avatar-enabled hall room restores seated state after forced room-state reconnect", async ({ browser, request }) => {
  const room = await createAvatarHallRoom(request, "Avatar Hall Reconnect Seating Room");
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  try {
    await pageA.goto(`${room.roomLink}?debug=1&roomstatedelay=100&roomstatemaxdelay=100`);
    await pageB.goto(`${room.roomLink}?debug=1&bot=line&roomstatedelay=100&roomstatemaxdelay=100`);
    await waitForHallInteractionReady(pageA);
    await waitForHallInteractionReady(pageB);

    expect(await pageA.evaluate(() => (window as Window & {
      __VRATA_TEST__?: { claimSeatById: (seatId: string) => boolean };
    }).__VRATA_TEST__?.claimSeatById("hall-seat-a") ?? false)).toBeTruthy();

    await expect.poll(async () => {
      const debugA = await readInteractionDebug(pageA);
      return {
        localSeat: debugA?.currentSeatId ?? null,
        localOccupiedBySelf: (debugA?.seatOccupancy?.["hall-seat-a"] ?? null) === debugA?.participantId
      };
    }, {
      timeout: 15000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      localSeat: "hall-seat-a",
      localOccupiedBySelf: true
    });

    await pageA.evaluate(() => {
      (window as Window & { __VRATA_TEST__?: { forceRoomStateReconnect?: () => void } }).__VRATA_TEST__?.forceRoomStateReconnect?.();
    });

    await expect.poll(async () => {
      const [debugA, debugB] = await Promise.all([readInteractionDebug(pageA), readInteractionDebug(pageB)]);
      return {
        reconnected: debugA?.roomStateConnected ?? false,
        localSeat: debugA?.currentSeatId ?? null,
        localOccupiedBySelf: (debugA?.seatOccupancy?.["hall-seat-a"] ?? null) === debugA?.participantId,
        remoteSeesSeat: Boolean(debugB?.seatOccupancy?.["hall-seat-a"]),
        remoteMatchesLocalOccupant: (debugA?.seatOccupancy?.["hall-seat-a"] ?? null) === (debugB?.seatOccupancy?.["hall-seat-a"] ?? null)
      };
    }, {
      timeout: 20000,
      intervals: [1000, 2000, 3000]
    }).toEqual({
      reconnected: true,
      localSeat: "hall-seat-a",
      localOccupiedBySelf: true,
      remoteSeesSeat: true,
      remoteMatchesLocalOccupant: true
    });
  } finally {
    await pageA.close();
    await pageB.close();
  }
});

test("room creation API is unauthorized without identity", async ({ request }) => {
  const response = await request.post("/api/rooms", {
    data: {
      tenantId: "demo-tenant",
      templateId: "showroom-basic",
      name: "Forbidden Room"
    }
  });
  expect(response.status()).toBe(401);
  const payload = await response.json();
  expect(payload.reason).toBe("missing_identity");
});

test("room creation API rejects invalid template even with admin token", async ({ request }) => {
  const response = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
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

  const roomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Avatar Remote Diagnostics Room",
      avatarConfig: {
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "desktop-standard",
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: false
      }
    }
  });
  expect(roomResponse.ok()).toBeTruthy();
  const room = (await roomResponse.json()) as { roomId: string; roomLink: string };

  await pageA.goto(`${room.roomLink}?debug=1`);
  await pageB.goto(`${room.roomLink}?bot=line&debug=1`);
  await pageA.waitForTimeout(5000);
  await pageB.waitForTimeout(5000);

  const diagnosticsResponse = await request.get(`/api/rooms/${room.roomId}/diagnostics`);
  const diagnostics = (await diagnosticsResponse.json()) as {
    items: Array<{
      participantId: string;
      remoteAvatarCount: number;
      remoteAvatarReliableCount?: number;
      remoteAvatarPoseCount?: number;
      remoteTargets: Array<{ id: string }>;
      remoteAvatarReliableStates?: Array<{ participantId: string; avatarId: string }>;
      remoteAvatarPoseFrames?: Array<{ participantId: string; seq: number }>;
      remoteAvatarParticipants?: Array<{
        participantId: string;
        presenceSeen: boolean;
        hasReliableState: boolean;
        hasPoseFrame: boolean;
        leftHandVisible: boolean;
        rightHandVisible: boolean;
      }>;
    }>;
  };

  expect(diagnostics.items.some((item) => item.remoteAvatarCount >= 1)).toBeTruthy();
  expect(diagnostics.items.some((item) => item.remoteTargets.length >= 1)).toBeTruthy();
  expect(diagnostics.items.some((item) => Array.isArray(item.remoteAvatarReliableStates))).toBeTruthy();
  expect(diagnostics.items.some((item) => Array.isArray(item.remoteAvatarPoseFrames))).toBeTruthy();

  await pageA.close();
  await pageB.close();
});

test("control plane creates a room through the browser UI", async ({ page }) => {
  await page.goto("/control-plane");
  await expect(page.locator("#template-detail")).not.toContainText("Select a template to inspect details");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Control Plane Room");
  await page.selectOption("#template-select", "showroom-basic");
  await expect(page.locator("#template-detail")).toContainText("showroom-basic");
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

test("control plane can create room with avatar config", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Avatar Config Room");
  await page.check("#avatar-enabled-input");
  await page.fill("#avatar-catalog-url-input", "/assets/avatars/catalog.v1.json");
  await page.selectOption("#avatar-quality-select", "xr");
  await page.check("#avatar-fallback-input");
  await page.check("#avatar-seats-input");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await expect(page.locator("#room-detail")).toContainText("avatarsEnabled");
  await expect(page.locator("#room-detail")).toContainText("catalog.v1.json");
  await expect(page.locator("#room-detail")).toContainText("\"avatarQualityProfile\": \"xr\"");
  const href = await page.locator("#room-link").getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(`${String(href)}?avatarsandbox=1&debug=1`);
  await page.waitForFunction(() => {
    const debug = (window as Window & {
      __VRATA_DEBUG__?: { avatarDebug?: { state?: string; presetCount?: number } };
    }).__VRATA_DEBUG__;
    return debug?.avatarDebug?.state === "loaded" && debug.avatarDebug?.presetCount === 10;
  });
});

test("control plane can update avatar config for selected room", async ({ page }) => {
  await page.goto("/control-plane");
  await page.fill("#admin-token-input", "test-admin-token");
  await page.fill("#room-name-input", "Avatar Update Room");
  await page.click("#create-room");
  await expect(page.locator("#publish-status")).toContainText("published");
  await page.check("#avatar-enabled-input");
  await page.fill("#avatar-catalog-url-input", "/assets/avatars/catalog.v1.json");
  await page.selectOption("#avatar-quality-select", "mobile-lite");
  await page.uncheck("#avatar-seats-input");
  await page.click("#update-room");
  await expect(page.locator("#publish-status")).toContainText("updated");
  await expect(page.locator("#room-detail")).toContainText("\"avatarsEnabled\": true");
  await expect(page.locator("#room-detail")).toContainText("\"avatarQualityProfile\": \"mobile-lite\"");
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
  await page.goto("/rooms/demo-room?role=host&sharemock=1&debug=1");
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>("#start-share");
    return Boolean(button && !button.disabled);
  });
  await page.click("#start-share");
  await page.waitForTimeout(2500);

  await expect(page.locator("#join-audio")).toBeEnabled();

  const debug = await page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { screenShareState: string } }).__VRATA_DEBUG__);
  expect(debug?.screenShareState).toBe("sharing");

  const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
  const diagnostics = (await diagnosticsResponse.json()) as { items: Array<{ note?: string; screenShareState?: string }> };
  expect(diagnostics.items.some((item) => item.note === "screenshare_mock_started")).toBeTruthy();

  await page.click("#stop-share");
  await page.waitForTimeout(1000);
  const debugAfter = await page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { screenShareState: string } }).__VRATA_DEBUG__);
  expect(debugAfter?.screenShareState).toBe("stopped");
});

test("fault-injected mic denied keeps room usable without audio", async ({ page, request }) => {
  await page.goto("/rooms/demo-room?failaudio=mic_denied&debug=1");
  await page.waitForTimeout(2500);
  await page.click("#join-audio");
  await page.waitForTimeout(1000);

  await expect(page.locator("#status-line")).toContainText("Microphone blocked");

  const debug = await page.evaluate(() => (window as Window & {
    __VRATA_DEBUG__?: { issueCode?: string | null; degradedMode?: string; audioState?: string; lastReportId?: string | null; lastReportRequestId?: string | null };
  }).__VRATA_DEBUG__);
  expect(debug?.issueCode).toBe("mic_denied");
  expect(debug?.degradedMode).toBe("audio_unavailable");
  expect(debug?.audioState).toBe("degraded");

  await expect(page.locator("#report-line")).toContainText(/Report ID: rpt_/);
  await expect.poll(async () => {
    const reportDebug = await page.evaluate(() => (window as Window & {
      __VRATA_DEBUG__?: { lastReportId?: string | null; lastReportRequestId?: string | null };
    }).__VRATA_DEBUG__);
    return {
      reportIdReady: typeof reportDebug?.lastReportId === "string" && reportDebug.lastReportId.startsWith("rpt_"),
      requestIdReady: typeof reportDebug?.lastReportRequestId === "string" && reportDebug.lastReportRequestId.length > 0
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    reportIdReady: true,
    requestIdReady: true
  });

  const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
  const diagnostics = (await diagnosticsResponse.json()) as { items: Array<{ note?: string; issueCode?: string; reportId?: string; requestId?: string }> };
  expect(diagnostics.items.some((item) => item.note === "mic_denied" && item.issueCode === "mic_denied" && item.reportId?.startsWith("rpt_") && item.requestId)).toBeTruthy();
});

test("fault-injected media network block explains WebRTC can fail while scene loads", async ({ page, request }) => {
  await page.goto("/rooms/demo-room?role=host&failaudio=connection_failed&debug=1");
  await page.waitForTimeout(2500);
  await page.click("#start-share");

  await expect(page.locator("#status-line")).toContainText("Media connection blocked");

  const debug = await page.evaluate(() => (window as Window & {
    __VRATA_DEBUG__?: { issueCode?: string | null; degradedMode?: string; screenShareState?: string; statusLine?: string };
  }).__VRATA_DEBUG__);
  expect(debug?.issueCode).toBe("media_network_blocked");
  expect(debug?.degradedMode).toBe("media_transport_unavailable");
  expect(debug?.screenShareState).toBe("media_network_blocked");
  expect(debug?.statusLine).toContain("scene can load");

  const diagnosticsResponse = await request.get("/api/rooms/demo-room/diagnostics");
  const diagnostics = (await diagnosticsResponse.json()) as { items: Array<{ note?: string; issueCode?: string }> };
  expect(diagnostics.items.some((item) => item.note === "media_network_blocked" && item.issueCode === "media_network_blocked")).toBeTruthy();
});

test("fault-injected room-state failure falls back to API mode", async ({ page, request }) => {
  await page.goto("/rooms/demo-room?failroomstate=1&debug=1");
  await page.waitForTimeout(3000);

  await expect(page.locator("#room-state-line")).toContainText("fallback API");

  const debug = await page.evaluate(() => (window as Window & {
    __VRATA_DEBUG__?: { issueCode?: string | null; roomStateMode?: string; degradedMode?: string };
  }).__VRATA_DEBUG__);
  expect(debug?.issueCode).toBe("room_state_failed");
  expect(debug?.roomStateMode).toBe("api_fallback");
  expect(debug?.degradedMode).toBe("api_fallback");

  const presenceResponse = await request.get("/api/rooms/demo-room/presence");
  const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
  expect(presence.items.length).toBeGreaterThan(0);
});
