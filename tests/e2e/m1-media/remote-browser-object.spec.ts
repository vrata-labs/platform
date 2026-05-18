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
    mediaState?: string;
    mediaConnected?: boolean;
    mediaHasVideo?: boolean;
    mediaHasAudio?: boolean;
    mediaPeerConnectionState?: string | null;
    mediaErrorCode?: string | null;
    mediaSourceRect?: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number } | null;
    localCanOpen?: boolean;
    localCanInput?: boolean;
    xrKeyboardToggleVisible?: boolean;
    xrKeyboardVisible?: boolean;
    xrKeyboardOpen?: boolean;
    xrKeyboardLayout?: string | null;
    xrKeyboardHoveredKey?: string | null;
    xrKeyboardHoveredTarget?: string | null;
    xrKeyboardPressedTarget?: string | null;
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
  surfaceInput?: {
    lastEvent?: {
      kind?: string;
      scrollDelta?: { x: number; y: number };
    } | null;
  };
  interactionRay?: { targetKind?: string | null };
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

async function sendSurfaceInput(page: Page, input: { kind: string; u?: number; v?: number; scrollDelta?: { x: number; y: number } }) {
  const sent = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: { sendDebugSurfaceInput: (input?: { kind?: string; u?: number; v?: number; scrollDelta?: { x: number; y: number } }) => boolean };
  }).__NOAH_TEST__?.sendDebugSurfaceInput(value) ?? false, input);
  expect(sent).toBe(true);
}

async function setSyntheticXrState(page: Page, input: {
  rightController: { x: number; y: number; z: number };
  rayDirection: { x: number; y: number; z: number };
  triggerPressed: boolean;
  axes?: { moveX?: number; moveY?: number; turnX?: number; turnY?: number };
  rayVisible?: boolean;
}) {
  const sent = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: {
      setSyntheticXrState: (state: {
        rightController: { x: number; y: number; z: number };
        rayDirection: { x: number; y: number; z: number };
        axes?: { moveX?: number; moveY?: number; turnX?: number; turnY?: number };
        triggerPressed?: boolean;
        rayVisible?: boolean;
      } | null) => boolean;
    };
  }).__NOAH_TEST__?.setSyntheticXrState(value) ?? false, input);
  expect(sent).toBe(true);
}

async function getDebugSurfaceWorldPosition(page: Page, u: number, v: number): Promise<{ x: number; y: number; z: number }> {
  const position = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: { getDebugSurfaceWorldPosition: (u: number, v: number) => { x: number; y: number; z: number } | null };
  }).__NOAH_TEST__?.getDebugSurfaceWorldPosition(value.u, value.v) ?? null, { u, v });
  expect(position).not.toBeNull();
  return position!;
}

async function getKeyboardTargetWorldPosition(page: Page, targetId: string): Promise<{ x: number; y: number; z: number }> {
  const position = await page.evaluate((id) => (window as Window & {
    __NOAH_TEST__?: { getRemoteBrowserVrKeyboardTargetWorldPosition: (targetId: string) => { x: number; y: number; z: number } | null };
  }).__NOAH_TEST__?.getRemoteBrowserVrKeyboardTargetWorldPosition(id) ?? null, targetId);
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

  const previousSeq = (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0;
  await sendSurfaceInput(page, { kind: "scroll", u: 0.5, v: 0.5, scrollDelta: { x: 0, y: -480 } });
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      advanced: (debug?.remoteBrowser?.lastInputSeq ?? 0) > previousSeq,
      eventKind: debug?.surfaceInput?.lastEvent?.kind ?? null,
      scrollDelta: debug?.surfaceInput?.lastEvent?.scrollDelta ?? null
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000]
  }).toEqual({ advanced: true, eventKind: "scroll", scrollDelta: { x: 0, y: -480 } });

  await expect(page.locator("#stop-remote-browser")).toBeEnabled();
  await page.click("#stop-remote-browser");
  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.active ?? true, {
    timeout: 10000,
    intervals: [500, 1000]
  }).toBe(false);
});

test("M1.7 VR surface click and stick scroll route to the remote browser", async ({ page }) => {
  test.setTimeout(60000);
  const roomId = `m1-remote-browser-vr-surface-${Date.now()}`;
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
  const incrementTarget = await getDebugSurfaceWorldPosition(page, 0.1, 0.78);
  const incrementRayDirection = directionTo(origin, incrementTarget);
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection: incrementRayDirection,
    triggerPressed: false,
    rayVisible: true
  });

  await expect.poll(async () => (await readDebug(page))?.interactionRay?.targetKind ?? null, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toBe("surface");

  const previousClickSeq = (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0;
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection: incrementRayDirection,
    triggerPressed: true,
    rayVisible: true
  });

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      advanced: (debug?.remoteBrowser?.lastInputSeq ?? 0) > previousClickSeq,
      eventKind: debug?.surfaceInput?.lastEvent?.kind ?? null,
      target: debug?.interactionRay?.targetKind ?? null
    };
  }, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toEqual({ advanced: true, eventKind: "click", target: "surface" });

  const scrollTarget = await getDebugSurfaceWorldPosition(page, 0.5, 0.5);
  const scrollRayDirection = directionTo(origin, scrollTarget);
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection: scrollRayDirection,
    triggerPressed: false,
    rayVisible: true
  });

  const previousScrollSeq = (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0;
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection: scrollRayDirection,
    triggerPressed: false,
    axes: { turnY: 0.8 },
    rayVisible: true
  });

  await expect.poll(async () => {
    const debug = await readDebug(page);
    const delta = debug?.surfaceInput?.lastEvent?.scrollDelta ?? null;
    return {
      advanced: (debug?.remoteBrowser?.lastInputSeq ?? 0) > previousScrollSeq,
      eventKind: debug?.surfaceInput?.lastEvent?.kind ?? null,
      scrollsDown: typeof delta?.y === "number" && delta.y > 0
    };
  }, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toEqual({ advanced: true, eventKind: "scroll", scrollsDown: true });
});

test("M1.7 VR keyboard toggles, switches layout, and sends remote browser key input", async ({ page }) => {
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
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection: { x: 0, y: 0, z: -1 },
    triggerPressed: false,
    rayVisible: false
  });

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      toggleVisible: debug?.remoteBrowser?.xrKeyboardToggleVisible ?? false,
      keyboardVisible: debug?.remoteBrowser?.xrKeyboardVisible ?? true,
      keyboardOpen: debug?.remoteBrowser?.xrKeyboardOpen ?? true,
      layout: debug?.remoteBrowser?.xrKeyboardLayout ?? null
    };
  }, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toEqual({ toggleVisible: true, keyboardVisible: false, keyboardOpen: false, layout: "en-US" });

  let target = await getKeyboardTargetWorldPosition(page, "toggle");
  let rayDirection = directionTo(origin, target);
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection,
    triggerPressed: false,
    rayVisible: true
  });

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      hovered: debug?.remoteBrowser?.xrKeyboardHoveredTarget ?? null,
      target: debug?.interactionRay?.targetKind ?? null
    };
  }, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toEqual({ hovered: "toggle", target: "keyboard" });

  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection,
    triggerPressed: true,
    rayVisible: true
  });

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      visible: debug?.remoteBrowser?.xrKeyboardVisible ?? false,
      open: debug?.remoteBrowser?.xrKeyboardOpen ?? false,
      pressed: debug?.remoteBrowser?.xrKeyboardPressedTarget ?? null,
      lastKey: debug?.remoteBrowser?.xrKeyboardLastKey ?? null
    };
  }, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toEqual({ visible: true, open: true, pressed: "toggle", lastKey: "toggle" });

  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection,
    triggerPressed: false,
    rayVisible: true
  });

  target = await getKeyboardTargetWorldPosition(page, "key-layout-next");
  rayDirection = directionTo(origin, target);
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection,
    triggerPressed: false,
    rayVisible: true
  });

  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.xrKeyboardHoveredTarget ?? null, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toBe("key-layout-next");

  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection,
    triggerPressed: true,
    rayVisible: true
  });

  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.xrKeyboardLayout ?? null, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toBe("ru-RU");

  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection,
    triggerPressed: false,
    rayVisible: true
  });

  const previousSeq = (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0;
  target = await getKeyboardTargetWorldPosition(page, "key-ru-ef");
  rayDirection = directionTo(origin, target);
  await setSyntheticXrState(page, {
    rightController: origin,
    rayDirection,
    triggerPressed: false,
    rayVisible: true
  });

  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.xrKeyboardHoveredTarget ?? null, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toBe("key-ru-ef");

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
      pressed: debug?.remoteBrowser?.xrKeyboardPressedTarget ?? null,
      advanced: (debug?.remoteBrowser?.lastInputSeq ?? 0) > previousSeq
    };
  }, {
    timeout: 10000,
    intervals: [250, 500, 1000]
  }).toEqual({ lastKey: "key-ru-ef", pressed: "key-ru-ef", advanced: true });
});

test("M1.7 remote browser streams page video and audio over media transport", async ({ page }) => {
  test.setTimeout(90000);
  const roomId = `m1-remote-browser-media-${Date.now()}`;
  await page.goto(`/rooms/${roomId}?role=host&debug=1`);
  await waitForKernel(page);

  await expect(page.locator("#open-remote-browser")).toBeEnabled();
  await page.fill("#remote-browser-url", "/remote-browser-media-demo.html");
  await page.click("#open-remote-browser");

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      active: debug?.remoteBrowser?.active ?? false,
      status: debug?.remoteBrowser?.status ?? null,
      frameConnected: debug?.remoteBrowser?.frameConnected ?? false,
      mediaState: debug?.remoteBrowser?.mediaState ?? null,
      mediaConnected: debug?.remoteBrowser?.mediaConnected ?? false,
      mediaHasVideo: debug?.remoteBrowser?.mediaHasVideo ?? false,
      mediaHasAudio: debug?.remoteBrowser?.mediaHasAudio ?? false,
      mediaSourceIsPageBounded: Boolean(
        debug?.remoteBrowser?.mediaSourceRect
        && debug.remoteBrowser.mediaSourceRect.width < debug.remoteBrowser.mediaSourceRect.viewportWidth
        && debug.remoteBrowser.mediaSourceRect.height < debug.remoteBrowser.mediaSourceRect.viewportHeight
      )
    };
  }, {
    timeout: 45000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    active: true,
    status: "active",
    frameConnected: true,
    mediaState: "connected",
    mediaConnected: true,
    mediaHasVideo: true,
    mediaHasAudio: true,
    mediaSourceIsPageBounded: true
  });
});
