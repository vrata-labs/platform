import { expect, test, type Page } from "@playwright/test";

type MultiSurfaceDebug = {
  roomStateConnected?: boolean;
  access?: { role?: string };
  screenShare?: { active?: boolean; localPublishing?: boolean; selectedSurfaceId?: string | null };
  whiteboard?: { active?: boolean; strokeCount?: number; surfaceId?: string | null };
  surfaceInput?: {
    lastEvent?: { surfaceId?: string | null; source?: string | null; kind?: string | null } | null;
  };
  mediaObjects?: {
    selectedSurfaceId?: string;
    surfaces?: Array<{ surfaceId?: string; activeObjectId?: string | null; activeObjectType?: string | null }>;
    objects?: Array<{ objectId?: string; type?: string; surfaceId?: string; revision?: number }>;
    blockedReason?: string | null;
  };
};

const MAIN_SURFACE_ID = "debug-main";
const WHITEBOARD_SURFACE_ID = "whiteboard-wall";
const LAPTOP_SURFACE_ID = "laptop-screen";

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

async function readDebug(page: Page): Promise<MultiSurfaceDebug | undefined> {
  return page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: MultiSurfaceDebug }).__NOAH_DEBUG__);
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

async function selectSurface(page: Page, surfaceId: string) {
  const selected = await page.evaluate((id) => (window as Window & {
    __NOAH_TEST__?: { selectMediaSurface: (surfaceId: string) => boolean };
  }).__NOAH_TEST__?.selectMediaSurface(id) ?? false, surfaceId);
  expect(selected).toBe(true);
}

async function sendSurfaceInput(page: Page, input: { surfaceId: string; source?: string; kind?: string; u?: number; v?: number }) {
  const sent = await page.evaluate((value) => (window as Window & {
    __NOAH_TEST__?: { sendDebugSurfaceInput: (input?: { surfaceId?: string; source?: string; kind?: string; u?: number; v?: number }) => boolean };
  }).__NOAH_TEST__?.sendDebugSurfaceInput(value) ?? false, input);
  expect(sent).toBe(true);
}

function surfaceObjectType(debug: MultiSurfaceDebug | undefined, surfaceId: string): string | null {
  return debug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === surfaceId)?.activeObjectType ?? null;
}

test("M1.8 screen share and whiteboard run on independent surfaces", async ({ browser }) => {
  const roomId = `m1-multi-surface-${Date.now()}`;
  const host = await browser.newPage();
  const member = await browser.newPage();
  try {
    await host.goto(roomUrl(roomId, "host", "sharemock=1"));
    await member.goto(roomUrl(roomId, "member"));
    await waitForKernel(host, "host");
    await waitForKernel(member, "member");

    await host.click("#start-share");
    await expect.poll(async () => {
      const debug = await readDebug(host);
      return {
        mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
        shareActive: debug?.screenShare?.active ?? false,
        shareSurface: debug?.screenShare?.selectedSurfaceId ?? null
      };
    }, {
      timeout: 15000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      mainObject: "screen-share",
      shareActive: true,
      shareSurface: MAIN_SURFACE_ID
    });

    await selectSurface(host, WHITEBOARD_SURFACE_ID);
    await expect(host.locator("#start-whiteboard")).toBeEnabled();
    await host.click("#start-whiteboard");

    await expect.poll(async () => {
      const debug = await readDebug(member);
      return {
        mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
        boardObject: surfaceObjectType(debug, WHITEBOARD_SURFACE_ID),
        objectCount: debug?.mediaObjects?.objects?.length ?? 0
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      mainObject: "screen-share",
      boardObject: "whiteboard",
      objectCount: 2
    });

    await sendSurfaceInput(member, { surfaceId: WHITEBOARD_SURFACE_ID, source: "xr-controller", kind: "click", u: 0.42, v: 0.58 });
    await expect.poll(async () => {
      const hostDebug = await readDebug(host);
      const memberDebug = await readDebug(member);
      return {
        hostStrokes: hostDebug?.whiteboard?.strokeCount ?? null,
        memberStrokes: memberDebug?.whiteboard?.strokeCount ?? null,
        inputSurface: memberDebug?.surfaceInput?.lastEvent?.surfaceId ?? null,
        inputSource: memberDebug?.surfaceInput?.lastEvent?.source ?? null
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      hostStrokes: 1,
      memberStrokes: 1,
      inputSurface: WHITEBOARD_SURFACE_ID,
      inputSource: "xr-controller"
    });

    await host.click("#stop-share");
    await expect.poll(async () => {
      const debug = await readDebug(member);
      return {
        mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
        boardObject: surfaceObjectType(debug, WHITEBOARD_SURFACE_ID),
        strokes: debug?.whiteboard?.strokeCount ?? null
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      mainObject: null,
      boardObject: "whiteboard",
      strokes: 1
    });

    await host.click("#clear-whiteboard");
    await expect.poll(async () => {
      const debug = await readDebug(member);
      return {
        mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
        boardObject: surfaceObjectType(debug, WHITEBOARD_SURFACE_ID),
        strokes: debug?.whiteboard?.strokeCount ?? null
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({
      mainObject: null,
      boardObject: "whiteboard",
      strokes: 0
    });
  } finally {
    await host.close();
    await member.close();
  }
});
