import { expect, test, type Page } from "@playwright/test";

type SurfaceDebug = {
  roomStateConnected?: boolean;
  access?: { role?: string; permissions?: string[] };
  surfaceInput?: {
    enabled?: boolean;
    debugSurfaceId?: string;
    focusedSurfaceId?: string | null;
    lastHit?: null | {
      surfaceId?: string;
      source?: string;
      uv?: { u?: number; v?: number };
      pixel?: { x?: number; y?: number };
    };
    lastEvent?: null | {
      surfaceId?: string;
      source?: string;
      kind?: string;
      uv?: { u?: number; v?: number };
      pixel?: { x?: number; y?: number };
      seq?: number;
      participantId?: string;
      clientTimeMs?: number;
    };
    blockedReason?: string | null;
    acceptedEventCount?: number;
  };
};

async function readDebug(page: Page): Promise<SurfaceDebug | undefined> {
  return page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: SurfaceDebug }).__NOAH_DEBUG__);
}

async function waitForAccess(page: Page, role: "guest" | "member" | "host") {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null,
      surfaceId: debug?.surfaceInput?.debugSurfaceId ?? null
    };
  }, {
    timeout: 15000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    connected: true,
    role,
    surfaceId: "debug-main"
  });
}

async function clickViewportCenter(page: Page) {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.click(Math.round(viewport.width / 2), Math.round(viewport.height / 2));
}

test("M1.2 guest can hit debug surface but cannot create input event", async ({ page }) => {
  await page.goto("/rooms/demo-room?debug=1");
  await waitForAccess(page, "guest");

  await clickViewportCenter(page);

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      hitSurfaceId: debug?.surfaceInput?.lastHit?.surfaceId ?? null,
      blockedReason: debug?.surfaceInput?.blockedReason ?? null,
      acceptedEventCount: debug?.surfaceInput?.acceptedEventCount ?? 0
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    hitSurfaceId: "debug-main",
    blockedReason: "missing-permission:surface.input",
    acceptedEventCount: 0
  });

  const debug = await readDebug(page);
  expect(debug?.surfaceInput?.lastHit?.uv?.u).toBeGreaterThan(0.45);
  expect(debug?.surfaceInput?.lastHit?.uv?.u).toBeLessThan(0.55);
  expect(debug?.surfaceInput?.lastHit?.uv?.v).toBeGreaterThanOrEqual(0);
  expect(debug?.surfaceInput?.lastHit?.uv?.v).toBeLessThanOrEqual(1);
});

test("M1.2 member mouse click creates normalized surface input event", async ({ page }) => {
  await page.goto("/rooms/demo-room?role=member&debug=1");
  await waitForAccess(page, "member");

  await clickViewportCenter(page);

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      source: debug?.surfaceInput?.lastEvent?.source ?? null,
      kind: debug?.surfaceInput?.lastEvent?.kind ?? null,
      surfaceId: debug?.surfaceInput?.lastEvent?.surfaceId ?? null,
      blockedReason: debug?.surfaceInput?.blockedReason ?? null
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    source: "mouse",
    kind: "click",
    surfaceId: "debug-main",
    blockedReason: null
  });

  const debug = await readDebug(page);
  expect(debug?.surfaceInput?.lastEvent?.participantId).toBeTruthy();
  expect(debug?.surfaceInput?.lastEvent?.seq).toBeGreaterThan(0);
  expect(debug?.surfaceInput?.lastEvent?.clientTimeMs).toBeGreaterThan(0);
  expect(debug?.surfaceInput?.lastEvent?.uv?.u).toBeGreaterThan(0.45);
  expect(debug?.surfaceInput?.lastEvent?.uv?.u).toBeLessThan(0.55);
  expect(debug?.surfaceInput?.lastEvent?.pixel?.x).toBeGreaterThan(900);
  expect(debug?.surfaceInput?.lastEvent?.pixel?.x).toBeLessThan(1020);
});

test("M1.2 synthetic XR input uses the same surface input protocol", async ({ page }) => {
  await page.goto("/rooms/demo-room?role=member&debug=1&avatarvrmock=1");
  await waitForAccess(page, "member");

  const sent = await page.evaluate(() => (window as Window & {
    __NOAH_TEST__?: {
      sendDebugSurfaceInput: (input?: { source?: string; kind?: string; u?: number; v?: number }) => boolean;
    };
  }).__NOAH_TEST__?.sendDebugSurfaceInput({ source: "xr-controller", kind: "pointer-down", u: 0.5, v: 0.5 }) ?? false);
  expect(sent).toBe(true);

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      source: debug?.surfaceInput?.lastEvent?.source ?? null,
      kind: debug?.surfaceInput?.lastEvent?.kind ?? null,
      surfaceId: debug?.surfaceInput?.lastEvent?.surfaceId ?? null
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    source: "xr-controller",
    kind: "pointer-down",
    surfaceId: "debug-main"
  });
});

test("M1.2 disabled debug surface rejects input", async ({ page }) => {
  await page.goto("/rooms/demo-room?role=member&debug=1");
  await waitForAccess(page, "member");

  const sent = await page.evaluate(() => {
    const api = (window as Window & {
      __NOAH_TEST__?: {
        setDebugSurfaceInputEnabled: (enabled: boolean) => boolean;
        sendDebugSurfaceInput: () => boolean;
      };
    }).__NOAH_TEST__;
    api?.setDebugSurfaceInputEnabled(false);
    return api?.sendDebugSurfaceInput() ?? false;
  });
  expect(sent).toBe(false);

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return debug?.surfaceInput?.blockedReason ?? null;
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("surface-disabled");
});
