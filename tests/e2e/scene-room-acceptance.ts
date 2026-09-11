import { expect, type APIRequestContext, type Page } from "@playwright/test";

export type ExpectedBundleUrl = string | RegExp;

function bundleUrlMatches(actual: string | undefined, expected: ExpectedBundleUrl): boolean {
  if (!actual) return false;
  return typeof expected === "string" ? actual === expected : expected.test(actual);
}

type DiagnosticsPayload = {
  items: Array<{
    note?: string;
    sceneDebug?: {
      state?: string;
      bundleUrl?: string;
    };
  }>;
};

async function getJsonWithRetry<T>(request: APIRequestContext, path: string, timeoutMs: number, headers?: Record<string, string>): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await request.get(path, headers ? { headers } : undefined);
      if (!response.ok()) {
        throw new Error(`http_${response.status()}`);
      }
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("staging_request_failed");
}

async function getDiagnosticsWithRetry(request: APIRequestContext, roomId: string, timeoutMs: number, adminToken: string): Promise<DiagnosticsPayload> {
  return getJsonWithRetry<DiagnosticsPayload>(request, `/api/rooms/${roomId}/diagnostics`, timeoutMs, {
    "x-vrata-admin-token": adminToken
  });
}

export async function expectSceneRoomReady(
  page: Page,
  request: APIRequestContext,
  room: { roomId: string; timeoutMs: number; expectedBundleUrl: ExpectedBundleUrl; requireLoadedState: boolean },
  adminToken: string
): Promise<void> {
  const { roomId, timeoutMs, expectedBundleUrl, requireLoadedState } = room;
  await page.goto(`/rooms/${roomId}`);
  await expect(page.locator("#room-name")).not.toContainText("Loading room", { timeout: timeoutMs });

  const manifest = await getJsonWithRetry<{ sceneBundle?: { url?: string } }>(request, `/api/rooms/${roomId}/manifest`, timeoutMs);
  expect(bundleUrlMatches(manifest.sceneBundle?.url, expectedBundleUrl)).toBeTruthy();
  const loadedBundleUrl = manifest.sceneBundle?.url;
  expect(loadedBundleUrl).toBeTruthy();

  if (!requireLoadedState) {
    const diagnostics = await getDiagnosticsWithRetry(request, roomId, timeoutMs, adminToken);
    expect(Array.isArray(diagnostics.items)).toBeTruthy();
    return;
  }

  await expect.poll(async () => {
    const diagnostics = await getDiagnosticsWithRetry(request, roomId, timeoutMs, adminToken);
    const loadedItem = diagnostics.items.find((item) =>
      item.sceneDebug?.bundleUrl === loadedBundleUrl && item.sceneDebug?.state === "loaded"
    );
    // Room history can belong to an earlier visit or another client. It is not
    // evidence that this page has finished loading the manifest's scene.
    const currentPage = await page.evaluate((expectedUrl) => {
      const debug = (window as Window & {
        __VRATA_DEBUG__?: {
          sceneBundleState?: string;
          sceneDebug?: { state?: string; bundleUrl?: string | null };
        };
      }).__VRATA_DEBUG__;
      let currentBundleMatches = false;
      if (debug?.sceneDebug?.bundleUrl && expectedUrl) {
        try {
          currentBundleMatches = new URL(debug.sceneDebug.bundleUrl, location.href).href
            === new URL(expectedUrl, location.href).href;
        } catch { /* A missing or invalid URL cannot establish scene identity. */ }
      }
      return {
        currentPageLoaded: debug?.sceneBundleState === "loaded" && debug.sceneDebug?.state === "loaded",
        currentBundleMatches
      };
    }, loadedBundleUrl);
    return {
      ...currentPage,
      loaded: loadedItem !== undefined,
      state: loadedItem?.sceneDebug?.state ?? null,
      bundleUrl: loadedItem?.sceneDebug?.bundleUrl ?? null
    };
  }, {
    timeout: timeoutMs,
    intervals: [1000, 2000, 3000, 5000]
  }).toEqual({
    currentPageLoaded: true,
    currentBundleMatches: true,
    loaded: true,
    state: "loaded",
    bundleUrl: loadedBundleUrl
  });
}

