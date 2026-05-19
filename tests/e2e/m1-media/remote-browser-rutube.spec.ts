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
    return {
      mediaState: debug?.remoteBrowser?.mediaState ?? null,
      mediaConnected: debug?.remoteBrowser?.mediaConnected ?? false,
      mediaHasVideo: debug?.remoteBrowser?.mediaHasVideo ?? false,
      mediaHasAudio: debug?.remoteBrowser?.mediaHasAudio ?? false,
      mediaErrorCode: debug?.remoteBrowser?.mediaErrorCode ?? null,
      hasVideoTrackState: Boolean(debug?.remoteBrowser?.mediaTrackSid),
      hasAudioTrackState: Boolean(debug?.remoteBrowser?.audioTrackSid)
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
    hasAudioTrackState: true
  });
}

async function sendSurfaceInput(page: Page, input: { kind: string; u?: number; v?: number; scrollDelta?: { x: number; y: number } }): Promise<number> {
  const beforeSeq = (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0;
  const sent = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: { sendDebugSurfaceInput: (input?: { kind?: string; u?: number; v?: number; scrollDelta?: { x: number; y: number } }) => boolean };
  }).__NOAH_TEST__?.sendDebugSurfaceInput(value) ?? false, input);
  expect(sent).toBe(true);
  const startedAt = Date.now();
  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toBeGreaterThan(beforeSeq);
  return Date.now() - startedAt;
}

async function surfaceClientPoint(page: Page, u: number, v: number): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: { getDebugSurfaceClientPosition: (u: number, v: number) => { x: number; y: number } | null };
  }).__NOAH_TEST__?.getDebugSurfaceClientPosition(value.u, value.v) ?? null, { u, v });
  expect(point).not.toBeNull();
  return point!;
}

async function moveMouseToSurface(page: Page, u: number, v: number): Promise<number> {
  const beforeSeq = (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0;
  const point = await surfaceClientPoint(page, u, v);
  const startedAt = Date.now();
  await page.mouse.move(point.x, point.y, { steps: 10 });
  await expect.poll(async () => (await readDebug(page))?.remoteBrowser?.lastInputSeq ?? 0, {
    timeout: 10000,
    intervals: [100, 250, 500]
  }).toBeGreaterThan(beforeSeq);
  return Date.now() - startedAt;
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
      __NOAH_TEST__?: { getDebugSurfaceClientPosition: (u: number, v: number) => { x: number; y: number } | null };
    };
    const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
    const helper = noahWindow.__NOAH_TEST__;
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

async function expectVisibleHoverResponse(page: Page, candidates: Array<{ u: number; v: number }>): Promise<void> {
  let bestDiff = 0;
  let bestLatencyMs = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    await page.waitForTimeout(2500);
    const sampleSize = candidate.v < 0.2
      ? { width: 0.34, height: 0.08 }
      : { width: 0.18, height: 0.18 };
    const before = await sampleSurfaceRegion(page, candidate, sampleSize);
    const inputLatencyMs = await moveMouseToSurface(page, candidate.u, candidate.v);
    const visualStartedAt = Date.now();
    while (Date.now() - visualStartedAt < 5000) {
      await page.waitForTimeout(500);
      const after = await sampleSurfaceRegion(page, candidate, sampleSize);
      bestDiff = Math.max(bestDiff, averageRgbDiff(before, after));
      if (bestDiff > 6) {
        break;
      }
    }
    bestLatencyMs = Math.min(bestLatencyMs, inputLatencyMs);
    if (bestDiff > 6) {
      break;
    }
  }

  expect(bestLatencyMs).toBeLessThan(2500);
  expect(bestDiff).toBeGreaterThan(6);
}

function playerHoverCandidates(): Array<{ u: number; v: number }> {
  return [
    { u: 0.5, v: 0.08 },
    { u: 0.5, v: 0.45 },
    { u: 0.2, v: 0.45 }
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
  test.setTimeout(300000);
  let roomId: string | null = null;

  try {
    roomId = await createTemporaryBlueOfficeRoom(request);
    await page.goto(`/rooms/${roomId}?role=host&debug=1&scenefit=0`, { waitUntil: "domcontentloaded" });
    await waitForBlueOfficeKernel(page);

    await openRemoteBrowserUrl(page, rutubePrimaryUrl);
    await waitForRemoteBrowserViewportState(page, rutubePrimaryUrl);
    await waitForRutubeMedia(page);
    await expectVisibleHoverResponse(page, playerHoverCandidates());
    await sendSurfaceInput(page, { kind: "click", u: 0.5, v: 0.5 });
    await expectNoFrameBacklog(page, [0, 30, 60, 90]);

    await openRemoteBrowserUrl(page, rutubeSecondaryUrl);
    await waitForRemoteBrowserViewportState(page, rutubeSecondaryUrl);
    await waitForRutubeMedia(page);
    await expectVisibleHoverResponse(page, playerHoverCandidates());
    await expectNoFrameBacklog(page, [0, 20, 40]);
  } finally {
    if (roomId) {
      await deleteTemporaryRoom(request, roomId);
    }
  }
});
