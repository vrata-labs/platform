import { expect, test, type Page } from "@playwright/test";

type RemoteBrowserDebug = {
  roomStateConnected?: boolean;
  access?: { role?: string; canCreateRemoteBrowser?: boolean };
  remoteBrowser?: {
    active?: boolean;
    status?: string;
    currentUrl?: string | null;
    frameConnected?: boolean;
    lastFrameAtMs?: number;
    lastInputSeq?: number;
    localCanOpen?: boolean;
    localCanInput?: boolean;
    xrKeyboardVisible?: boolean;
    xrKeyboardHoveredKey?: string | null;
    xrKeyboardLastKey?: string | null;
    errorCode?: string | null;
  };
  mediaObjects?: {
    surfaces?: Array<{
      surfaceId?: string;
      activeObjectId?: string | null;
      activeObjectType?: string | null;
    }>;
    blockedReason?: string | null;
  };
};

async function readDebug(page: Page): Promise<RemoteBrowserDebug | undefined> {
  return page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: RemoteBrowserDebug }).__NOAH_DEBUG__);
}

async function waitForKernel(page: Page) {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null,
      canCreateRemoteBrowser: debug?.access?.canCreateRemoteBrowser ?? false,
      hasSurface: debug?.mediaObjects?.surfaces?.some((surface) => surface.surfaceId === "debug-main") ?? false
    };
  }, {
    timeout: 15000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    connected: true,
    role: "host",
    canCreateRemoteBrowser: true,
    hasSurface: true
  });
}

async function sendSurfaceInput(page: Page, input: { kind: string; u?: number; v?: number }) {
  const sent = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: { sendDebugSurfaceInput: (input?: { kind?: string; u?: number; v?: number }) => boolean };
  }).__NOAH_TEST__?.sendDebugSurfaceInput(value) ?? false, input);
  expect(sent).toBe(true);
}

async function setSyntheticXrState(page: Page, input: {
  rightController: { x: number; y: number; z: number };
  rayDirection: { x: number; y: number; z: number };
  triggerPressed: boolean;
  rayVisible?: boolean;
}) {
  const sent = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: {
      setSyntheticXrState: (state: {
        rightController: { x: number; y: number; z: number };
        rayDirection: { x: number; y: number; z: number };
        triggerPressed?: boolean;
        rayVisible?: boolean;
      } | null) => boolean;
    };
  }).__NOAH_TEST__?.setSyntheticXrState(value) ?? false, input);
  expect(sent).toBe(true);
}

async function getKeyboardKeyWorldPosition(page: Page, keyId: string): Promise<{ x: number; y: number; z: number }> {
  const position = await page.evaluate((id) => (window as Window & {
    __NOAH_TEST__?: { getRemoteBrowserVrKeyboardKeyWorldPosition: (keyId: string) => { x: number; y: number; z: number } | null };
  }).__NOAH_TEST__?.getRemoteBrowserVrKeyboardKeyWorldPosition(id) ?? null, keyId);
  expect(position).not.toBeNull();
  return position!;
}

function directionTo(origin: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }) {
  const x = target.x - origin.x;
  const y = target.y - origin.y;
  const z = target.z - origin.z;
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

test("M1.7 host opens remote browser and routes input through room-state", async ({ page }) => {
  test.setTimeout(60000);
  const roomId = `m1-remote-browser-${Date.now()}`;
  await page.goto(`/rooms/${roomId}?role=host&debug=1`);
  await waitForKernel(page);

  await expect(page.locator("#remote-browser-control")).toBeVisible();
  await expect(page.locator("#open-remote-browser")).toBeEnabled();
  await page.fill("#remote-browser-url", "/remote-browser-demo.html");
  await page.click("#open-remote-browser");

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      activeObjectType: debug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === "debug-main")?.activeObjectType ?? null,
      active: debug?.remoteBrowser?.active ?? false,
      status: debug?.remoteBrowser?.status ?? null,
      frameConnected: debug?.remoteBrowser?.frameConnected ?? false,
      hasFrame: (debug?.remoteBrowser?.lastFrameAtMs ?? 0) > 0,
      errorCode: debug?.remoteBrowser?.errorCode ?? null
    };
  }, {
    timeout: 30000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    activeObjectType: "remote-browser",
    active: true,
    status: "active",
    frameConnected: true,
    hasFrame: true,
    errorCode: null
  });

  await sendSurfaceInput(page, { kind: "click", u: 0.17, v: 0.2 });
  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0, {
    timeout: 10000,
    intervals: [500, 1000]
  }).toBeGreaterThan(0);

  await expect(page.locator("#stop-remote-browser")).toBeEnabled();
  await page.click("#stop-remote-browser");
  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.active ?? true, {
    timeout: 10000,
    intervals: [500, 1000]
  }).toBe(false);
});

test("M1.7 VR keyboard sends remote browser key input", async ({ page }) => {
  test.setTimeout(60000);
  const roomId = `m1-remote-browser-vr-keyboard-${Date.now()}`;
  await page.goto(`/rooms/${roomId}?role=host&debug=1&avatarvrmock=1`);
  await waitForKernel(page);

  await expect(page.locator("#open-remote-browser")).toBeEnabled();
  await page.fill("#remote-browser-url", "/remote-browser-demo.html");
  await page.click("#open-remote-browser");

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      active: debug?.remoteBrowser?.active ?? false,
      status: debug?.remoteBrowser?.status ?? null,
      frameConnected: debug?.remoteBrowser?.frameConnected ?? false,
      hasFrame: (debug?.remoteBrowser?.lastFrameAtMs ?? 0) > 0
    };
  }, {
    timeout: 30000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    active: true,
    status: "active",
    frameConnected: true,
    hasFrame: true
  });

  const origin = { x: 0, y: 2.2, z: 0 };
  const target = await getKeyboardKeyWorldPosition(page, "key-h");
  const rayDirection = directionTo(origin, target);
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection,
    triggerPressed: false,
    rayVisible: true
  });

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      visible: debug?.remoteBrowser?.xrKeyboardVisible ?? false,
      hovered: debug?.remoteBrowser?.xrKeyboardHoveredKey ?? null
    };
  }, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toEqual({ visible: true, hovered: "key-h" });

  const previousSeq = (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0;
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection,
    triggerPressed: true,
    rayVisible: true
  });

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      lastKey: debug?.remoteBrowser?.xrKeyboardLastKey ?? null,
      advanced: (debug?.remoteBrowser?.lastInputSeq ?? 0) > previousSeq
    };
  }, {
    timeout: 10000,
    intervals: [250, 500, 1000]
  }).toEqual({ lastKey: "key-h", advanced: true });
});
