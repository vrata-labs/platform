import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { hardwareRenderingDecision, readWebglRenderer, requireHardwareRendering } from "./hardware-rendering";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";
import { observeReferenceTest } from "./reference-test-observation";
import { captureRoomAuthority, type RoomAuthorityCapture } from "./room-state-observation";
import { isOwnSeatProof, ownSeatProof, type OwnSeatClient } from "./seat-marker-proof";
import { finishReleasedAvatar, observeReleasedAvatar } from "./seat-release-observation";
import { observeSeatedAvatar } from "./seat-occupied-observation";
import { cleanupAll } from "./test-cleanup";

const observations = new Map<Page, ReturnType<typeof observeReferenceTest>>();
const raySamples: unknown[] = [];
function observation(page: Page) {
  let value = observations.get(page);
  if (!value) { value = observeReferenceTest(page); observations.set(page, value); }
  return value;
}
async function attachPhaseDiagnostics(testInfo: TestInfo, name: string) {
  const clients = [...observations.values()].map(value => value.snapshot());
  await testInfo.attach(name, { body: JSON.stringify({ clients, raySamples }), contentType: "application/json" });
}
test.beforeEach(() => { observations.clear(); raySamples.length = 0; });
test.afterEach(async ({}, testInfo) => {
  for (const value of observations.values()) value.stop();
  await attachPhaseDiagnostics(testInfo, "marker-phase-diagnostics");
});

// Explicit canvas captures below are the visual evidence. Automatic trace canvas
// snapshots duplicate expensive software-WebGL readbacks for every API call.
// Keep call/source diagnostics without changing runtime rendering or test assertions.
test.use({ trace: process.env.PLAYWRIGHT_TRACE === "1"
  ? { mode: "retain-on-failure", screenshots: false, snapshots: false, sources: true }
  : "off" });

async function capture(page: Page, testInfo: TestInfo, name: string, selector = "#scene > canvas") {
  const dataUrl = await observation(page).measure("visual-capture", () => page.evaluate(selector => {
    const canvas = document.querySelector(selector);
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("marker_capture_canvas_missing");
    return canvas.toDataURL("image/png");
  }, selector));
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
    // Each cause must hide a visible marker independently, not inherit occupied's hidden state.
    await page.evaluate(() => (window as any).markerHarness.setState("free", 1));
    const visible = await page.evaluate(() => (window as any).markerHarness.snapshot());
    expect(visible).toMatchObject({ visible: true, blocked: false });
    expect(visible.state).toMatchObject({ currentSeatId: null, occupancy: {} });
    expect(visible.calls).toBeGreaterThan(1);
    await capture(page, testInfo, `component-before-${name}`, "canvas");
    await page.evaluate(value => (window as any).markerHarness.setState(value, 1), name);
    const hidden = await page.evaluate(() => (window as any).markerHarness.snapshot());
    expect(hidden).toMatchObject({ visible: false, blocked: true, calls: 1 });
    expect(hidden.state).toMatchObject(name === "current"
      ? { currentSeatId: "seat", occupancy: {} } : { currentSeatId: null, occupancy: { seat: "other" } });
    await capture(page, testInfo, `component-${name}-hidden`, "canvas");
    await testInfo.attach(`component-${name}-proof`, { body: JSON.stringify({ cause: name, visible, hidden }), contentType: "application/json" });
  }
  expect(errors).toEqual([]);
  await testInfo.attach("component-renderer", { body: JSON.stringify(hovered, null, 2), contentType: "application/json" });
});

// The local fixture renders the same pinned reference assets; seat-marker-checks.yml also guards this path.
for (const staging of [false]) test.describe(`${staging ? "@staging " : ""}seat markers in actual reference rooms`, () => {
  test.skip(staging && process.env.VRATA_REFERENCE_CATALOG_ACTIVE !== "1",
    "Wave 2 compatibility deployment precedes reference activation");
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

  // Independent default-suite checks share setup, not a renderer/readback queue.
  // Both still use actual scenes and two live clients; visual is never a tiny fixture.
  for (const templateId of ["meeting-room-basic", "presentation-room-basic"]) for (const visual of [false, true]) {
    test(`${templateId}: ${visual ? "visual free, hovered, occupied, own and released views" : "centre ray, authoritative occupancy, blocked interaction and release"}`, async ({ page, request, browser, launchOptions, headless, channel }, testInfo) => {
      test.skip(!fixture, "Local reference checks require VRATA_TEST_POSTGRES_URL (provided by CI)");
      test.setTimeout(300000);
      // The 16-RAF release readiness inside the 15s budget needs hardware WebGL; decided
      // before the room exists, so nothing below changes with the renderer.
      if (visual) await skipUnlessHardwareRendering(page, testInfo);
      const headers = { "x-vrata-admin-token": token! };
      const response = await request.post(`${fixture!.origin}/api/rooms`, {
        headers, data: { tenantId: "demo-tenant", templateId, name: "Volumetric marker review" }
      });
      expect(response.status()).toBe(201);
      const room = await response.json();
      const roomUrl = `${room.roomLink}?debug=1&scenefit=0&onboard=0`;
      let observerBrowser: Browser | undefined;
      let ownAuthority: RoomAuthorityCapture | undefined;
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        // Isolate participants' software-GPU queues while both clients render.
        // See docs/reviews/2026-09-28-seat-marker-gpu-profile.md for the measured
        // shared-process stalls. Resolution, runtime and interaction deadlines stay intact.
        observerBrowser = await browser.browserType().launch({ ...launchOptions, headless, channel });
        const observer = await observerBrowser.newPage({ viewport: { width: 640, height: 480 } });
        observer.on("pageerror", error => errors.push(error.message));
        await page.setViewportSize({ width: 640, height: 480 });
        const manifestResponse = page.waitForResponse(value => /\/scene\.json(?:[?#]|$)/.test(value.url()));
        if (visual) ownAuthority = await captureRoomAuthority(page);
        await join(page, roomUrl);
        // Discovery runs before workspace builds. Load the shipping ESM parser
        // only in the running scenario, like the reference fixture's storage.
        const { parseSceneBundleManifest }: typeof import("../../apps/runtime-web/src/scene-bundle.js") =
          await import(pathToFileURL(resolve("apps/runtime-web/dist/scene-bundle.js")).href);
        const manifest = parseSceneBundleManifest(await (await manifestResponse).json());
        const seat = manifest.anchors!.seatAnchors[0] as Seat;
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
        if (visual) await waitFrames(observer);
        const fixedReviewView = visual ? await readReviewView(observer) : null;
        if (visual) await capture(observer, testInfo, "room-free-perspective");
        // This is a real pointer ray through the marker centre, not forcedSeatId.
        await page.mouse.move(320, 240);
        await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__.interactionRay.seatId)).toBe(seat.id);
        if (visual) {
          await page.waitForTimeout(200); // Settle the explicitly specified 150ms material transition.
          await capture(page, testInfo, "room-hovered-perspective");
        }
        const beforeClaim = ownAuthority?.snapshot();
        const claimBoundary = { generation: ownAuthority?.generation() ?? 0, sequence: beforeClaim?.sequence ?? 0 };
        await page.evaluate(() => (window as any).__VRATA_TEST__.confirmInteraction());
        if (visual) {
          await expect.poll(async () => isOwnSeatProof(ownSeatProof(await readOwnSeatClient(page, seat.id),
            ownAuthority!.snapshot(), seat, claimBoundary)), { timeout: 15000 }).toBe(true);
        } else await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__.currentSeatId), { timeout: 15000 }).toBe(seat.id);
        await expect.poll(() => observer.evaluate(id => (window as any).__VRATA_DEBUG__.seatOccupancy[id], seat.id), { timeout: 15000 }).toBe(initial.participantId);
        if (visual) {
          // The real seated lock must still hold after frame execution, not a transient pose.
          await waitFrames(page);
          const proof = ownSeatProof(await readOwnSeatClient(page, seat.id), ownAuthority!.snapshot(), seat, claimBoundary);
          expect(isOwnSeatProof(proof)).toBe(true);
          expect(proof.client.participantId).toBe(initial.participantId);
          await testInfo.attach("room-own-seat-authority-proof", { body: JSON.stringify(proof), contentType: "application/json" });
          // An occupied chair needs the seated participant DRAWN there for the observer, not
          // only a received pose and a hidden marker. Normal playback delay is allowed; a
          // stale playback timeline (seconds behind received poses) fails here. The drawn body must
          // rest on the manifest cushion, not sink a standing-height capsule through the seat.
          const cushionY = seat.position.y + seat.seatHeight;
          const occupied = await observer.evaluate(observeSeatedAvatar, { participantId: initial.participantId,
            seatedRoot: proof.client.root, cushionY, timeoutMs: 15000, maxLagFrames: 30, maxLagMs: 1000 });
          await testInfo.attach("room-occupied-readiness", { body: JSON.stringify(occupied.evidence), contentType: "application/json" });
          expect(occupied.error).toBeNull();
          expect(await readReviewView(observer)).toEqual(fixedReviewView);
          await capture(observer, testInfo, "room-occupied-same-view");
          const drawn = await observer.evaluate(id => (window as any).__VRATA_DEBUG__.remoteParticipants
            .find((value: any) => value.participantId === id), initial.participantId);
          expect(drawn?.renderedBody?.visible, "seated avatar is drawn for the observer").toBe(true);
          expect(Math.hypot(drawn.renderedBody.x - drawn.body.x, drawn.renderedBody.y - drawn.body.y,
            drawn.renderedBody.z - drawn.body.z), "seated avatar stays drawn at the seat in the PNG").toBeLessThan(0.05);
          // Debug coordinates are rounded to millimetres.
          expect(Math.abs(drawn.seatCushionY - cushionY), "observer resolves the seated participant's cushion from the scene").toBeLessThanOrEqual(0.0006);
          expect(drawn.renderedBody.bottomY, "seated body bottom is not below the cushion").toBeGreaterThanOrEqual(cushionY - 0.01);
          expect(drawn.renderedBody.bottomY, "seated body rests on the cushion").toBeLessThanOrEqual(cushionY + 0.03);
          expect(drawn.renderedBody.topY, "seated body stays under the drawn head").toBeLessThan(drawn.head.y);
          // Own hiding is proved independently by component-current-hidden plus the
          // real current-seat/authority DTO above. A floor-only seated PNG proves neither.
        } else {
          const observerPose = await observer.evaluate(() => (window as any).__VRATA_DEBUG__.localPose.root);
          await observer.mouse.move(320, 240);
          await expect.poll(async () => {
            const sample = await observation(observer).measure("occupied-ray", () => observer.evaluate(({ seatId, participantId }) => {
              const d = (window as any).__VRATA_DEBUG__;
              // Only the predicate's own evaluation supplies this snapshot. No extra
              // page call is queued after a 5s timeout; pending latency stays in Node.
              return { seatId: d.interactionRay.seatId, active: d.interactionRay.active,
                mode: d.interactionRay.mode, targetKind: d.interactionRay.targetKind,
                origin: d.interactionRay.origin, direction: d.interactionRay.direction,
                occupiedByExpected: d.seatOccupancy[seatId] === participantId,
                currentSeatId: d.currentSeatId, root: d.localPose.root };
            }, { seatId: seat.id, participantId: initial.participantId }));
            raySamples.push(sample); if (raySamples.length > 8) raySamples.shift();
            return sample.seatId;
          }, { timeout: 5000 }).toBe(null);
          await observer.evaluate(() => (window as any).__VRATA_TEST__.confirmInteraction());
          await waitFrames(observer);
          expect(await observer.evaluate(() => (window as any).__VRATA_DEBUG__.currentSeatId)).toBe(null);
          expect(await observer.evaluate(() => (window as any).__VRATA_DEBUG__.localPose.root)).toEqual(observerPose);
        }
        const previousPoseSeq = visual ? await observer.evaluate(id =>
          (window as any).__VRATA_DEBUG__.remoteAvatarParticipants.find((value: any) => value.participantId === id)?.lastPoseSeq ?? -1,
        initial.participantId) : -1;
        // Visual readiness shares the existing release budget; it gets no extra deadline.
        const releaseDeadline = Date.now() + 15000;
        const releaseTimeout = () => visual ? Math.max(1, releaseDeadline - Date.now()) : 15000;
        expect(await page.evaluate(root => (window as any).__VRATA_TEST__.teleportToFloor(root.x, root.z), initial.root)).toBe(true);
        await expect.poll(() => observer.evaluate(id => (window as any).__VRATA_DEBUG__.seatOccupancy[id] ?? null, seat.id), { timeout: releaseTimeout() }).toBe(null);
        await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__.currentSeatId), { timeout: releaseTimeout() }).toBe(null);
        await observer.mouse.move(0, 0);
        await waitFrames(observer);
        if (visual) {
          const remainingMs = releaseDeadline - Date.now();
          expect(remainingMs, "Release capture must not extend the authority deadline").toBeGreaterThan(0);
          const release = await observer.evaluate(observeReleasedAvatar, {
            participantId: initial.participantId, parkedRoot: initial.root, previousPoseSeq, timeoutMs: remainingMs
          });
          const attachReadiness = async (evidence: typeof release.evidence) => {
            const path = testInfo.outputPath("room-release-readiness.json");
            await writeFile(path, JSON.stringify(evidence), { mode: 0o600, flag: "wx" });
            await testInfo.attach("room-release-readiness", { path, contentType: "application/json" });
          };
          // Timeout evidence precedes the original readiness error. Success I/O
          // must not consume the existing assertion/PNG acceptance sequence.
          if (release.error) await finishReleasedAvatar(release, attachReadiness);
          const remotePose = release.remotePose!;
          let captured = false;
          try {
            expect(await readReviewView(observer)).toEqual(fixedReviewView);
            await testInfo.attach("room-release-view", { body: JSON.stringify({ fixedReviewView, parkedRoot: initial.root, remotePose }), contentType: "application/json" });
            expect(Date.now(), "Release capture readiness must fit the original 15s").toBeLessThan(releaseDeadline);
            await capture(observer, testInfo, "room-released-same-view");
            captured = true;
          } finally {
            // Keep the evidence even on assertion/PNG failure, without replacing
            // that original error if diagnostic persistence also fails.
            if (captured) await attachReadiness(release.evidence);
            else await attachReadiness(release.evidence).catch(() => {});
          }
        }
        await testInfo.attach("room-review-settings", { body: JSON.stringify({ staging, templateId, seat, reviewPose, initial, fixture: fixture!.fixtureFingerprint, errors }, null, 2), contentType: "application/json" });
        expect(errors).toEqual([]);
      } catch (error) {
        await attachPhaseDiagnostics(testInfo, "marker-failure-before-cleanup").catch(() => {});
        throw error;
      } finally {
        await cleanupAll([
          () => ownAuthority?.close(),
          () => observerBrowser?.close(),
          async () => {
            // The per-test request fixture can already be closed after a test timeout.
            const deleted = await fetch(new URL(`/api/rooms/${room.roomId}`, fixture!.origin), {
              method: "DELETE", headers, signal: AbortSignal.timeout(15000)
            });
            expect([200, 204, 404]).toContain(deleted.status);
          }
        ]);
      }
    });
  }
});

// Probes the same browser as the room page; the observer browser uses the same launch options.
// Software rendering skips, or fails with VRATA_E2E_REQUIRE_HARDWARE_RENDERING=1 (playwright.gpu.config.ts).
async function skipUnlessHardwareRendering(page: Page, testInfo: TestInfo) {
  const info = await page.evaluate(readWebglRenderer);
  const required = requireHardwareRendering(process.env);
  const decision = hardwareRenderingDecision(info, required);
  await testInfo.attach("webgl-renderer", { body: JSON.stringify({ ...info, required, decision }), contentType: "application/json" });
  if (decision.action === "fail") throw new Error(decision.reason!);
  test.skip(decision.action === "skip", decision.reason ?? undefined);
}

interface Seat { id: string; yaw: number; seatHeight: number; radius: number; position: { x: number; y: number; z: number } }
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
  observation(page);
  await page.goto(url);
  try {
    await expect.poll(() => page.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      return {
        state: debug?.sceneBundleState ?? null,
        failure: debug?.sceneDebug?.failureReason ?? null,
        missing: debug?.sceneDebug?.missingAssets ?? []
      };
    }), { timeout: 90000 }).toEqual({ state: "loaded", failure: null, missing: [] });
  } catch (error) {
    // Do not sample/read back the WebGL canvas while another client is loading.
    // Preserve the original failure even if the page has already closed.
    await page.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      const scene = debug?.sceneDebug;
      return {
        state: debug?.sceneBundleState ?? null,
        loadStage: scene?.loadStage ?? null,
        assetBytesLoaded: scene?.assetBytesLoaded ?? null,
        assetBytesExpected: scene?.assetBytesExpected ?? null,
        roomStateConnected: debug?.roomStateConnected ?? false,
        documentReadyState: document.readyState,
        visibilityState: document.visibilityState,
        hardwareConcurrency: navigator.hardwareConcurrency,
        resourceCount: performance.getEntriesByType("resource").length
      };
    }).then(snapshot => test.info().attach("marker-scene-load-timeout", {
      body: JSON.stringify(snapshot, null, 2), contentType: "application/json"
    })).catch(() => {});
    throw error;
  }
  await expect.poll(() => observation(page).measure("room-state", () => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)), { timeout: 30000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__.sceneDebug.missingAssets)).toEqual([]);
  await page.evaluate(() => {
    const hud = document.querySelector("details.hud");
    if (hud instanceof HTMLDetailsElement) hud.open = false;
  });
}
async function readOwnSeatClient(page: Page, seatId: string): Promise<OwnSeatClient> {
  return page.evaluate(id => {
    const d = (window as any).__VRATA_DEBUG__;
    return { participantId: d.participantId, currentSeatId: d.currentSeatId,
      occupantId: d.seatOccupancy[id] ?? null, roomStateConnected: d.roomStateConnected,
      root: { x: d.localPose.root.x, y: d.localPose.root.y, z: d.localPose.root.z } };
  }, seatId);
}
async function readReviewView(page: Page) {
  return page.evaluate(() => {
    const d = (window as any).__VRATA_DEBUG__;
    const canvas = document.querySelector("#scene > canvas") as HTMLCanvasElement;
    return { root: d.localPose.root, pitch: d.localPose.head.pitch,
      devicePixelRatio: window.devicePixelRatio, canvas: { width: canvas.width, height: canvas.height } };
  });
}
async function waitFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
