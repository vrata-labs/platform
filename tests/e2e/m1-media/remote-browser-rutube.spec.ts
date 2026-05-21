import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type RemoteBrowserDebug = {
  roomStateConnected?: boolean;
  sceneBundleState?: string | null;
  access?: { role?: string; canCreateRemoteBrowser?: boolean };
  remoteBrowser?: {
    active?: boolean;
    status?: string | null;
    currentUrl?: string | null;
    frameConnected?: boolean;
    lastFrameAtMs?: number;
    mediaParticipantId?: string | null;
    mediaTrackSid?: string | null;
    audioTrackSid?: string | null;
    lastInputSeq?: number;
    mediaState?: string | null;
    mediaConnected?: boolean;
    mediaHasVideo?: boolean;
    mediaHasAudio?: boolean;
    mediaPeerConnectionState?: string | null;
    mediaErrorCode?: string | null;
    mediaSourceRect?: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number } | null;
    mediaCompositeHoldActive?: boolean;
    lastExecutorInput?: {
      inputEventId: string;
      inputType: "pointer" | "scroll" | "keyboard";
      eventKind: string;
      x: number;
      y: number;
      receivedAtMs: number;
      appliedAtMs: number;
      status: "applied" | "failed";
      pageUrl?: string;
      pageClosed: boolean;
      targetDetail?: string;
      errorDetail?: string;
    } | null;
    errorCode?: string | null;
    errorDetail?: string | null;
  };
  mediaObjects?: {
    surfaces?: Array<{ surfaceId?: string; activeObjectType?: string | null }>;
  };
};

type SurfaceSample = {
  clip: { sx: number; sy: number; sw: number; sh: number };
  samples: Array<[number, number, number]>;
};

type HoverCandidate = { u: number; v: number };

const stagingAdminToken = process.env.STAGING_ADMIN_TOKEN ?? "noah-stage-admin";
const blueOfficeRoomId = process.env.STAGING_BLUEOFFICE_ROOM_ID ?? "0b537d34-7b92-4b51-854a-8c64cfb4c114";
const rutubePrimaryUrl = process.env.RUTUBE_E2E_URL ?? "https://rutube.ru/live/video/9ae8e8a6dc58bdad66190475f9872ecd/";
const rutubeSecondaryUrl = process.env.RUTUBE_E2E_SECOND_URL ?? "https://rutube.ru/video/6c226a4bf389d9801ed7c89f39eef8ae/";

async function readDebug(page: Page): Promise<RemoteBrowserDebug | undefined> {
  return page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: RemoteBrowserDebug }).__NOAH_DEBUG__);
}

async function createTemporaryBlueOfficeRoom(request: APIRequestContext): Promise<string> {
  const manifestResponse = await request.get(`/api/rooms/${blueOfficeRoomId}/manifest`);
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json() as { sceneBundle?: { url?: string } };
  expect(manifest.sceneBundle?.url).toBeTruthy();

  const createRoomResponse = await request.post("/api/rooms", {
    headers: {
      "x-noah-admin-token": stagingAdminToken
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: `Rutube E2E ${Date.now()}`,
      guestAllowed: true,
      sceneBundleUrl: manifest.sceneBundle!.url,
      features: { voice: true, spatialAudio: true, screenShare: true }
    }
  });
  expect(createRoomResponse.ok()).toBeTruthy();
  const room = await createRoomResponse.json() as { roomId: string };
  return room.roomId;
}

async function deleteTemporaryRoom(request: APIRequestContext, roomId: string): Promise<void> {
  const deleteResponse = await request.delete(`/api/rooms/${roomId}`, {
    headers: {
      "x-noah-admin-token": stagingAdminToken
    }
  });
  expect(deleteResponse.ok()).toBeTruthy();
}

async function waitForBlueOfficeKernel(page: Page): Promise<void> {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null,
      canCreateRemoteBrowser: debug?.access?.canCreateRemoteBrowser ?? false,
      sceneBundleState: debug?.sceneBundleState ?? null,
      hasSurface: debug?.mediaObjects?.surfaces?.some((surface) => surface.surfaceId === "debug-main") ?? false
    };
  }, {
    timeout: 60000,
    intervals: [500, 1000, 2000, 3000]
  }).toEqual({
    connected: true,
    role: "host",
    canCreateRemoteBrowser: true,
    sceneBundleState: "loaded",
    hasSurface: true
  });
}

async function openRemoteBrowserUrl(page: Page, url: string): Promise<void> {
  await expect(page.locator("#open-remote-browser")).toBeEnabled();
  await page.locator("#remote-browser-url").fill(url);
  await page.locator("#open-remote-browser").click();
}

async function openDefaultRemoteBrowserUrl(page: Page): Promise<string> {
  await expect(page.locator("#remote-browser-url")).toHaveValue("/remote-browser-demo.html");
  await expect(page.locator("#open-remote-browser")).toBeEnabled();
  const expectedUrl = await page.evaluate(() => new URL("/remote-browser-demo.html", window.location.origin).toString());
  await page.locator("#open-remote-browser").click();
  return expectedUrl;
}

async function waitForRemoteBrowserViewportState(page: Page, expectedUrl: string): Promise<void> {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      activeObjectType: debug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === "debug-main")?.activeObjectType ?? null,
      active: debug?.remoteBrowser?.active ?? false,
      status: debug?.remoteBrowser?.status ?? null,
      currentUrl: debug?.remoteBrowser?.currentUrl ?? null,
      hasMediaParticipant: Boolean(debug?.remoteBrowser?.mediaParticipantId),
      hasVideoTrackState: Boolean(debug?.remoteBrowser?.mediaTrackSid),
      hasAudioTrackState: Boolean(debug?.remoteBrowser?.audioTrackSid),
      errorCode: debug?.remoteBrowser?.errorCode ?? null,
      errorDetail: debug?.remoteBrowser?.errorDetail ?? null
    };
  }, {
    timeout: 60000,
    intervals: [500, 1000, 2000, 3000]
  }).toEqual({
    activeObjectType: "remote-browser",
    active: true,
    status: "active",
    currentUrl: expectedUrl,
    hasMediaParticipant: true,
    hasVideoTrackState: true,
    hasAudioTrackState: true,
    errorCode: null,
    errorDetail: null
  });
}

async function waitForRutubeMedia(page: Page): Promise<void> {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    const rect = debug?.remoteBrowser?.mediaSourceRect ?? null;
    return {
      mediaState: debug?.remoteBrowser?.mediaState ?? null,
      mediaConnected: debug?.remoteBrowser?.mediaConnected ?? false,
      mediaHasVideo: debug?.remoteBrowser?.mediaHasVideo ?? false,
      mediaHasAudio: debug?.remoteBrowser?.mediaHasAudio ?? false,
      mediaErrorCode: debug?.remoteBrowser?.mediaErrorCode ?? null,
      hasVideoTrackState: Boolean(debug?.remoteBrowser?.mediaTrackSid),
      hasAudioTrackState: Boolean(debug?.remoteBrowser?.audioTrackSid),
      sourceBounded: Boolean(
        rect
        && rect.width > 100
        && rect.height > 100
        && rect.width < rect.viewportWidth
        && rect.x >= 0
        && rect.y >= 0
      )
    };
  }, {
    timeout: 90000,
    intervals: [1000, 2000, 3000]
  }).toEqual({
    mediaState: "connected",
    mediaConnected: true,
    mediaHasVideo: true,
    mediaHasAudio: true,
    mediaErrorCode: null,
    hasVideoTrackState: true,
    hasAudioTrackState: true,
    sourceBounded: true
  });
}

async function waitForRemoteBrowserViewportMedia(page: Page, expectedUrl: string): Promise<void> {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      status: debug?.remoteBrowser?.status ?? null,
      currentUrl: debug?.remoteBrowser?.currentUrl ?? null,
      mediaState: debug?.remoteBrowser?.mediaState ?? null,
      mediaConnected: debug?.remoteBrowser?.mediaConnected ?? false,
      mediaHasVideo: debug?.remoteBrowser?.mediaHasVideo ?? false,
      mediaHasAudio: debug?.remoteBrowser?.mediaHasAudio ?? false,
      hasVideoTrackState: Boolean(debug?.remoteBrowser?.mediaTrackSid),
      hasAudioTrackState: Boolean(debug?.remoteBrowser?.audioTrackSid),
      externalVideoAttached: debug?.remoteBrowser?.externalVideoAttached ?? false,
      externalVideoReadyState: debug?.remoteBrowser?.externalVideoReadyState ?? null,
      externalVideoWidth: debug?.remoteBrowser?.externalVideoWidth ?? 0,
      externalVideoHeight: debug?.remoteBrowser?.externalVideoHeight ?? 0,
      externalVideoFrameCountReady: (debug?.remoteBrowser?.externalVideoFrameCount ?? 0) > 5,
      errorCode: debug?.remoteBrowser?.errorCode ?? null,
      mediaErrorCode: debug?.remoteBrowser?.mediaErrorCode ?? null
    };
  }, {
    timeout: 90000,
    intervals: [500, 1000, 2000, 3000]
  }).toEqual({
    status: "active",
    currentUrl: expectedUrl,
    mediaState: "connected",
    mediaConnected: true,
    mediaHasVideo: true,
    mediaHasAudio: true,
    hasVideoTrackState: true,
    hasAudioTrackState: true,
    externalVideoAttached: true,
    externalVideoReadyState: 4,
    externalVideoWidth: 1280,
    externalVideoHeight: 720,
    externalVideoFrameCountReady: true,
    errorCode: null,
    mediaErrorCode: null
  });
}

async function sendSurfaceInput(page: Page, input: { source?: string; kind: string; u?: number; v?: number; key?: string; text?: string; scrollDelta?: { x: number; y: number } }): Promise<number> {
  const beforeDebug = await readDebug(page);
  const beforeSeq = beforeDebug?.remoteBrowser?.lastInputSeq ?? 0;
  const beforeExecutorInput = beforeDebug?.remoteBrowser?.lastExecutorInput ?? null;
  const sent = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: { sendDebugSurfaceInput: (input?: { source?: string; kind?: string; u?: number; v?: number; key?: string; text?: string; scrollDelta?: { x: number; y: number } }) => boolean };
  }).__NOAH_TEST__?.sendDebugSurfaceInput(value) ?? false, input);
  expect(sent).toBe(true);
  const startedAt = Date.now();
  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toBeGreaterThan(beforeSeq);
  await expect.poll(async () => {
    const lastExecutorInput = (await readDebug(page))?.remoteBrowser?.lastExecutorInput ?? null;
    const updated = Boolean(lastExecutorInput && (
      lastExecutorInput.inputEventId !== beforeExecutorInput?.inputEventId
      || lastExecutorInput.appliedAtMs > (beforeExecutorInput?.appliedAtMs ?? 0)
    ));
    return {
      updated,
      status: updated ? lastExecutorInput?.status ?? null : null,
      pageClosed: updated ? lastExecutorInput?.pageClosed ?? null : null,
      errorDetail: updated ? lastExecutorInput?.errorDetail ?? null : null
    };
  }, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toEqual({
    updated: true,
    status: "applied",
    pageClosed: false,
    errorDetail: null
  });
  return Date.now() - startedAt;
}

async function focusDebugSurface(page: Page): Promise<void> {
  const focused = await page.evaluate(() => (window as Window & {
    __NOAH_TEST__?: { focusDebugSurface: () => boolean };
  }).__NOAH_TEST__?.focusDebugSurface() ?? false);
  expect(focused).toBe(true);
}

async function surfaceClientPoint(page: Page, u: number, v: number): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: { getDebugSurfaceClientPosition: (u: number, v: number) => { x: number; y: number } | null };
  }).__NOAH_TEST__?.getDebugSurfaceClientPosition(value.u, value.v) ?? null, { u, v });
  expect(point).not.toBeNull();
  return point!;
}

async function moveMouseToSurface(page: Page, u: number, v: number): Promise<number> {
  return sendSurfaceInput(page, { kind: "pointer-move", u, v });
}

async function waitForFreshFrame(page: Page, previousFrameAt: number): Promise<number> {
  const startedAt = Date.now();
  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.lastFrameAtMs ?? 0, {
    timeout: 10000,
    intervals: [250, 500, 1000]
  }).toBeGreaterThan(previousFrameAt);
  return Date.now() - startedAt;
}

async function sampleSurfaceRegion(page: Page, center: { u: number; v: number }, size = { width: 0.18, height: 0.18 }): Promise<SurfaceSample> {
  return page.evaluate(({ center: sampleCenter, size: sampleSize }) => {
    const noahWindow = window as Window & {
      __NOAH_TEST__?: {
        getDebugSurfaceClientPosition: (u: number, v: number) => { x: number; y: number } | null;
        sampleDebugSurfaceTexture?: (center: { u: number; v: number }, size?: { width: number; height: number }) => SurfaceSample | null;
      };
    };
    const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
    const helper = noahWindow.__NOAH_TEST__;
    const textureSample = helper?.sampleDebugSurfaceTexture?.(sampleCenter, sampleSize);
    if (textureSample) {
      return textureSample;
    }
    if (!canvas || !helper) {
      throw new Error("rutube_sample_canvas_unavailable");
    }

    const u1 = Math.max(0, sampleCenter.u - sampleSize.width / 2);
    const v1 = Math.max(0, sampleCenter.v - sampleSize.height / 2);
    const u2 = Math.min(1, sampleCenter.u + sampleSize.width / 2);
    const v2 = Math.min(1, sampleCenter.v + sampleSize.height / 2);
    const p1 = helper.getDebugSurfaceClientPosition(u1, v1);
    const p2 = helper.getDebugSurfaceClientPosition(u2, v2);
    if (!p1 || !p2) {
      throw new Error("rutube_sample_surface_unavailable");
    }

    const bounds = canvas.getBoundingClientRect();
    const left = Math.max(bounds.left, Math.min(p1.x, p2.x));
    const top = Math.max(bounds.top, Math.min(p1.y, p2.y));
    const right = Math.min(bounds.right, Math.max(p1.x, p2.x));
    const bottom = Math.min(bounds.bottom, Math.max(p1.y, p2.y));
    const sx = Math.max(0, Math.floor((left - bounds.left) * canvas.width / bounds.width));
    const sy = Math.max(0, Math.floor((top - bounds.top) * canvas.height / bounds.height));
    const sw = Math.max(1, Math.floor((right - left) * canvas.width / bounds.width));
    const sh = Math.max(1, Math.floor((bottom - top) * canvas.height / bounds.height));

    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("rutube_sample_context_unavailable");
    }
    context.drawImage(canvas, 0, 0);
    const data = context.getImageData(sx, sy, sw, sh).data;
    const samples: Array<[number, number, number]> = [];
    for (let sampleIndex = 0; sampleIndex < 128; sampleIndex += 1) {
      const x = Math.min(sw - 1, Math.floor(((sampleIndex % 16) + 0.5) * sw / 16));
      const y = Math.min(sh - 1, Math.floor((Math.floor(sampleIndex / 16) + 0.5) * sh / 8));
      const pixelIndex = (y * sw + x) * 4;
      samples.push([data[pixelIndex] ?? 0, data[pixelIndex + 1] ?? 0, data[pixelIndex + 2] ?? 0]);
    }
    return { clip: { sx, sy, sw, sh }, samples };
  }, { center, size });
}

function averageRgbDiff(left: SurfaceSample, right: SurfaceSample): number {
  const count = Math.min(left.samples.length, right.samples.length);
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const leftSample = left.samples[index]!;
    const rightSample = right.samples[index]!;
    total += Math.abs(leftSample[0] - rightSample[0]);
    total += Math.abs(leftSample[1] - rightSample[1]);
    total += Math.abs(leftSample[2] - rightSample[2]);
  }
  return total / Math.max(1, count * 3);
}

function countDemoUiPixels(sample: SurfaceSample): number {
  return sample.samples.filter(([r, g, b]) => (
    (b > 140 && r < 120)
    || (r < 110 && g < 110 && b < 140)
  )).length;
}

async function expectDefaultDemoViewportVisible(page: Page): Promise<void> {
  let lastSample: SurfaceSample | null = null;
  let lastUiPixels = 0;
  let lastDebug: RemoteBrowserDebug["remoteBrowser"] | null = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const sample = await sampleSurfaceRegion(page, { u: 0.13, v: 0.76 }, { width: 0.14, height: 0.14 });
    lastSample = sample;
    lastUiPixels = countDemoUiPixels(sample);
    lastDebug = (await readDebug(page))?.remoteBrowser ?? null;
    if (lastUiPixels > 4) {
      return;
    }
    await page.waitForTimeout(500);
  }
  expect(lastUiPixels, `default demo viewport stayed visually blank: ${JSON.stringify({ lastUiPixels, lastSample, remoteBrowser: lastDebug }, null, 2)}`).toBeGreaterThan(4);
}

function inputReachedRutubeHoverTarget(debug: RemoteBrowserDebug["remoteBrowser"] | null): boolean {
  const detail = debug?.lastExecutorInput?.targetDetail;
  if (!detail) {
    return false;
  }
  const targetReached = [
    "target=video",
    "desktop-controls-layout-module",
    "wdp-video-options-row-module",
    "wdpVideoOptionsRow",
    "video-pageinfo-container-module"
  ].some((marker) => detail.includes(marker));
  const pointerMoves = Number(detail.match(/;pm=(\d+)/)?.[1] ?? "0");
  const mouseMoves = Number(detail.match(/;mm=(\d+)/)?.[1] ?? "0");
  return targetReached && pointerMoves + mouseMoves > 0;
}

async function expectVisibleHoverResponse(page: Page): Promise<void> {
  let bestDiff = 0;
  let bestLatencyMs = Number.POSITIVE_INFINITY;
  let inputReachedTarget = false;
  const attempts: Array<{ candidate: HoverCandidate; clip: SurfaceSample["clip"]; diff: number; inputLatencyMs: number; debug: RemoteBrowserDebug["remoteBrowser"] | null }> = [];
  let candidateIndex = 0;
  while (candidateIndex < 5) {
    await moveMouseToSurface(page, 0.02, 0.98);
    await page.waitForTimeout(3500);
    const candidates = playerHoverCandidates(await readDebug(page));
    const candidate = candidates[Math.min(candidateIndex, candidates.length - 1)]!;
    const sampleSize = candidate.v < 0.2
      ? { width: 0.34, height: 0.08 }
      : { width: 0.18, height: 0.18 };
    const before = await sampleSurfaceRegion(page, candidate, sampleSize);
    const inputLatencyMs = await moveMouseToSurface(page, candidate.u, candidate.v);
    const visualStartedAt = Date.now();
    let candidateBestDiff = 0;
    while (Date.now() - visualStartedAt < 5000) {
      await page.waitForTimeout(500);
      const after = await sampleSurfaceRegion(page, candidate, sampleSize);
      candidateBestDiff = Math.max(candidateBestDiff, averageRgbDiff(before, after));
      bestDiff = Math.max(bestDiff, candidateBestDiff);
      if (bestDiff > 6) {
        break;
      }
    }
    bestLatencyMs = Math.min(bestLatencyMs, inputLatencyMs);
    const debug = (await readDebug(page))?.remoteBrowser ?? null;
    inputReachedTarget ||= inputReachedRutubeHoverTarget(debug);
    attempts.push({
      candidate,
      clip: before.clip,
      diff: Number(candidateBestDiff.toFixed(3)),
      inputLatencyMs,
      debug
    });
    if (bestDiff > 6 || inputReachedTarget) {
      break;
    }
    candidateIndex += 1;
  }

  expect(bestLatencyMs).toBeLessThan(2500);
  expect(bestDiff > 6 || inputReachedTarget, `Rutube hover produced no visible response: ${JSON.stringify({ bestDiff, bestLatencyMs, inputReachedTarget, attempts }, null, 2)}`).toBe(true);
}

async function dismissRutubeOverlays(page: Page): Promise<void> {
  await focusDebugSurface(page);
  for (let index = 0; index < 2; index += 1) {
    await sendSurfaceInput(page, { source: "keyboard", kind: "key-down", key: "Escape" });
    await sendSurfaceInput(page, { source: "keyboard", kind: "key-up", key: "Escape" });
    await page.waitForTimeout(500);
  }
  const overlayTargets = [
    { u: 0.68, v: 0.87 },
    { u: 0.68, v: 0.85 },
    { u: 0.5, v: 0.23 },
    { u: 0.4, v: 0.16 },
    { u: 0.36, v: 0.08 }
  ];
  for (const target of overlayTargets) {
    await sendSurfaceInput(page, { kind: "click", u: target.u, v: target.v });
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1500);
}

function surfaceUvFromRemoteBrowserPagePoint(rect: NonNullable<RemoteBrowserDebug["remoteBrowser"]>["mediaSourceRect"], x: number, y: number): { u: number; v: number } {
  expect(rect).toBeTruthy();
  return {
    u: Math.max(0, Math.min(1, x / rect!.viewportWidth)),
    v: Math.max(0, Math.min(1, 1 - y / rect!.viewportHeight))
  };
}

function playerHoverCandidates(debug: RemoteBrowserDebug | undefined): HoverCandidate[] {
  const rect = debug?.remoteBrowser?.mediaSourceRect;
  if (!rect) {
    return [{ u: 0.5, v: 0.5 }];
  }
  const xCenter = (rect.x + rect.width * 0.5) / rect.viewportWidth;
  const xLeft = (rect.x + rect.width * 0.2) / rect.viewportWidth;
  const yCenter = (rect.y + rect.height * 0.55) / rect.viewportHeight;
  return [
    surfaceUvFromRemoteBrowserPagePoint(rect, rect.x + rect.width * 0.5, Math.min(rect.viewportHeight - 24, rect.y + rect.height - 32)),
    surfaceUvFromRemoteBrowserPagePoint(rect, rect.x + rect.width * 0.5, rect.y + rect.height * 0.55),
    surfaceUvFromRemoteBrowserPagePoint(rect, rect.x + rect.width * 0.2, rect.y + rect.height * 0.55),
    { u: xCenter, v: 1 - yCenter },
    { u: xLeft, v: 1 - yCenter }
  ];
}

async function expectNoFrameBacklog(page: Page, sampleSeconds: number[]): Promise<void> {
  const startedAt = Date.now();
  const inputLatencies: number[] = [];
  for (const targetSecond of sampleSeconds) {
    const waitMs = startedAt + targetSecond * 1000 - Date.now();
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }
    const inputLatency = await sendSurfaceInput(page, { kind: "pointer-move", u: 0.5, v: 0.5 });
    inputLatencies.push(inputLatency);
    const debug = await readDebug(page);
    expect(debug?.remoteBrowser?.mediaConnected).toBe(true);
    expect(debug?.remoteBrowser?.mediaHasVideo).toBe(true);
    expect(debug?.remoteBrowser?.mediaHasAudio).toBe(true);
    expect(debug?.remoteBrowser?.errorCode ?? null).toBeNull();
  }

  expect(Math.max(...inputLatencies)).toBeLessThan(2500);
}

test("@staging @rutube real Rutube remote browser keeps hover UI, video transport, and switching responsive", async ({ page, request }) => {
  test.setTimeout(420000);
  let roomId: string | null = null;

  try {
    roomId = await createTemporaryBlueOfficeRoom(request);
    await page.goto(`/rooms/${roomId}?role=host&debug=1&scenefit=0`, { waitUntil: "domcontentloaded" });
    await waitForBlueOfficeKernel(page);

    await openRemoteBrowserUrl(page, rutubePrimaryUrl);
    await waitForRemoteBrowserViewportState(page, rutubePrimaryUrl);
    await waitForRutubeMedia(page);
    await dismissRutubeOverlays(page);
    await expectVisibleHoverResponse(page);
    await sendSurfaceInput(page, { kind: "click", u: 0.5, v: 0.5 });
    await expectNoFrameBacklog(page, [0, 30, 60, 90]);

    await openRemoteBrowserUrl(page, rutubeSecondaryUrl);
    await waitForRemoteBrowserViewportState(page, rutubeSecondaryUrl);
    await waitForRutubeMedia(page);
    await dismissRutubeOverlays(page);
    await expectVisibleHoverResponse(page);
    await expectNoFrameBacklog(page, [0, 20, 40]);
  } finally {
    if (roomId) {
      await deleteTemporaryRoom(request, roomId);
    }
  }
});

test("@staging remote browser default demo renders visible viewport and receives input", async ({ page, request }) => {
  test.setTimeout(180000);
  let roomId: string | null = null;

  try {
    roomId = await createTemporaryBlueOfficeRoom(request);
    await page.goto(`/rooms/${roomId}?role=host&debug=1&scenefit=0`, { waitUntil: "domcontentloaded" });
    await waitForBlueOfficeKernel(page);

    const expectedUrl = await openDefaultRemoteBrowserUrl(page);
    await waitForRemoteBrowserViewportState(page, expectedUrl);
    await waitForRemoteBrowserViewportMedia(page, expectedUrl);
    await expectDefaultDemoViewportVisible(page);

    await sendSurfaceInput(page, { kind: "click", u: 0.13, v: 0.67 });
    await expect.poll(async () => {
      const debug = await readDebug(page);
      return debug?.remoteBrowser?.lastExecutorInput?.targetDetail ?? "";
    }, {
      timeout: 10000,
      intervals: [250, 500]
    }).toContain("button#increment");
  } finally {
    if (roomId) {
      await deleteTemporaryRoom(request, roomId);
    }
  }
});
