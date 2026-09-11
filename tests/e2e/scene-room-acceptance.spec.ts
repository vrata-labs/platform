import { createServer, type ServerResponse } from "node:http";
import type { Browser } from "@playwright/test";
import { test, expect, observeScenePage } from "./scene-network-fixture";
import { expectSceneRoomReady } from "./scene-room-acceptance";

const bundlePath = "/assets/scenes/acceptance-fixture/scene.json";
const adminToken = "loopback-contract-token";

type ClientMode = "normal" | "missing" | "wrong-url" | "missing-url" | "state-mismatch" | "bundle-state-mismatch";

// Synthetic runtime state follows an actual delayed HTTP body. This tests the
// acceptance helper, not GLTF rendering; no staging assets or secrets are used.
async function withSceneServer(
  browser: Browser,
  options: { seedLoaded?: boolean; publishLoaded?: boolean; autoRelease?: boolean; mode?: ClientMode },
  use: (fixture: {
    page: Awaited<ReturnType<typeof observeScenePage>>;
    newPage: () => ReturnType<typeof observeScenePage>;
    reads: () => number;
    received: () => number;
    release: (client: number) => void;
    run: (page: Awaited<ReturnType<typeof observeScenePage>>, requireLoadedState?: boolean, timeoutMs?: number, expectedBundleUrl?: string | RegExp) => Promise<void>;
  }) => Promise<void>
): Promise<void> {
  const chunk = Buffer.alloc(64 * 1024, 97);
  const pending = new Map<number, ServerResponse>();
  let navigations = 0;
  let diagnosticReads = 0;
  let assetRequests = 0;
  let hasLoaded = options.seedLoaded ?? false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const json = (body: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/rooms/fixture-room/manifest") {
      json({ sceneBundle: { url: bundlePath } });
    } else if (url.pathname === "/api/rooms/fixture-room/diagnostics") {
      if (request.headers["x-vrata-admin-token"] !== adminToken) {
        response.writeHead(401).end();
        return;
      }
      diagnosticReads += 1;
      json({ items: hasLoaded ? [{ sceneDebug: { state: "loaded", bundleUrl: bundlePath } }] : [] });
    } else if (url.pathname.endsWith("scene.glb")) {
      assetRequests += 1;
      response.writeHead(200, { "Content-Type": "model/gltf-binary", "Content-Length": chunk.length * 2 });
      response.write(chunk);
      if (options.autoRelease) response.end(chunk);
      else pending.set(Number(url.searchParams.get("client")), response);
    } else if (url.pathname === "/publish-loaded") {
      if (options.publishLoaded !== false) hasLoaded = true;
      response.end();
    } else if (url.pathname === "/rooms/fixture-room") {
      const client = ++navigations;
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<!doctype html><div id="room-name">Fixture room</div><script>
        const mode = ${JSON.stringify(options.mode ?? "normal")};
        const scene = { state: "fallback", bundleUrl: ${JSON.stringify(bundlePath)}, loadStage: "manifest_requested" };
        if (mode !== "missing") window.__VRATA_DEBUG__ = { sceneBundleState: "fallback", sceneDebug: scene };
        void (async () => {
          const response = await fetch("/assets/scenes/acceptance-fixture/scene.glb?client=${client}");
          scene.loadStage = "asset_response_received";
          await response.arrayBuffer();
          scene.state = mode === "state-mismatch" ? "fallback" : "loaded";
          scene.bundleUrl = mode === "wrong-url" ? "/assets/scenes/other/scene.json"
            : mode === "missing-url" ? null : new URL(scene.bundleUrl, location.href).href;
          scene.loadStage = "loaded";
          if (window.__VRATA_DEBUG__) window.__VRATA_DEBUG__.sceneBundleState = mode === "bundle-state-mismatch" ? "fallback" : "loaded";
          await fetch("/publish-loaded");
        })();
      </script>`);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_loopback_address");
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
  try {
    const newPage = () => observeScenePage(context.newPage());
    const page = await newPage();
    await use({
      page, newPage,
      reads: () => diagnosticReads,
      received: () => assetRequests,
      release(client) { pending.get(client)?.end(chunk); pending.delete(client); },
      run: (target, requireLoadedState = true, timeoutMs = 6000, expectedBundleUrl = bundlePath) => expectSceneRoomReady(
        target, context.request, { roomId: "fixture-room", timeoutMs, expectedBundleUrl, requireLoadedState }, adminToken
      )
    });
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function watch(promise: Promise<void>) {
  let state = "pending";
  const outcome = promise.then(() => { state = "accepted"; }, () => { state = "rejected"; });
  return { outcome, state: () => state };
}

test("stale history does not accept the current page before its delayed body finishes", async ({ browser }) => {
  await withSceneServer(browser, { seedLoaded: true }, async (f) => {
    const gate = watch(f.run(f.page));
    // Two real polls of the old successful history must not finish acceptance.
    await expect.poll(f.reads).toBeGreaterThanOrEqual(2);
    expect(f.received()).toBe(1);
    expect(gate.state()).toBe("pending");
    f.release(1);
    await gate.outcome;
    expect(gate.state()).toBe("accepted");
  });
});

test("one client's loaded history does not accept a second pending client", async ({ browser }) => {
  await withSceneServer(browser, {}, async (f) => {
    const first = watch(f.run(f.page));
    await expect.poll(f.received).toBe(1);
    f.release(1);
    await first.outcome;
    expect(first.state()).toBe("accepted");

    const previousReads = f.reads();
    const secondPage = await f.newPage();
    const second = watch(f.run(secondPage));
    await expect.poll(f.reads).toBeGreaterThanOrEqual(previousReads + 2);
    expect(f.received()).toBe(2);
    expect(second.state()).toBe("pending");
    f.release(2);
    await second.outcome;
    expect(second.state()).toBe("accepted");
  });
});

for (const mode of ["missing", "wrong-url", "missing-url", "state-mismatch", "bundle-state-mismatch"] as const) {
  test(`current-page evidence is required even with loaded server history: ${mode}`, async ({ browser }) => {
    await withSceneServer(browser, { seedLoaded: true, autoRelease: true, mode }, async (f) => {
      await expect(f.run(f.page, true, 1500)).rejects.toThrow();
      expect(f.reads()).toBeGreaterThan(0);
      expect(f.received()).toBe(1);
    });
  });
}

test("loaded page still requires server diagnostics for the expected scene", async ({ browser }) => {
  await withSceneServer(browser, { autoRelease: true, publishLoaded: false }, async (f) => {
    await expect(f.run(f.page, true, 1500)).rejects.toThrow();
    expect(await f.page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { sceneBundleState?: string } }).__VRATA_DEBUG__?.sceneBundleState)).toBe("loaded");
  });
});

test("a relative manifest and matching absolute page URL support the existing regex contract", async ({ browser }) => {
  await withSceneServer(browser, { autoRelease: true }, async (f) => {
    await f.run(f.page, true, 6000, /^\/assets\/scenes\/acceptance-fixture\/scene\.json$/);
  });
});

test("manifest-and-diagnostics-only checks do not claim full scene loading", async ({ browser }) => {
  await withSceneServer(browser, {}, async (f) => {
    await f.run(f.page, false);
    expect(f.reads()).toBe(1);
    expect(await f.page.evaluate(() => (window as Window & { __VRATA_DEBUG__?: { sceneBundleState?: string } }).__VRATA_DEBUG__?.sceneBundleState)).toBe("fallback");
    await expect(f.run(f.page, false, 1500, "/wrong-manifest.json")).rejects.toThrow();
  });
});
