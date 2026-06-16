import { expect, test, type Page } from "@playwright/test";

type ScreenShareDebug = {
  roomStateConnected?: boolean;
  screenShareState?: string;
  access?: { role?: string };
  screenShare?: {
    active?: boolean;
    localPublishing?: boolean;
    selectedSurfaceId?: string | null;
    publishedTrackSid?: string | null;
    remoteSubscribedTrackCount?: number;
    mediaAudioEnabled?: boolean;
    errorCode?: string | null;
  };
  surfaceAudio?: {
    mediaAudioEnabled?: boolean;
    canConfigure?: boolean;
  };
  mediaObjects?: {
    surfaces?: Array<{
      surfaceId?: string;
      activeObjectId?: string | null;
      activeObjectType?: string | null;
      mediaAudioEnabled?: boolean;
    }>;
    objects?: Array<{
      objectId?: string;
      type?: string;
      surfaceId?: string;
      revision?: number;
      state?: { status?: string; mediaTrackSid?: string; ownerParticipantId?: string; surfaceId?: string };
    }>;
    blockedReason?: string | null;
  };
};

function roomUrl(roomId: string, role: "guest" | "member" | "host" | "admin", extra = "") {
  const params = new URLSearchParams("debug=1");
  if (role !== "guest") {
    params.set("role", role);
  }
  if (extra) {
    for (const [key, value] of new URLSearchParams(extra)) {
      params.set(key, value);
    }
  }
  return `/rooms/${roomId}?${params.toString()}`;
}

async function readDebug(page: Page): Promise<ScreenShareDebug | undefined> {
  return page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: ScreenShareDebug }).__VRATA_DEBUG__);
}

async function waitForKernel(page: Page, role: "guest" | "member" | "host" | "admin") {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null,
      hasSurface: debug?.mediaObjects?.surfaces?.some((surface) => surface.surfaceId === "debug-main") ?? false
    };
  }, {
    timeout: 15000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    connected: true,
    role,
    hasSurface: true
  });
}

async function createScreenShareObject(page: Page) {
  const sent = await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { createScreenShareObject: () => boolean };
  }).__VRATA_TEST__?.createScreenShareObject() ?? false);
  expect(sent).toBe(true);
}

async function stopActiveSurfaceObject(page: Page) {
  const sent = await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { stopActiveSurfaceObject: () => boolean };
  }).__VRATA_TEST__?.stopActiveSurfaceObject() ?? false);
  expect(sent).toBe(true);
}

test("M1.4 guest cannot create screen-share object", async ({ page }) => {
  const roomId = `m1-screen-share-guest-${Date.now()}`;
  await page.goto(roomUrl(roomId, "guest", "sharemock=1"));
  await waitForKernel(page, "guest");

  await createScreenShareObject(page);

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      blockedReason: debug?.mediaObjects?.blockedReason ?? null,
      objectCount: debug?.mediaObjects?.objects?.length ?? 0
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    blockedReason: "missing-permission",
    objectCount: 0
  });
});

test("M1.4 host mock screen share becomes active media object and syncs to member", async ({ browser }) => {
  const roomId = `m1-screen-share-sync-${Date.now()}`;
  const host = await browser.newPage();
  const member = await browser.newPage();
  try {
    await host.goto(roomUrl(roomId, "host", "sharemock=1"));
    await member.goto(roomUrl(roomId, "member"));
    await waitForKernel(host, "host");
    await waitForKernel(member, "member");

    await expect(host.locator("#start-share")).toBeEnabled({ timeout: 10000 });
    await host.click("#start-share");

    await expect.poll(async () => {
      const debug = await readDebug(host);
      const surface = debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main");
      return {
        activeObjectType: surface?.activeObjectType ?? null,
        screenShareActive: debug?.screenShare?.active ?? false,
        localPublishing: debug?.screenShare?.localPublishing ?? false,
        hasMockTrackSid: debug?.screenShare?.publishedTrackSid?.startsWith("mock-screen-share:") ?? false
      };
    }, {
      timeout: 15000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      activeObjectType: "screen-share",
      screenShareActive: true,
      localPublishing: true,
      hasMockTrackSid: true
    });

    await expect.poll(async () => {
      const debug = await readDebug(member);
      const surface = debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main");
      return {
        activeObjectType: surface?.activeObjectType ?? null,
        screenShareActive: debug?.screenShare?.active ?? false,
        remoteSubscribedTrackCount: debug?.screenShare?.remoteSubscribedTrackCount ?? 0
      };
    }, {
      timeout: 15000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      activeObjectType: "screen-share",
      screenShareActive: true,
      remoteSubscribedTrackCount: 1
    });

    await host.click("#stop-share");

    await expect.poll(async () => {
      const debug = await readDebug(member);
      const surface = debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main");
      return surface ? surface.activeObjectId ?? null : "missing";
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toBe(null);
  } finally {
    await host.close();
    await member.close();
  }
});

test("M1.4 admin controls per-surface media audio policy", async ({ browser }) => {
  const roomId = `m1-screen-share-audio-${Date.now()}`;
  const admin = await browser.newPage();
  const host = await browser.newPage();
  try {
    await admin.goto(roomUrl(roomId, "admin", "sharemock=1"));
    await host.goto(roomUrl(roomId, "host"));
    await waitForKernel(admin, "admin");
    await waitForKernel(host, "host");

    await expect(admin.locator("#surface-audio-control")).toBeVisible();
    await expect(admin.locator("#surface-audio-enabled")).not.toBeChecked();
    await admin.locator("#surface-audio-enabled").check();

    await expect.poll(async () => {
      const debug = await readDebug(admin);
      const surface = debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main");
      return {
        mediaAudioEnabled: surface?.mediaAudioEnabled ?? false,
        canConfigure: debug?.surfaceAudio?.canConfigure ?? false
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      mediaAudioEnabled: true,
      canConfigure: true
    });

    await expect.poll(async () => {
      const debug = await readDebug(host);
      return debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main")?.mediaAudioEnabled ?? false;
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toBe(true);

    await expect(host.locator("#surface-audio-control")).toBeHidden();
    const hostSent = await host.evaluate(() => (window as Window & {
      __VRATA_TEST__?: { setDebugSurfaceMediaAudioEnabled: (enabled: boolean) => boolean };
    }).__VRATA_TEST__?.setDebugSurfaceMediaAudioEnabled(false) ?? false);
    expect(hostSent).toBe(true);
    await expect.poll(async () => (await readDebug(host))?.mediaObjects?.blockedReason ?? null, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toBe("missing-permission");

    await admin.click("#start-share");
    await expect.poll(async () => {
      const debug = await readDebug(admin);
      return {
        screenShareActive: debug?.screenShare?.active ?? false,
        screenShareAudioEnabled: debug?.screenShare?.mediaAudioEnabled ?? false
      };
    }, {
      timeout: 15000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      screenShareActive: true,
      screenShareAudioEnabled: true
    });
  } finally {
    await admin.close();
    await host.close();
  }
});

test("M1.4 rejects occupied surface and stale screen-share patch", async ({ page }) => {
  const roomId = `m1-screen-share-negative-${Date.now()}`;
  await page.goto(roomUrl(roomId, "host", "sharemock=1"));
  await waitForKernel(page, "host");

  const cardSent = await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { createSurfaceTestCard: () => boolean };
  }).__VRATA_TEST__?.createSurfaceTestCard() ?? false);
  expect(cardSent).toBe(true);
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main")?.activeObjectType ?? null;
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("surface-test-card");

  await createScreenShareObject(page);
  await expect.poll(async () => (await readDebug(page))?.mediaObjects?.blockedReason ?? null, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("surface-occupied");

  await stopActiveSurfaceObject(page);
  await expect.poll(async () => {
    const debug = await readDebug(page);
    const surface = debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main");
    return surface ? surface.activeObjectId ?? null : "missing";
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe(null);

  await createScreenShareObject(page);
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main")?.activeObjectType ?? null;
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("screen-share");

  const staleSent = await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { sendStaleScreenSharePatch: () => boolean };
  }).__VRATA_TEST__?.sendStaleScreenSharePatch() ?? false);
  expect(staleSent).toBe(true);
  await expect.poll(async () => (await readDebug(page))?.mediaObjects?.blockedReason ?? null, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("revision-mismatch");
});
