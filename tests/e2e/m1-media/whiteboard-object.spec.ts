import { expect, test, type Page } from "@playwright/test";

type WhiteboardDebug = {
  roomStateConnected?: boolean;
  access?: { role?: string };
  whiteboard?: {
    active?: boolean;
    strokeCount?: number;
    revision?: number;
    localCanDraw?: boolean;
    localCanClear?: boolean;
    lastInputSource?: string | null;
    lastPoint?: { u?: number; v?: number } | null;
  };
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
      state?: { strokes?: Array<{ points?: Array<{ u?: number; v?: number }> }> };
    }>;
    blockedReason?: string | null;
  };
};

function roomUrl(roomId: string, role: "guest" | "member" | "host") {
  const params = new URLSearchParams("debug=1");
  if (role !== "guest") {
    params.set("role", role);
  }
  return `/rooms/${roomId}?${params.toString()}`;
}

async function readDebug(page: Page): Promise<WhiteboardDebug | undefined> {
  return page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: WhiteboardDebug }).__NOAH_DEBUG__);
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

async function createWhiteboard(page: Page) {
  const sent = await page.evaluate(() => (window as Window & {
    __NOAH_TEST__?: { createWhiteboardObject: () => boolean };
  }).__NOAH_TEST__?.createWhiteboardObject() ?? false);
  expect(sent).toBe(true);
}

async function trySendSurfaceInput(page: Page, input: { kind: string; source?: string; u?: number; v?: number }) {
  return page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: { sendDebugSurfaceInput: (input?: { kind?: string; source?: string; u?: number; v?: number }) => boolean };
  }).__NOAH_TEST__?.sendDebugSurfaceInput(value) ?? false, input);
}

async function sendSurfaceInput(page: Page, input: { kind: string; source?: string; u?: number; v?: number }) {
  const sent = await trySendSurfaceInput(page, input);
  expect(sent).toBe(true);
}

async function waitForWhiteboard(page: Page, strokeCount: number) {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    const surface = debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main");
    return {
      activeObjectType: surface?.activeObjectType ?? null,
      active: debug?.whiteboard?.active ?? false,
      strokeCount: debug?.whiteboard?.strokeCount ?? null
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    activeObjectType: "whiteboard",
    active: true,
    strokeCount
  });
}

test("M1.5 host creates whiteboard and member stroke syncs to viewers", async ({ browser }) => {
  const roomId = `m1-whiteboard-sync-${Date.now()}`;
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

    await expect(host.locator("#start-whiteboard")).toBeVisible();
    await expect(host.locator("#start-whiteboard")).toBeEnabled();
    await expect(host.locator("#draw-whiteboard")).toBeDisabled();
    await host.click("#start-whiteboard");
    await waitForWhiteboard(guest, 0);
    await expect(host.locator("#draw-whiteboard")).toBeEnabled();
    await expect(host.locator("#draw-whiteboard")).toHaveAttribute("aria-pressed", "false");
    await host.click("#draw-whiteboard");
    await expect(host.locator("#draw-whiteboard")).toHaveAttribute("aria-pressed", "true");

    await sendSurfaceInput(member, { kind: "pointer-down", u: 0.2, v: 0.2 });
    await sendSurfaceInput(member, { kind: "pointer-move", u: 0.3, v: 0.3 });
    await sendSurfaceInput(member, { kind: "pointer-up", u: 0.4, v: 0.4 });

    await waitForWhiteboard(host, 1);
    await waitForWhiteboard(guest, 1);

    await expect.poll(async () => {
      const debug = await readDebug(host);
      const board = debug?.mediaObjects?.objects?.find((item) => item.type === "whiteboard");
      const points = board?.state?.strokes?.[0]?.points ?? [];
      return points.every((point) => typeof point.u === "number" && point.u >= 0 && point.u <= 1 && typeof point.v === "number" && point.v >= 0 && point.v <= 1);
    }).toBe(true);
  } finally {
    await host.close();
    await member.close();
    await guest.close();
  }
});

test("M1.5 guest cannot draw and host clear syncs", async ({ browser }) => {
  const roomId = `m1-whiteboard-permissions-${Date.now()}`;
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
    await createWhiteboard(host);
    await waitForWhiteboard(member, 0);

    await sendSurfaceInput(member, { kind: "click", u: 0.5, v: 0.5 });
    await waitForWhiteboard(host, 1);

    const guestInputSent = await trySendSurfaceInput(guest, { kind: "click", u: 0.6, v: 0.6 });
    expect(guestInputSent).toBe(false);
    await expect.poll(async () => (await readDebug(guest))?.whiteboard?.strokeCount ?? null, {
      timeout: 5000,
      intervals: [500, 1000]
    }).toBe(1);

    const memberClearSent = await member.evaluate(() => (window as Window & {
      __NOAH_TEST__?: { clearWhiteboardObject: () => boolean };
    }).__NOAH_TEST__?.clearWhiteboardObject() ?? false);
    expect(memberClearSent).toBe(true);
    await expect.poll(async () => (await readDebug(member))?.mediaObjects?.blockedReason ?? null, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toBe("missing-permission");

    await expect(host.locator("#clear-whiteboard")).toBeEnabled();
    await host.click("#clear-whiteboard");
    await waitForWhiteboard(member, 0);
    await waitForWhiteboard(guest, 0);
  } finally {
    await host.close();
    await member.close();
    await guest.close();
  }
});

test("M1.5 XR surface input creates whiteboard stroke", async ({ page }) => {
  const roomId = `m1-whiteboard-xr-${Date.now()}`;
  await page.goto(roomUrl(roomId, "host"));
  await waitForKernel(page, "host");
  await createWhiteboard(page);
  await waitForWhiteboard(page, 0);

  await sendSurfaceInput(page, { kind: "pointer-down", source: "xr-controller", u: 0.25, v: 0.75 });
  await sendSurfaceInput(page, { kind: "pointer-move", source: "xr-controller", u: 0.3, v: 0.7 });
  await sendSurfaceInput(page, { kind: "pointer-up", source: "xr-controller", u: 0.35, v: 0.65 });

  await waitForWhiteboard(page, 1);
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      source: debug?.whiteboard?.lastInputSource ?? null,
      u: debug?.whiteboard?.lastPoint?.u ?? null,
      v: debug?.whiteboard?.lastPoint?.v ?? null
    };
  }).toEqual({ source: "xr-controller", u: 0.35, v: 0.35 });
});

test("M1.5 rejoin restores whiteboard state", async ({ browser }) => {
  const roomId = `m1-whiteboard-rejoin-${Date.now()}`;
  const host = await browser.newPage();
  let member = await browser.newPage();
  try {
    await host.goto(roomUrl(roomId, "host"));
    await member.goto(roomUrl(roomId, "member"));
    await waitForKernel(host, "host");
    await waitForKernel(member, "member");
    await createWhiteboard(host);
    await waitForWhiteboard(member, 0);
    await sendSurfaceInput(member, { kind: "click", u: 0.4, v: 0.4 });
    await waitForWhiteboard(host, 1);

    await member.close();
    member = await browser.newPage();
    await member.goto(roomUrl(roomId, "member"));
    await waitForKernel(member, "member");
    await waitForWhiteboard(member, 1);
  } finally {
    await host.close();
    await member.close();
  }
});

test("M1.5 rejects stale and duplicate whiteboard patches", async ({ page }) => {
  const roomId = `m1-whiteboard-negative-${Date.now()}`;
  await page.goto(roomUrl(roomId, "host"));
  await waitForKernel(page, "host");
  await createWhiteboard(page);
  await waitForWhiteboard(page, 0);
  await sendSurfaceInput(page, { kind: "click", u: 0.2, v: 0.2 });
  await waitForWhiteboard(page, 1);

  const staleSent = await page.evaluate(() => (window as Window & {
    __NOAH_TEST__?: { sendStaleWhiteboardPatch: () => boolean };
  }).__NOAH_TEST__?.sendStaleWhiteboardPatch() ?? false);
  expect(staleSent).toBe(true);
  await expect.poll(async () => (await readDebug(page))?.mediaObjects?.blockedReason ?? null, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("revision-mismatch");

  const duplicateSent = await page.evaluate(() => (window as Window & {
    __NOAH_TEST__?: { sendDuplicateWhiteboardPatch: () => boolean };
  }).__NOAH_TEST__?.sendDuplicateWhiteboardPatch() ?? false);
  expect(duplicateSent).toBe(true);
  await expect.poll(async () => (await readDebug(page))?.mediaObjects?.blockedReason ?? null, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("duplicate-input-event");
});
