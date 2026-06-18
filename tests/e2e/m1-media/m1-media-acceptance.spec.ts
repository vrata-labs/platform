import { expect, test, type Page } from "@playwright/test";

const MAIN_SURFACE_ID = "debug-main";
const WHITEBOARD_SURFACE_ID = "whiteboard-wall";
const LAPTOP_SURFACE_ID = "laptop-screen";

type MediaAcceptanceDebug = {
  roomStateConnected?: boolean;
  access?: { role?: string };
  screenShare?: {
    active?: boolean;
    remoteSubscribedTrackCount?: number;
  };
  surfaceInput?: {
    blockedReason?: string | null;
    lastEvent?: {
      surfaceId?: string | null;
      source?: string | null;
      kind?: string | null;
    } | null;
  };
  mediaObjects?: {
    availableObjectTypes?: string[];
    extensions?: Array<{ id?: string; enabled?: boolean; valid?: boolean }>;
    surfaces?: Array<{
      surfaceId?: string;
      activeObjectId?: string | null;
      activeObjectType?: string | null;
    }>;
    objects?: Array<{
      objectId?: string;
      type?: string;
      surfaceId?: string;
      state?: { status?: string; strokes?: unknown[] };
    }>;
  };
};

function roomUrl(roomId: string, role: "guest" | "member" | "host", extra = "") {
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

async function readDebug(page: Page): Promise<MediaAcceptanceDebug | undefined> {
  return page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: MediaAcceptanceDebug }).__VRATA_DEBUG__);
}

async function waitForKernel(page: Page, role: "guest" | "member" | "host") {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    const surfaceIds = new Set(debug?.mediaObjects?.surfaces?.map((surface) => surface.surfaceId));
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null,
      hasMain: surfaceIds.has(MAIN_SURFACE_ID),
      hasWhiteboard: surfaceIds.has(WHITEBOARD_SURFACE_ID),
      hasLaptop: surfaceIds.has(LAPTOP_SURFACE_ID)
    };
  }, {
    timeout: 15000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    connected: true,
    role,
    hasMain: true,
    hasWhiteboard: true,
    hasLaptop: true
  });
}

function surfaceObjectType(debug: MediaAcceptanceDebug | undefined, surfaceId: string): string | null {
  return debug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === surfaceId)?.activeObjectType ?? null;
}

function activeScreenShareCount(debug: MediaAcceptanceDebug | undefined): number {
  return debug?.mediaObjects?.objects?.filter((object) => object.type === "screen-share" && object.state?.status === "active").length ?? 0;
}

function whiteboardStrokeCount(debug: MediaAcceptanceDebug | undefined, surfaceId: string): number | null {
  const object = debug?.mediaObjects?.objects?.find((item) => item.type === "whiteboard" && item.surfaceId === surfaceId);
  return object?.state?.strokes?.length ?? null;
}

async function selectSurface(page: Page, surfaceId: string) {
  const selected = await page.evaluate((id) => (window as Window & {
    __VRATA_TEST__?: { selectMediaSurface: (surfaceId: string) => boolean };
  }).__VRATA_TEST__?.selectMediaSurface(id) ?? false, surfaceId);
  expect(selected).toBe(true);
}

async function sendSurfaceInput(page: Page, input: { surfaceId: string; source?: string; kind?: string; u?: number; v?: number }) {
  const sent = await trySendSurfaceInput(page, input);
  expect(sent).toBe(true);
}

async function trySendSurfaceInput(page: Page, input: { surfaceId: string; source?: string; kind?: string; u?: number; v?: number }) {
  return page.evaluate((value) => (window as Window & {
    __VRATA_TEST__?: { sendDebugSurfaceInput: (input?: { surfaceId?: string; source?: string; kind?: string; u?: number; v?: number }) => boolean };
  }).__VRATA_TEST__?.sendDebugSurfaceInput(value) ?? false, input);
}

test("M1.10 acceptance covers screen share, whiteboard, XR input, permissions, and rejoin", async ({ browser }) => {
  test.setTimeout(90000);
  const roomId = `m1-media-acceptance-${Date.now()}`;
  const host = await browser.newPage();
  const member = await browser.newPage();
  const guest = await browser.newPage();
  let rejoinedGuest: Page | null = null;

  try {
    await host.goto(roomUrl(roomId, "host", "sharemock=1"));
    await member.goto(roomUrl(roomId, "member"));
    await guest.goto(roomUrl(roomId, "guest"));
    await waitForKernel(host, "host");
    await waitForKernel(member, "member");
    await waitForKernel(guest, "guest");

    const registryDebug = await readDebug(host);
    expect(registryDebug?.mediaObjects?.availableObjectTypes).toEqual(expect.arrayContaining([
      "screen-share",
      "whiteboard",
      "remote-browser",
      "extension-test-card"
    ]));
    expect(registryDebug?.mediaObjects?.extensions?.some((extension) => extension.id === "vrata.screen-share" && extension.enabled && extension.valid)).toBe(true);
    expect(registryDebug?.mediaObjects?.extensions?.some((extension) => extension.id === "vrata.whiteboard" && extension.enabled && extension.valid)).toBe(true);

    await selectSurface(host, MAIN_SURFACE_ID);
    await expect(host.locator("#start-share")).toBeEnabled();
    await host.click("#start-share");

    await expect.poll(async () => {
      const hostDebug = await readDebug(host);
      const memberDebug = await readDebug(member);
      return {
        hostMainObject: surfaceObjectType(hostDebug, MAIN_SURFACE_ID),
        memberMainObject: surfaceObjectType(memberDebug, MAIN_SURFACE_ID),
        activeShares: activeScreenShareCount(memberDebug),
        memberSubscribedTracks: memberDebug?.screenShare?.remoteSubscribedTrackCount ?? 0
      };
    }, {
      timeout: 15000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      hostMainObject: "screen-share",
      memberMainObject: "screen-share",
      activeShares: 1,
      memberSubscribedTracks: 1
    });

    await selectSurface(host, WHITEBOARD_SURFACE_ID);
    await expect(host.locator("#start-whiteboard")).toBeEnabled();
    await host.click("#start-whiteboard");

    await expect.poll(async () => {
      const memberDebug = await readDebug(member);
      const guestDebug = await readDebug(guest);
      return {
        memberMainObject: surfaceObjectType(memberDebug, MAIN_SURFACE_ID),
        memberBoardObject: surfaceObjectType(memberDebug, WHITEBOARD_SURFACE_ID),
        guestBoardObject: surfaceObjectType(guestDebug, WHITEBOARD_SURFACE_ID),
        memberBoardStrokes: whiteboardStrokeCount(memberDebug, WHITEBOARD_SURFACE_ID)
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      memberMainObject: "screen-share",
      memberBoardObject: "whiteboard",
      guestBoardObject: "whiteboard",
      memberBoardStrokes: 0
    });

    await sendSurfaceInput(member, { surfaceId: WHITEBOARD_SURFACE_ID, kind: "pointer-down", u: 0.2, v: 0.2 });
    await sendSurfaceInput(member, { surfaceId: WHITEBOARD_SURFACE_ID, kind: "pointer-move", u: 0.35, v: 0.3 });
    await sendSurfaceInput(member, { surfaceId: WHITEBOARD_SURFACE_ID, kind: "pointer-up", u: 0.5, v: 0.4 });

    await expect.poll(async () => {
      const hostDebug = await readDebug(host);
      const guestDebug = await readDebug(guest);
      return {
        hostBoardStrokes: whiteboardStrokeCount(hostDebug, WHITEBOARD_SURFACE_ID),
        guestBoardStrokes: whiteboardStrokeCount(guestDebug, WHITEBOARD_SURFACE_ID)
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({ hostBoardStrokes: 1, guestBoardStrokes: 1 });

    const guestDrawSent = await trySendSurfaceInput(guest, { surfaceId: WHITEBOARD_SURFACE_ID, kind: "click", u: 0.7, v: 0.7 });
    expect(guestDrawSent).toBe(false);
    await expect.poll(async () => {
      const debug = await readDebug(guest);
      return {
        blockedReason: debug?.surfaceInput?.blockedReason ?? null,
        strokes: whiteboardStrokeCount(debug, WHITEBOARD_SURFACE_ID)
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({ blockedReason: "missing-permission:surface.input", strokes: 1 });

    await selectSurface(host, WHITEBOARD_SURFACE_ID);
    await expect(host.locator("#clear-whiteboard")).toBeEnabled();
    await host.click("#clear-whiteboard");

    await expect.poll(async () => {
      const memberDebug = await readDebug(member);
      return {
        mainObject: surfaceObjectType(memberDebug, MAIN_SURFACE_ID),
        activeShares: activeScreenShareCount(memberDebug),
        boardObject: surfaceObjectType(memberDebug, WHITEBOARD_SURFACE_ID),
        boardStrokes: whiteboardStrokeCount(memberDebug, WHITEBOARD_SURFACE_ID)
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      mainObject: "screen-share",
      activeShares: 1,
      boardObject: "whiteboard",
      boardStrokes: 0
    });

    await sendSurfaceInput(member, { surfaceId: WHITEBOARD_SURFACE_ID, source: "xr-controller", kind: "click", u: 0.42, v: 0.58 });

    await expect.poll(async () => {
      const memberDebug = await readDebug(member);
      return {
        inputSurface: memberDebug?.surfaceInput?.lastEvent?.surfaceId ?? null,
        inputSource: memberDebug?.surfaceInput?.lastEvent?.source ?? null,
        inputKind: memberDebug?.surfaceInput?.lastEvent?.kind ?? null,
        boardStrokes: whiteboardStrokeCount(memberDebug, WHITEBOARD_SURFACE_ID)
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      inputSurface: WHITEBOARD_SURFACE_ID,
      inputSource: "xr-controller",
      inputKind: "click",
      boardStrokes: 1
    });

    await selectSurface(host, MAIN_SURFACE_ID);
    await expect(host.locator("#stop-share")).toBeEnabled();
    await host.click("#stop-share");

    await expect.poll(async () => {
      const memberDebug = await readDebug(member);
      return {
        mainObject: surfaceObjectType(memberDebug, MAIN_SURFACE_ID),
        boardObject: surfaceObjectType(memberDebug, WHITEBOARD_SURFACE_ID),
        boardStrokes: whiteboardStrokeCount(memberDebug, WHITEBOARD_SURFACE_ID)
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      mainObject: null,
      boardObject: "whiteboard",
      boardStrokes: 1
    });

    await guest.close();
    rejoinedGuest = await browser.newPage();
    await rejoinedGuest.goto(roomUrl(roomId, "guest"));
    await waitForKernel(rejoinedGuest, "guest");

    await expect.poll(async () => {
      const debug = await readDebug(rejoinedGuest!);
      return {
        mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
        boardObject: surfaceObjectType(debug, WHITEBOARD_SURFACE_ID),
        boardStrokes: whiteboardStrokeCount(debug, WHITEBOARD_SURFACE_ID)
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      mainObject: null,
      boardObject: "whiteboard",
      boardStrokes: 1
    });
  } finally {
    await host.close();
    await member.close();
    if (!guest.isClosed()) {
      await guest.close();
    }
    await rejoinedGuest?.close();
  }
});
