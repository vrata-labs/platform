import { createServer, type ServerResponse } from "node:http";
import { test, expect, observeScenePage } from "./scene-network-fixture";

// These tests use loopback HTTP only. No staging scenes or production credentials are needed.
test("scene network observer records a partial body before completion", async ({ page, sceneNetwork }) => {
  const chunk = Buffer.alloc(64 * 1024, 97);
  let pending: ServerResponse | undefined;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/assets/scenes/")) {
      response.writeHead(200, { "Content-Type": "model/gltf-binary", "Content-Length": chunk.length * 2 });
      response.write(chunk);
      pending = response;
    } else {
      response.end("<!doctype html><title>network observer</title>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_loopback_address");
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.evaluate(() => {
      Object.assign(window, { __VRATA_DEBUG__: { sceneBundleState: "fallback", sceneDebug: { loadStage: "asset_response_received" } } });
      void fetch("/assets/scenes/sense-hall2-v1/scene.glb?token=fixture-secret").then((response) => response.arrayBuffer());
    });
    const report = async () => (await sceneNetwork.snapshots())[0];
    await expect.poll(async () => (await report())?.requests?.[0]?.bodyBytes).toBe(chunk.length);
    const partial = await report();
    expect(partial.availability).toBe("ready");
    expect(partial.requests[0]).toMatchObject({ state: "pending", expectedBodyBytes: chunk.length * 2 });
    expect(partial.requests[0].lastDataMs).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => (await report())?.runtime?.loadStage).toBe("asset_response_received");
    pending!.end(chunk);
    await expect.poll(async () => (await report())?.requests?.[0]?.state).toBe("finished");
    const complete = await report();
    expect(complete.requests[0].bodyBytes).toBe(chunk.length * 2);
    // CDP completion and data notifications can carry slightly out-of-order timestamps.
    expect(complete.requests[0].finishedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(complete)).not.toContain("fixture-secret");
    expect(JSON.stringify(complete)).not.toContain("127.0.0.1");
  } finally {
    pending?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("scene network observer keeps independent manually created page reports after close", async ({ browser, sceneNetwork }) => {
  const server = createServer((request, response) => {
    response.end(request.url?.endsWith(".glb") ? "glb-test-bytes" : "<!doctype html><title>observer</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_loopback_address");
  const context = await browser.newContext();
  const pages = await Promise.all([observeScenePage(context.newPage()), observeScenePage(browser.newPage())]);
  try {
    for (const page of pages) {
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.evaluate(() => fetch("/assets/scenes/example/scene.glb").then((response) => response.arrayBuffer()).then(() => undefined));
    }
    await expect.poll(async () => (await sceneNetwork.snapshots()).filter((r) => r.requests[0]?.state === "finished").length).toBe(2);
    for (const page of pages) await page.close();
    const reports = await sceneNetwork.snapshots();
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.requests[0].bodyBytes)).toEqual([14, 14]);
    expect(reports.map((r) => r.availability)).toEqual(["ready", "ready"]);
  } finally {
    await context.close();
    for (const page of pages) if (!page.isClosed()) await page.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
