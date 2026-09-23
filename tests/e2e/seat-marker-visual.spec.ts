import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";

// Explicit canvas captures below are the visual evidence. Automatic trace canvas
// snapshots duplicate expensive software-WebGL readbacks for every API call.
// Keep call/source diagnostics without changing runtime rendering or test assertions.
test.use({ trace: process.env.PLAYWRIGHT_TRACE === "1"
  ? { mode: "retain-on-failure", screenshots: false, snapshots: false, sources: true }
  : "off" });

async function capture(page: Page, testInfo: TestInfo, name: string, selector = "#scene > canvas") {
  const dataUrl = await page.evaluate(selector => {
    const canvas = document.querySelector(selector);
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("marker_capture_canvas_missing");
    return canvas.toDataURL("image/png");
  }, selector);
  expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  await testInfo.attach(name, { body: Buffer.from(dataUrl.split(",")[1]!, "base64"), contentType: "image/png" });
}

// The component pass checks actual compiled materials/shaders independently of room lighting.
// It is deliberately labelled separately from the full application captures below.
test("seat marker component renders volume, forward chevron and state transitions", async ({ page }, testInfo) => {
  const runtimeRoot = resolve("apps/runtime-web/dist");
  const requireRuntime = createRequire(resolve("apps/runtime-web/package.json"));
  const threeRoot = dirname(requireRuntime.resolve("three"));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width: 640, height: 480 });
  await page.route("http://seat-marker.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      await route.fulfill({ contentType: "text/html", body: '<!doctype html><script type="importmap">{"imports":{"three":"/three/three.module.js"}}</script><script type="module" src="/entry.js"></script>' });
      return;
    }
    if (path === "/favicon.ico") { await route.fulfill({ status: 204 }); return; }
    let file: string | null = null;
    if (path === "/entry.js") file = resolve("tests/e2e/fixtures/seat-marker-browser.mjs");
    if (path.startsWith("/runtime/")) {
      const candidate = resolve(runtimeRoot, path.slice("/runtime/".length));
      if (candidate.startsWith(runtimeRoot + sep) && candidate.endsWith(".js")) file = candidate;
    }
    if (path === "/three/three.module.js" || path === "/three/three.core.js") file = resolve(threeRoot, path.slice("/three/".length));
    await route.fulfill(file ? { contentType: "text/javascript", body: await readFile(file) } : { status: 404, body: "not found" });
  });
  await page.goto("http://seat-marker.test/");
  await page.waitForFunction(() => (window as any).markerHarness);
  for (const light of [false, true]) {
    await page.evaluate(value => (window as any).markerHarness.setLight(value), light);
    for (const view of ["perspective", "side", "top"]) {
      await page.evaluate(name => (window as any).markerHarness.setView(name), view);
      await capture(page, testInfo, `component-${light ? "light" : "dark"}-${view}`, "canvas");
    }
  }
  await page.evaluate(() => {
    const h = (window as any).markerHarness;
    h.setLight(false); h.setView("perspective"); h.setState("hovered", 0); h.setState("hovered", 0.15);
  });
  const hovered = await page.evaluate(() => (window as any).markerHarness.snapshot());
  expect(hovered.opacity).toBeCloseTo(0.32);
  expect(hovered.calls).toBeGreaterThan(1);
  await capture(page, testInfo, "component-hovered", "canvas");
  await page.evaluate(() => (window as any).markerHarness.setState("pending", 0.3));
  await capture(page, testInfo, "component-pending", "canvas");
  for (const name of ["occupied", "current"]) {
    await page.evaluate(value => (window as any).markerHarness.setState(value, 1), name);
    expect(await page.evaluate(() => (window as any).markerHarness.snapshot())).toMatchObject({ visible: false, blocked: true, calls: 1 });
  }
  expect(errors).toEqual([]);
  await testInfo.attach("component-renderer", { body: JSON.stringify(hovered, null, 2), contentType: "application/json" });
});

for (const staging of [false, true]) test.describe(`${staging ? "@staging " : ""}seat markers in actual reference rooms`, () => {
  test.describe.configure({ mode: "serial" });
  let fixture: Pick<Awaited<ReturnType<typeof startReferenceTemplateFixture>>, "origin" | "close" | "fixtureFingerprint"> | undefined;
  const token = staging ? process.env.STAGING_ADMIN_TOKEN : "test-admin-token";
  test.beforeAll(async () => {
    test.setTimeout(120000);
    if (staging) {
      expect(token, "Staging checks need the existing authorized test credentials").toBeTruthy();
      const origin = process.env.BASE_URL!;
      expect(new URL(origin).protocol).toBe("https:");
      fixture = { origin, close: async () => {}, fixtureFingerprint: "published-staging" };
    } else if (process.env.VRATA_TEST_POSTGRES_URL) fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL);
  });
  test.afterAll(async () => { test.setTimeout(120000); await fixture?.close(); });

  for (const templateId of ["meeting-room-basic", "presentation-room-basic"]) {
    test(`${templateId}: centre ray, authoritative occupancy, hidden marker and release`, async ({ page, request, browser }, testInfo) => {
      test.skip(!fixture, "Local reference checks require VRATA_TEST_POSTGRES_URL (provided by CI)");
      test.setTimeout(300000);
      const headers = { "x-vrata-admin-token": token! };
      const response = await request.post(`${fixture!.origin}/api/rooms`, {
        headers, data: { tenantId: "demo-tenant", templateId, name: "Volumetric marker review" }
      });
      expect(response.status()).toBe(201);
      const room = await response.json();
      const roomUrl = `${room.roomLink}?debug=1&scenefit=0&onboard=0`;
      const observerContext = await browser.newContext({ viewport: { width: 640, height: 480 } });
      const observer = await observerContext.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      observer.on("pageerror", error => errors.push(error.message));
      try {
        await page.setViewportSize({ width: 640, height: 480 });
        const manifestResponse = page.waitForResponse(value => /\/scene\.json(?:[?#]|$)/.test(value.url()));
        await join(page, roomUrl);
        const { parseSceneBundleManifest } = await import(pathToFileURL(resolve("apps/runtime-web/dist/scene-bundle.js")).href);
        const manifest = parseSceneBundleManifest(await (await manifestResponse).json());
        const seat = manifest.anchors.seatAnchors[0] as Seat;
        expect(seat.id).toBeTruthy();
        await join(observer, roomUrl);
        const initial = await page.evaluate(() => {
          const d = (window as any).__VRATA_DEBUG__;
          return { participantId: d.participantId, root: d.localPose.root };
        });
        const reviewPose = seatReviewPose(seat);
        for (const client of [page, observer]) {
          expect(await client.evaluate(pose => (window as any).__VRATA_TEST__.setSceneReviewPose(pose), reviewPose)).toBe(true);
          await client.mouse.move(0, 0);
        }
        await waitFrames(page);
        await capture(observer, testInfo, "room-free-perspective");
        // This is a real pointer ray through the marker centre, not forcedSeatId.
        await page.mouse.move(320, 240);
        await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__.interactionRay.seatId)).toBe(seat.id);
        await page.waitForTimeout(200); // Settle the explicitly specified 150ms material transition.
        await capture(page, testInfo, "room-hovered-perspective");
        await page.evaluate(() => (window as any).__VRATA_TEST__.confirmInteraction());
        await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__.currentSeatId), { timeout: 15000 }).toBe(seat.id);
        await expect.poll(() => observer.evaluate(id => (window as any).__VRATA_DEBUG__.seatOccupancy[id], seat.id), { timeout: 15000 }).toBe(initial.participantId);
        await capture(observer, testInfo, "room-occupied-same-view");
        await capture(page, testInfo, "room-own-seated-view");
        const observerPose = await observer.evaluate(() => (window as any).__VRATA_DEBUG__.localPose.root);
        await observer.mouse.move(320, 240);
        await expect.poll(() => observer.evaluate(() => (window as any).__VRATA_DEBUG__.interactionRay.seatId)).toBe(null);
        await observer.evaluate(() => (window as any).__VRATA_TEST__.confirmInteraction());
        await waitFrames(observer);
        expect(await observer.evaluate(() => (window as any).__VRATA_DEBUG__.currentSeatId)).toBe(null);
        expect(await observer.evaluate(() => (window as any).__VRATA_DEBUG__.localPose.root)).toEqual(observerPose);
        expect(await page.evaluate(root => (window as any).__VRATA_TEST__.teleportToFloor(root.x, root.z), initial.root)).toBe(true);
        await expect.poll(() => observer.evaluate(id => (window as any).__VRATA_DEBUG__.seatOccupancy[id] ?? null, seat.id), { timeout: 15000 }).toBe(null);
        await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__.currentSeatId), { timeout: 15000 }).toBe(null);
        await observer.mouse.move(0, 0);
        await waitFrames(observer);
        await capture(observer, testInfo, "room-released-same-view");
        await testInfo.attach("room-review-settings", { body: JSON.stringify({ staging, templateId, seat, reviewPose, initial, fixture: fixture!.fixtureFingerprint, errors }, null, 2), contentType: "application/json" });
        expect(errors).toEqual([]);
      } finally {
        await observerContext.close();
        // The per-test request fixture can already be closed after a test timeout.
        const deleted = await fetch(new URL(`/api/rooms/${room.roomId}`, fixture!.origin), {
          method: "DELETE", headers, signal: AbortSignal.timeout(15000)
        });
        expect([200, 204, 404]).toContain(deleted.status);
      }
    });
  }
});

interface Seat { id: string; yaw: number; seatHeight: number; position: { x: number; y: number; z: number } }
function seatReviewPose(seat: Seat) {
  // Stand just outside the first chair, avoiding the meeting table. Compensate
  // the real pitch->camera(0,1.6,0) hierarchy instead of just subtracting 1.6 from Y.
  const forward = { x: -Math.sin(seat.yaw), z: -Math.cos(seat.yaw) };
  const right = { x: Math.cos(seat.yaw), z: -Math.sin(seat.yaw) };
  const eye = { x: seat.position.x + forward.x * 0.5 + right.x * 0.75,
    y: seat.position.y + seat.seatHeight + 1.05, z: seat.position.z + forward.z * 0.5 + right.z * 0.75 };
  const delta = { x: seat.position.x - eye.x, y: seat.position.y + seat.seatHeight + 0.163 - eye.y, z: seat.position.z - eye.z };
  const yaw = Math.atan2(-delta.x, -delta.z), pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
  return { position: { x: eye.x - Math.sin(yaw) * Math.sin(pitch) * 1.6,
    y: eye.y - Math.cos(pitch) * 1.6, z: eye.z - Math.cos(yaw) * Math.sin(pitch) * 1.6 }, yaw, pitch, fovDegrees: 52 };
}
async function join(page: Page, url: string) {
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90000 }).toBe("loaded");
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__.sceneDebug.missingAssets)).toEqual([]);
  await page.evaluate(() => {
    const hud = document.querySelector("details.hud");
    if (hud instanceof HTMLDetailsElement) hud.open = false;
  });
}
async function waitFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
