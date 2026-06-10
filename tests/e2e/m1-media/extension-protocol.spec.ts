import { expect, test, type Page } from "@playwright/test";

type ExtensionDebug = {
  id?: string;
  enabled?: boolean;
  valid?: boolean;
  validationErrors?: string[];
  objectTypes?: Array<{
    objectType?: string;
    available?: boolean;
    missingCapabilities?: string[];
  }>;
};

type ExtensionProtocolDebug = {
  roomStateConnected?: boolean;
  access?: { role?: string; lastDeniedPermission?: string | null };
  surfaceInput?: { blockedReason?: string | null };
  mediaObjects?: {
    selectedSurfaceId?: string;
    availableObjectTypes?: string[];
    extensions?: ExtensionDebug[];
    blockedReason?: string | null;
    surfaces?: Array<{
      surfaceId?: string;
      activeObjectId?: string | null;
      activeObjectType?: string | null;
      allowedObjectTypes?: string[];
    }>;
    objects?: Array<{
      objectId?: string;
      type?: string;
      surfaceId?: string;
      state?: { clickCount?: number; lastInputEventId?: string | null };
      revision?: number;
    }>;
  };
};

function roomUrl(roomId: string, role: "guest" | "member" | "host") {
  const query = role === "guest" ? "debug=1" : `debug=1&role=${role}`;
  return `/rooms/${roomId}?${query}`;
}

async function readDebug(page: Page): Promise<ExtensionProtocolDebug | undefined> {
  return page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: ExtensionProtocolDebug }).__NOAH_DEBUG__);
}

async function waitForRoom(page: Page, role: "guest" | "member" | "host") {
  await expect.poll(async () => {
    const debug = await readDebug(page);
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null,
      hasExtensions: (debug?.mediaObjects?.extensions?.length ?? 0) > 0
    };
  }, {
    timeout: 15000,
    intervals: [500, 1000, 2000]
  }).toEqual({ connected: true, role, hasExtensions: true });
}

async function createExtensionTestCard(page: Page) {
  const sent = await page.evaluate(() => (window as Window & {
    __NOAH_TEST__?: { createExtensionTestCard: () => boolean };
  }).__NOAH_TEST__?.createExtensionTestCard() ?? false);
  expect(sent).toBe(true);
}

async function sendClick(page: Page) {
  const sent = await page.evaluate(() => (window as Window & {
    __NOAH_TEST__?: { sendDebugSurfaceInput: (input?: { kind?: string; u?: number; v?: number }) => boolean };
  }).__NOAH_TEST__?.sendDebugSurfaceInput({ kind: "click", u: 0.5, v: 0.5 }) ?? false);
  expect(sent).toBe(true);
}

test("M1.9 registry exposes internal extensions and creates a test extension object", async ({ page }) => {
  const roomId = `m1-extension-registry-${Date.now()}`;
  await page.goto(roomUrl(roomId, "host"));
  await waitForRoom(page, "host");

  const registry = await readDebug(page);
  const extensions = registry?.mediaObjects?.extensions ?? [];
  const extensionCard = extensions.find((extension) => extension.id === "noah.extension-test-card")?.objectTypes?.[0];
  const missingCapabilityCard = extensions.find((extension) => extension.id === "noah.missing-capability-demo")?.objectTypes?.[0];
  const disabledCard = extensions.find((extension) => extension.id === "noah.disabled-demo")?.objectTypes?.[0];

  expect(extensions.some((extension) => extension.id === "noah.whiteboard" && extension.valid && extension.enabled)).toBe(true);
  expect(extensionCard).toMatchObject({ objectType: "extension-test-card", available: true });
  expect(missingCapabilityCard).toMatchObject({ objectType: "missing-capability-extension-card", available: false });
  expect(missingCapabilityCard?.missingCapabilities).toContain("surface.render");
  expect(disabledCard).toMatchObject({ objectType: "disabled-extension-card", available: false });
  expect(registry?.mediaObjects?.availableObjectTypes).toContain("extension-test-card");
  expect(registry?.mediaObjects?.availableObjectTypes).not.toContain("disabled-extension-card");

  await createExtensionTestCard(page);

  await expect.poll(async () => {
    const debug = await readDebug(page);
    const surface = debug?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main");
    const object = debug?.mediaObjects?.objects?.find((item) => item.type === "extension-test-card");
    return {
      activeObjectType: surface?.activeObjectType ?? null,
      clickCount: object?.state?.clickCount ?? null,
      revision: object?.revision ?? null
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({ activeObjectType: "extension-test-card", clickCount: 0, revision: 0 });

  await sendClick(page);

  await expect.poll(async () => {
    const object = (await readDebug(page))?.mediaObjects?.objects?.find((item) => item.type === "extension-test-card");
    return {
      clickCount: object?.state?.clickCount ?? null,
      revision: object?.revision ?? null
    };
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toEqual({ clickCount: 1, revision: 1 });
});

test("M1.9 extension capability, enabled state, and action permissions are enforced", async ({ browser }) => {
  const roomId = `m1-extension-gates-${Date.now()}`;
  const host = await browser.newPage();
  const guest = await browser.newPage();
  try {
    await host.goto(roomUrl(roomId, "host"));
    await waitForRoom(host, "host");

    const missingCapabilitySent = await host.evaluate(() => (window as Window & {
      __NOAH_TEST__?: { createMissingCapabilityExtensionObject: () => boolean };
    }).__NOAH_TEST__?.createMissingCapabilityExtensionObject() ?? false);
    expect(missingCapabilitySent).toBe(true);
    await expect.poll(async () => (await readDebug(host))?.mediaObjects?.blockedReason ?? null, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toBe("missing-extension-capability");

    const disabledSent = await host.evaluate(() => (window as Window & {
      __NOAH_TEST__?: { createDisabledExtensionObject: () => boolean };
    }).__NOAH_TEST__?.createDisabledExtensionObject() ?? false);
    expect(disabledSent).toBe(true);
    await expect.poll(async () => (await readDebug(host))?.mediaObjects?.blockedReason ?? null, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toBe("extension-disabled");

    await createExtensionTestCard(host);
    await expect.poll(async () => {
      const surface = (await readDebug(host))?.mediaObjects?.surfaces?.find((item) => item.surfaceId === "debug-main");
      return surface?.activeObjectType ?? null;
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toBe("extension-test-card");

    await guest.goto(roomUrl(roomId, "guest"));
    await waitForRoom(guest, "guest");
    const guestSent = await guest.evaluate(() => (window as Window & {
      __NOAH_TEST__?: { sendDebugSurfaceInput: (input?: { kind?: string; u?: number; v?: number }) => boolean };
    }).__NOAH_TEST__?.sendDebugSurfaceInput({ kind: "click", u: 0.5, v: 0.5 }) ?? false);
    expect(guestSent).toBe(false);

    await expect.poll(async () => {
      const debug = await readDebug(guest);
      return {
        surfaceInputBlockedReason: debug?.surfaceInput?.blockedReason ?? null,
        objectCount: debug?.mediaObjects?.objects?.find((item) => item.type === "extension-test-card")?.state?.clickCount ?? null
      };
    }, {
      timeout: 10000,
      intervals: [500, 1000, 2000]
    }).toEqual({ surfaceInputBlockedReason: "missing-permission:surface.input", objectCount: 0 });
  } finally {
    await host.close();
    await guest.close();
  }
});
