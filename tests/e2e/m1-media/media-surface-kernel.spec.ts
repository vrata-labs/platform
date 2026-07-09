import { expect, test, type Page } from "@playwright/test";

type MediaKernelDebug = {
  roomStateConnected?: boolean;
  access?: { role?: string };
  mediaObjects?: {
    surfaces?: Array<{
      surfaceId?: string;
      activeObjectId?: string | null;
      activeObjectType?: string | null;
    }>;
    objects?: Array<{
      objectId?: string;
      type?: string;
      surfaceId?: string;
      revision?: number;
      state?: { clickCount?: number; lastInputEventId?: string | null };
    }>;
    blockedReason?: string | null;
    activeTestCardClickCount?: number | null;
  };
};

function roomUrl(roomId: string, role: "guest" | "member" | "host") {
  const query = role === "guest" ? "debug=1" : `debug=1&role=${role}`;
  return `/rooms/${roomId}?${query}`;
}

async function readDebug(page: Page): Promise<MediaKernelDebug | undefined> {
  return page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: MediaKernelDebug }).__VRATA_DEBUG__);
}

async function waitForKernel(page: Page, role: "guest" | "member" | "host") {
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

async function createTestCard(page: Page) {
  const sent = await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { createSurfaceTestCard: () => boolean };
  }).__VRATA_TEST__?.createSurfaceTestCard() ?? false);
  expect(sent).toBe(true);
}

test("M1.3 guest sees default surface but cannot create object", async ({ page }) => {
  const roomId = `m1-kernel-guest-${Date.now()}`;
  await page.goto(roomUrl(roomId, "guest"));
  await waitForKernel(page, "guest");

  await createTestCard(page);

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

test("M1.3 host creates test card and member input syncs counter", async ({ browser }) => {
  const roomId = `m1-kernel-sync-${Date.now()}`;
  const host = await browser.newPage();
  const member = await browser.newPage();
  const guest = await browser.newPage();
  try {
    await host.goto(roomUrl(roomId, "host"));
    await member.goto(roomUrl(roomId, "member"));
    await guest.goto(roomUrl(roomId, "guest"));
    await waitForKernel(host, "host");
    await waitForKernel(member, "member");
    await waitForKernel(guest, "guest");

    await createTestCard(host);

    await expect.poll(async () => {
      const hostDebug = await readDebug(host);
      const memberDebug = await readDebug(member);
      const guestDebug = await readDebug(guest);
      return {
        hostType: hostDebug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === "debug-main")?.activeObjectType ?? null,
        memberType: memberDebug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === "debug-main")?.activeObjectType ?? null,
        guestType: guestDebug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === "debug-main")?.activeObjectType ?? null
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      hostType: "surface-test-card",
      memberType: "surface-test-card",
      guestType: "surface-test-card"
    });

    const sentInput = await member.evaluate(() => (window as Window & {
      __VRATA_TEST__?: { sendDebugSurfaceInput: (input?: { kind?: string; u?: number; v?: number }) => boolean };
    }).__VRATA_TEST__?.sendDebugSurfaceInput({ kind: "click", u: 0.5, v: 0.5 }) ?? false);
    expect(sentInput).toBe(true);

    await expect.poll(async () => {
      const hostDebug = await readDebug(host);
      const guestDebug = await readDebug(guest);
      return {
        hostCount: hostDebug?.mediaObjects?.activeTestCardClickCount ?? null,
        guestCount: guestDebug?.mediaObjects?.activeTestCardClickCount ?? null
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      hostCount: 1,
      guestCount: 1
    });

    const stopped = await host.evaluate(() => (window as Window & {
      __VRATA_TEST__?: { stopActiveSurfaceObject: () => boolean };
    }).__VRATA_TEST__?.stopActiveSurfaceObject() ?? false);
    expect(stopped).toBe(true);

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
    await guest.close();
  }
});

test("M1.3 rejects unknown type, occupied surface, and stale patch", async ({ page }) => {
  const roomId = `m1-kernel-negative-${Date.now()}`;
  await page.goto(roomUrl(roomId, "host"));
  await waitForKernel(page, "host");

  const unknownSent = await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { createUnknownSurfaceObject: () => boolean };
  }).__VRATA_TEST__?.createUnknownSurfaceObject() ?? false);
  expect(unknownSent).toBe(true);
  await expect.poll(async () => (await readDebug(page))?.mediaObjects?.blockedReason ?? null, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("unknown-object-type");

  await createTestCard(page);
  await expect.poll(async () => (await readDebug(page))?.mediaObjects?.activeTestCardClickCount ?? null, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe(0);

  await createTestCard(page);
  await expect.poll(async () => (await readDebug(page))?.mediaObjects?.blockedReason ?? null, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("surface-occupied");

  const staleSent = await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { sendStaleSurfaceTestCardPatch: () => boolean };
  }).__VRATA_TEST__?.sendStaleSurfaceTestCardPatch() ?? false);
  expect(staleSent).toBe(true);
  await expect.poll(async () => (await readDebug(page))?.mediaObjects?.blockedReason ?? null, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("revision-mismatch");
});
