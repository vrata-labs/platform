import { expect, test, type Page } from "@playwright/test";

type MultiSurfaceDebug = {
  roomStateConnected?: boolean;
  sceneBundleState?: string;
  access?: { role?: string };
  screenShare?: { active?: boolean; localPublishing?: boolean; selectedSurfaceId?: string | null };
  whiteboard?: { active?: boolean; strokeCount?: number; surfaceId?: string | null };
  surfaceInput?: {
    lastEvent?: { surfaceId?: string | null; source?: string | null; kind?: string | null } | null;
  };
  mediaObjects?: {
    selectedSurfaceId?: string;
    surfaces?: Array<{ surfaceId?: string; activeObjectId?: string | null; activeObjectType?: string | null; runtimeVisible?: boolean; textureId?: number | null }>;
    objects?: Array<{ objectId?: string; type?: string; surfaceId?: string; revision?: number; state?: { strokes?: unknown[]; status?: string } }>;
    blockedReason?: string | null;
  };
};

type TextureSample = { samples: Array<[number, number, number]> };

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
  return page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: MultiSurfaceDebug }).__VRATA_DEBUG__);
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
    __VRATA_TEST__?: { selectMediaSurface: (surfaceId: string) => boolean };
  }).__VRATA_TEST__?.selectMediaSurface(id) ?? false, surfaceId);
  expect(selected).toBe(true);
}

async function sendSurfaceInput(page: Page, input: { surfaceId: string; source?: string; kind?: string; u?: number; v?: number }) {
  const sent = await page.evaluate((value) => (window as Window & {
    __VRATA_TEST__?: { sendDebugSurfaceInput: (input?: { surfaceId?: string; source?: string; kind?: string; u?: number; v?: number }) => boolean };
  }).__VRATA_TEST__?.sendDebugSurfaceInput(value) ?? false, input);
  expect(sent).toBe(true);
}

async function sendSurfaceStroke(page: Page, surfaceId: string, points: Array<{ u: number; v: number }>) {
  expect(points.length).toBeGreaterThanOrEqual(2);
  await sendSurfaceInput(page, { surfaceId, kind: "pointer-down", ...points[0]! });
  for (const point of points.slice(1, -1)) {
    await sendSurfaceInput(page, { surfaceId, kind: "pointer-move", ...point });
  }
  await sendSurfaceInput(page, { surfaceId, kind: "pointer-up", ...points[points.length - 1]! });
}

function surfaceObjectType(debug: MultiSurfaceDebug | undefined, surfaceId: string): string | null {
  return debug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === surfaceId)?.activeObjectType ?? null;
}

function surfaceRuntimeVisible(debug: MultiSurfaceDebug | undefined, surfaceId: string): boolean {
  return debug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === surfaceId)?.runtimeVisible === true;
}

function surfaceTextureId(debug: MultiSurfaceDebug | undefined, surfaceId: string): number | null {
  return debug?.mediaObjects?.surfaces?.find((surface) => surface.surfaceId === surfaceId)?.textureId ?? null;
}

function whiteboardStrokeCount(debug: MultiSurfaceDebug | undefined, surfaceId: string): number | null {
  const object = debug?.mediaObjects?.objects?.find((item) => item.type === "whiteboard" && item.surfaceId === surfaceId);
  return object?.state?.strokes?.length ?? null;
}

function activeScreenShareCount(debug: MultiSurfaceDebug | undefined): number {
  return debug?.mediaObjects?.objects?.filter((item) => item.type === "screen-share" && item.state?.status === "active").length ?? 0;
}

function blueStrokeSampleCount(sample: TextureSample | null): number {
  return sample?.samples.filter(([r, g, b]) => b > 150 && r < 120 && g < 170).length ?? 0;
}

async function sampleSurfaceBlueStrokeCount(page: Page, surfaceId: string, center: { u: number; v: number }): Promise<number> {
  const sample = await page.evaluate((value) => (window as Window & {
    __VRATA_TEST__?: {
      sampleMediaSurfaceTexture: (surfaceId: string, center: { u: number; v: number }, size?: { width: number; height: number }) => TextureSample | null;
    };
  }).__VRATA_TEST__?.sampleMediaSurfaceTexture(value.surfaceId, value.center, { width: 0.18, height: 0.03 }) ?? null, { surfaceId, center });
  return blueStrokeSampleCount(sample);
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

test("M1.8 whiteboards run independently on any default surface", async ({ page }) => {
  const roomId = `m1-multi-whiteboard-${Date.now()}`;

  await page.goto(roomUrl(roomId, "host"));
  await waitForKernel(page, "host");

  await selectSurface(page, MAIN_SURFACE_ID);
  await expect(page.locator("#start-whiteboard")).toBeEnabled();
  await page.click("#start-whiteboard");

  await selectSurface(page, LAPTOP_SURFACE_ID);
  await expect(page.locator("#start-whiteboard")).toBeEnabled();
  await page.click("#start-whiteboard");

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
      laptopObject: surfaceObjectType(debug, LAPTOP_SURFACE_ID),
      objectCount: debug?.mediaObjects?.objects?.length ?? 0
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    mainObject: "whiteboard",
    laptopObject: "whiteboard",
    objectCount: 2
  });

  await sendSurfaceStroke(page, MAIN_SURFACE_ID, [{ u: 0.22, v: 0.34 }, { u: 0.34, v: 0.34 }, { u: 0.46, v: 0.34 }]);
  await sendSurfaceStroke(page, LAPTOP_SURFACE_ID, [{ u: 0.54, v: 0.66 }, { u: 0.66, v: 0.66 }, { u: 0.78, v: 0.66 }]);

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      mainStrokes: whiteboardStrokeCount(debug, MAIN_SURFACE_ID),
      laptopStrokes: whiteboardStrokeCount(debug, LAPTOP_SURFACE_ID)
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    mainStrokes: 1,
    laptopStrokes: 1
  });

  await expect.poll(async () => {
    const [mainOwnStroke, mainOtherStroke, laptopOwnStroke, laptopOtherStroke] = await Promise.all([
      sampleSurfaceBlueStrokeCount(page, MAIN_SURFACE_ID, { u: 0.34, v: 0.34 }),
      sampleSurfaceBlueStrokeCount(page, MAIN_SURFACE_ID, { u: 0.66, v: 0.66 }),
      sampleSurfaceBlueStrokeCount(page, LAPTOP_SURFACE_ID, { u: 0.66, v: 0.66 }),
      sampleSurfaceBlueStrokeCount(page, LAPTOP_SURFACE_ID, { u: 0.34, v: 0.34 })
    ]);
    return {
      mainOwnStroke: mainOwnStroke >= 2,
      mainOtherStroke: mainOtherStroke <= 1,
      laptopOwnStroke: laptopOwnStroke >= 2,
      laptopOtherStroke: laptopOtherStroke <= 1
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    mainOwnStroke: true,
    mainOtherStroke: true,
    laptopOwnStroke: true,
    laptopOtherStroke: true
  });
});

test("M1.8 screen shares run independently on any default surface", async ({ page }) => {
  const roomId = `m1-multi-screen-share-${Date.now()}`;

  await page.goto(roomUrl(roomId, "host", "sharemock=1"));
  await waitForKernel(page, "host");

  await selectSurface(page, MAIN_SURFACE_ID);
  await expect(page.locator("#start-share")).toBeEnabled();
  await page.click("#start-share");

  await selectSurface(page, LAPTOP_SURFACE_ID);
  await expect(page.locator("#start-share")).toBeEnabled();
  await page.click("#start-share");

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
      laptopObject: surfaceObjectType(debug, LAPTOP_SURFACE_ID),
      activeShares: activeScreenShareCount(debug)
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    mainObject: "screen-share",
    laptopObject: "screen-share",
    activeShares: 2
  });

  await selectSurface(page, LAPTOP_SURFACE_ID);
  await expect(page.locator("#stop-share")).toBeEnabled();
  await page.click("#stop-share");

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
      laptopObject: surfaceObjectType(debug, LAPTOP_SURFACE_ID),
      activeShares: activeScreenShareCount(debug)
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    mainObject: "screen-share",
    laptopObject: null,
    activeShares: 1
  });
});

test("M1.8 remote browsers run independently on any default surface", async ({ page }) => {
  const roomId = `m1-multi-browser-${Date.now()}`;

  await page.goto(roomUrl(roomId, "host"));
  await waitForKernel(page, "host");

  await selectSurface(page, MAIN_SURFACE_ID);
  await expect(page.locator("#open-remote-browser")).toBeEnabled();
  await page.fill("#remote-browser-url", "/remote-browser-demo.html?surface=main");
  await page.click("#open-remote-browser");

  await selectSurface(page, LAPTOP_SURFACE_ID);
  await expect(page.locator("#open-remote-browser")).toBeEnabled();
  await page.fill("#remote-browser-url", "/remote-browser-demo.html?surface=laptop");
  await page.click("#open-remote-browser");

  await expect.poll(async () => {
    const debug = await readDebug(page);
    const mainTextureId = surfaceTextureId(debug, MAIN_SURFACE_ID);
    const laptopTextureId = surfaceTextureId(debug, LAPTOP_SURFACE_ID);
    return {
      mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
      laptopObject: surfaceObjectType(debug, LAPTOP_SURFACE_ID),
      hasSeparateTextures: Boolean(mainTextureId && laptopTextureId && mainTextureId !== laptopTextureId)
    };
  }, {
    timeout: 30000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    mainObject: "remote-browser",
    laptopObject: "remote-browser",
    hasSeparateTextures: true
  });

  await selectSurface(page, LAPTOP_SURFACE_ID);
  await expect(page.locator("#stop-remote-browser")).toBeEnabled();
  await page.click("#stop-remote-browser");

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      mainObject: surfaceObjectType(debug, MAIN_SURFACE_ID),
      laptopObject: surfaceObjectType(debug, LAPTOP_SURFACE_ID)
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    mainObject: "remote-browser",
    laptopObject: null
  });

  await selectSurface(page, MAIN_SURFACE_ID);
  await expect(page.locator("#stop-remote-browser")).toBeEnabled();
  await page.click("#stop-remote-browser");
});

test("M1.8 media surfaces remain visible after a scene bundle loads", async ({ page, request }) => {
  const roomResponse = await request.post("/api/rooms", {
    headers: {
      "x-vrata-admin-token": process.env.STAGING_ADMIN_TOKEN ?? "test-admin-token"
    },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: `M1.8 Scene Surface Room ${Date.now()}`,
      sceneBundleUrl: "/assets/scenes/the-office-v1/scene.json"
    }
  });
  expect(roomResponse.ok()).toBeTruthy();
  const room = (await roomResponse.json()) as { roomLink: string };

  await page.goto(`${room.roomLink}?debug=1&role=host`);

  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      sceneBundleState: debug?.sceneBundleState ?? null,
      mainVisible: surfaceRuntimeVisible(debug, MAIN_SURFACE_ID),
      whiteboardVisible: surfaceRuntimeVisible(debug, WHITEBOARD_SURFACE_ID),
      laptopVisible: surfaceRuntimeVisible(debug, LAPTOP_SURFACE_ID)
    };
  }, {
    timeout: 20000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    sceneBundleState: "loaded",
    mainVisible: true,
    whiteboardVisible: true,
    laptopVisible: true
  });
});
