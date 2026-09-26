import { expect, test, request as playwrightRequest, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PDFDocument, rgb } from "pdf-lib";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";
import { createLegacyStagingRoom, releaseLegacyStagingRoom } from "./staging-legacy-room";

export function referenceTemplateScenarios(staging: boolean) {
let fixture: Pick<Awaited<ReturnType<typeof startReferenceTemplateFixture>>, "origin" | "close" | "corruptAsset">;
const token = staging ? process.env.STAGING_ADMIN_TOKEN! : "test-admin-token";
const headers = { "x-vrata-admin-token": token };
const rooms = new Set<string>();
const postgres = process.env.VRATA_TEST_POSTGRES_URL;
test.use({ viewport: { width: 960, height: 600 } });
test.beforeAll(async () => {
  test.setTimeout(120000);
  if (staging) {
    expect(token).toBeTruthy();
    const origin = process.env.BASE_URL!;
    expect(new URL(origin).protocol).toBe("https:");
    fixture = {
      origin,
      corruptAsset() { throw new Error("public_assets_are_immutable"); },
      async close() {
        const failures: string[] = [];
        for (const id of rooms) {
          try {
            const response = await fetch(new URL(`/api/rooms/${id}`, origin), { method: "DELETE", headers, signal: AbortSignal.timeout(15000) });
            if (!response.ok && response.status !== 404) failures.push(`${id}:${response.status}`);
          } catch { failures.push(`${id}:unavailable`); }
        }
        expect(failures, "cleanup of disposable reference rooms").toEqual([]);
      }
    };
    const catalog = await (await fetch(new URL("/api/templates", origin))).json();
    expect(catalog.items.map((row: { templateId: string; currentVersion: string }) => `${row.templateId}@${row.currentVersion}`)).toEqual(["personal-room-basic@2.0.0", "meeting-room-basic@2.0.0", "presentation-room-basic@2.0.0"]);
  } else if (postgres) fixture = await startReferenceTemplateFixture(postgres);
});
test.afterAll(async () => { test.setTimeout(120000); if (fixture) await fixture.close(); });
test.beforeEach(() => { test.skip(!staging && !postgres, "Reference-template browser tests require VRATA_TEST_POSTGRES_URL"); test.setTimeout(300000); });

async function create(request: APIRequestContext, templateId: string) {
  const response = await request.post(`${fixture.origin}/api/rooms`, { headers, data: { tenantId: "demo-tenant", templateId, name: `Reference ${randomUUID().slice(0, 8)}` } });
  expect(response.status()).toBe(201); const room = await response.json(); rooms.add(room.roomId);
  expect(room.templateId).toBe(templateId); expect(room.templateVersion).toBe("2.0.0");
  return room;
}
async function hostLink(request: APIRequestContext, roomId: string) {
  const invite = await request.post(`${fixture.origin}/api/rooms/${roomId}/invites`, { headers, data: { role: "host", expiresInSeconds: 600 } });
  expect(invite.ok()).toBe(true);
  const url = new URL((await invite.json()).inviteLink); url.searchParams.set("debug", "1"); url.searchParams.set("scenefit", "0"); return url.href;
}
async function openRoom(page: Page, url: string) {
  // Bound software rendering work in multi-client functional checks. Scene
  // sources, materials and device quality profiles keep their product settings.
  await page.setViewportSize({ width: 640, height: 400 });
  try { await page.goto(url); }
  catch { throw new Error("reference_room_navigation_failed"); }
}
async function join(page: Page, url: string) {
  await openRoom(page, url);
  await expect.poll(async () => await page.locator("#guest-onboarding").isVisible()
    || await page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState === "loaded"), { timeout: 120000 }).toBe(true);
  if (await page.locator("#guest-onboarding").isVisible()) {
    await page.locator("#guest-name-input").fill("Reference participant");
    await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  }
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90000 }).toBe("loaded");
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30000 }).toBe(true);
  expect(await page.evaluate(() => {
    const d = (window as any).__VRATA_DEBUG__;
    return { failure: d.sceneDebug.failureReason, missing: d.sceneDebug.missingAssets, integrity: d.template.integrityRequired };
  })).toEqual({ failure: null, missing: [], integrity: true });
}

async function verifySeat(page: Page, seatId: string, observer = page, whileSeated?: () => Promise<void>) {
  const initial = await page.evaluate(() => {
    const d = (window as any).__VRATA_DEBUG__;
    return { participantId: d.participantId, root: d.localPose.root };
  });
  expect(await page.evaluate(id => (window as any).__VRATA_TEST__.requestSeatClaimById(id), seatId)).toBe(true);
  await expect.poll(() => observer.evaluate(id => (window as any).__VRATA_DEBUG__?.seatOccupancy?.[id], seatId), { timeout: 15000 }).toBe(initial.participantId);
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.currentSeatId), { timeout: 15000 }).toBe(seatId);
  if (whileSeated) await whileSeated();
  expect(await page.evaluate(root => (window as any).__VRATA_TEST__.teleportToFloor(root.x, root.z), initial.root)).toBe(true);
  await expect.poll(() => observer.evaluate(id => (window as any).__VRATA_DEBUG__?.seatOccupancy?.[id] ?? null, seatId), { timeout: 15000 }).toBe(null);
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.currentSeatId ?? null), { timeout: 15000 }).toBe(null);
  await expect.poll(() => page.evaluate(() => {
    const root = (window as any).__VRATA_DEBUG__?.localPose?.root;
    return [root?.x, root?.y, root?.z].map(value => Number(value?.toFixed(3)));
  }), { timeout: 15000 }).toEqual([initial.root.x, initial.root.y, initial.root.z].map(value => Number(value.toFixed(3))));
}

async function captureReferenceView(page: Page, name: string) {
  const hud = page.locator("details.hud");
  const wasOpen = await hud.evaluate(element => (element as HTMLDetailsElement).open);
  if (wasOpen) await page.locator(".hud-summary").click();
  try {
    await test.info().attach(name, { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    if (wasOpen) await page.locator(".hud-summary").click();
  }
}

test("reference UI shows three real previews and creates an owner-bound private workspace", async ({ page, request }) => {
  await page.goto(`${fixture.origin}/control-plane`);
  await page.locator("#admin-token-input").fill(token);
  await expect(page.locator(".template-card")).toHaveCount(3);
  await page.locator("#template-gallery").scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator(".template-card img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(page.locator("#template-select")).toHaveValue("personal-room-basic");
  await expect(page.locator("#room-visibility-select")).toHaveValue("private");
  await expect(page.locator("#room-visibility-select")).toBeDisabled();
  await expect(page.locator("#guest-access-input")).not.toBeChecked();
  const owner = `owner-${randomUUID()}`;
  await page.locator("#room-name-input").fill(`Workspace ${randomUUID().slice(0,8)}`);
  await page.locator("#room-owner-input").fill(owner);
  const created = page.waitForResponse(response => response.url() === `${fixture.origin}/api/rooms` && response.request().method() === "POST");
  await page.locator("#create-room").click();
  const response = await created; expect(response.status()).toBe(201); const room = await response.json();
  rooms.add(room.roomId);
  expect(room.templateVersion).toBe("2.0.0"); expect(room.visibility).toBe("private"); expect(room.ownerParticipantId).toBe(owner);
  await expect(page.locator("#template-select")).toBeDisabled();
  await expect(page.locator("#bind-scene-bundle")).toBeDisabled();
  await page.addInitScript(id => { sessionStorage.setItem("vrata.participantId", id); localStorage.setItem("vrata.notes.scope", "shared"); }, owner);
  await join(page, `${room.roomLink}?debug=1&scenefit=0&onboard=0`);
  await captureReferenceView(page, "personal-spawn");
  await verifySeat(page, "owner-desk-seat");
  await expect(page.locator("#notes-scope-select")).toHaveValue("private");
  const info = await page.evaluate(() => (window as any).__VRATA_DEBUG__.template);
  expect(info).toMatchObject({ id: "personal-room-basic", version: "2.0.0", sceneReleaseId: "personal-workspace-v1@0.4.2", integrityRequired: true });
  await page.locator("#notes-editor").fill("Private reference notes");
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.notes?.saveState), { timeout: 15000 }).toBe("saved");
  const denied = await request.post(`${fixture.origin}/api/tokens/state`, { data: { roomId: room.roomId, participantId: "other-user", displayName: "Other" } });
  expect(denied.status()).toBe(403);
});

test("template selection confirms edited-default resets and API rejects mutable reference bindings", async ({ page, request }) => {
  await page.goto(`${fixture.origin}/control-plane`);
  await page.locator("#admin-token-input").fill(token);
  await page.locator("#template-select").selectOption("meeting-room-basic");
  await page.locator("#feature-voice-input").uncheck();
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#template-select").selectOption("presentation-room-basic");
  await expect(page.locator("#template-select")).toHaveValue("meeting-room-basic");
  await expect(page.locator("#feature-voice-input")).not.toBeChecked();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#template-select").selectOption("presentation-room-basic");
  await expect(page.locator("#feature-voice-input")).toBeChecked();
  await expect(page.locator("#template-summary")).toContainText("join muted");
  const room = await create(request, "meeting-room-basic");
  for (const data of [{ templateVersion: "0.1.0" }, { templateId: "presentation-room-basic" }, { sceneBundleUrl: "https://other.example/scene.json" }]) {
    expect((await request.patch(`${fixture.origin}/api/rooms/${room.roomId}`, { headers, data })).status()).toBe(409);
  }
  const stale = await request.post(`${fixture.origin}/api/rooms`, { headers, data: { tenantId: "demo-tenant", templateId: "meeting-room-basic", templateVersion: "1.0.0", name: "Stale reference" } });
  expect(stale.status()).toBe(409);
});

test("reference presentation applies join-muted defaults and restores rendered PDF pages for late join", async ({ page, request, browser }, testInfo) => {
  const room = await create(request, "presentation-room-basic");
  await openRoom(page, await hostLink(request, room.roomId));
  await expect(page.locator("#guest-onboarding")).toBeVisible();
  await expect(page.locator("#guest-join-muted")).toBeChecked();
  await page.locator("#guest-name-input").fill("Presenter");
  await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90000 }).toBe("loaded");
  const pdf = await PDFDocument.create();
  pdf.addPage([640,360]).drawRectangle({ x:0, y:0, width:640, height:360, color:rgb(.9,.08,.08) });
  pdf.addPage([640,360]).drawRectangle({ x:0, y:0, width:640, height:360, color:rgb(.08,.18,.9) });
  await expect(page.locator("#document-upload-button")).toBeEnabled({ timeout: 30000 });
  await page.setInputFiles("#document-upload-input", { name: "reference-slides.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
  await page.locator("#document-upload-button").click();
  await expect(page.locator("#document-select")).toContainText("reference-slides.pdf", { timeout: 30000 });
  await page.locator("#document-surface-button").click();
  await expect(page.locator("#presentation-page-label")).toHaveText("Page 1 / 2", { timeout: 30000 });
  await page.locator("#presentation-next").click();
  const context = await browser.newContext({ viewport: { width: 640, height: 400 } });
  try {
    const late = await context.newPage();
    try { await join(late, `${room.roomLink}?debug=1&scenefit=0&onboard=0`); } catch (error) {
      const diagnostic = await late.evaluate(() => {
        const d = (window as any).__VRATA_DEBUG__;
        return { scene: d?.sceneDebug, state: d?.sceneBundleState, connected: d?.roomStateConnected, issue: d?.issueCode, status: d?.statusLine };
      }).catch(() => null);
      await testInfo.attach("late-join-diagnostic", { body: JSON.stringify(diagnostic), contentType: "application/json" });
      throw error;
    }
    await expect.poll(() => late.evaluate(() => `${(window as any).__VRATA_DEBUG__?.pdfPresentation?.renderState}:${(window as any).__VRATA_DEBUG__?.pdfPresentation?.page}`), { timeout: 30000 }).toBe("ready:2");
    await expect(late.locator("#presentation-prev")).toBeDisabled();
    await verifySeat(page, "seat-01", late, () => captureReferenceView(late, "presentation-page-two"));
  } finally { await context.close(); }
});

test("reference meeting synchronizes only declared surfaces across two participants", async ({ page, request, browser }) => {
  const room = await create(request, "meeting-room-basic");
  const hostUrl = new URL(await hostLink(request, room.roomId));
  if (staging) hostUrl.searchParams.set("audiomock", "1");
  await join(page, hostUrl.href);
  await captureReferenceView(page, "meeting-spawn");
  const context = await browser.newContext({ viewport: { width: 640, height: 400 } });
  try {
    const observer = await context.newPage();
    await join(observer, `${room.roomLink}?debug=1&scenefit=0&onboard=0${staging ? "&audiomock=1" : ""}`);
    expect(await page.evaluate(() => (window as any).__VRATA_TEST__.createWhiteboardObject("whiteboard-wall"))).toBe(true);
    await expect.poll(() => observer.evaluate(() => (window as any).__VRATA_DEBUG__?.mediaObjects?.surfaces.find((s: any) => s.surfaceId === "whiteboard-wall")?.activeObjectType), { timeout: 15000 }).toBe("whiteboard");
    const surfaces = await page.evaluate(() => (window as any).__VRATA_DEBUG__.mediaObjects.surfaces.map((s: any) => s.surfaceId).sort());
    expect(surfaces).toEqual(["debug-main", "whiteboard-wall"]);
    if (staging) {
      await page.locator("#join-muted").uncheck();
      await observer.locator("#join-muted").uncheck();
      await page.locator("#join-audio").click();
      await observer.locator("#join-audio").click();
      await expect.poll(() => observer.evaluate(() => {
        const d = (window as any).__VRATA_DEBUG__;
        return { subscribed: d?.media?.subscribedAudioCount, spatial: d?.spatialAudio?.remoteSources?.some((source: any) => source.hasAudioNode && source.pannerActive) };
      }), { timeout: 45000 }).toEqual({ subscribed: 1, spatial: true });
    }
    for (let seat = 1; seat <= 8; seat++) await verifySeat(page, `seat-${String(seat).padStart(2, "0")}`, observer);
  } finally { await context.close(); }
});

if (staging) test("reference presentation receives moving screen-share frames through the real media transport", async ({ request, playwright }) => {
  test.setTimeout(420000);
  const room = await create(request, "presentation-room-basic");
  const browser = await playwright.chromium.launch({ headless: true });
  // Preserve the 640x400 onboarding/HUD layout while bounding the two software
  // drawing buffers. Capture resolution and real media transport stay unchanged.
  const viewport = { width: 640, height: 400 };
  const deviceScaleFactor = 0.5;
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  const observer = await browser.newPage({ viewport, deviceScaleFactor });
  const events: Array<{ peer: string; category: string; status?: number }> = [];
  for (const [client, peer] of [[page, "publisher"], [observer, "viewer"]] as const) {
    client.on("response", response => {
      if (new URL(response.url()).pathname === "/api/tokens/media") events.push({ peer, category: "media_token", status: response.status() });
    });
    client.on("console", message => {
      if (message.type() !== "error") return;
      const text = message.text().toLowerCase();
      const category = text.includes("pc connection") ? "peer_connection" : text.includes("signal") ? "signaling" : text.includes("surface_command") ? "surface_command" : text.includes("permission") ? "permission" : "other_error";
      events.push({ peer, category });
    });
  }
  try {
    await join(page, await hostLink(request, room.roomId));
    await join(observer, `${room.roomLink}?debug=1&scenefit=0&onboard=0`);
    for (const client of [page, observer]) {
      expect(await client.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("#scene canvas");
        return [innerWidth, innerHeight, devicePixelRatio, canvas?.width, canvas?.height];
      })).toEqual([640, 400, 0.5, 320, 200]);
    }
    // Replace only the OS capture source. Publishing, subscription, decoding and
    // surface presentation use the ordinary product transport, without sharemock.
    await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const paint = canvas.getContext("2d")!;
      let color = "#e82020";
      const frame = () => { paint.fillStyle = color; paint.fillRect(0, 0, 160, 90); };
      frame();
      const timer = window.setInterval(frame, 100);
      const stream = canvas.captureStream(10);
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => stream });
      (window as any).__setReferenceCaptureColor = (next: string) => { color = next; frame(); };
      (window as any).__stopReferenceCapture = () => { window.clearInterval(timer); stream.getTracks().forEach(track => track.stop()); };
    });
    await expect(page.locator("#start-share")).toBeEnabled({ timeout: 30000 });
    await page.locator("#start-share").click();
    await expect.poll(() => page.evaluate(() => {
      const state = (window as any).__VRATA_DEBUG__?.screenShare;
      return Boolean(state?.localPublishing && state.publishedTrackSid && !state.publishedTrackSid.startsWith("mock-"));
    }), { timeout: 120000, intervals: [500, 1000, 2000] }).toBe(true);
    await expect.poll(() => observer.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.remoteSubscribedTrackCount ?? 0), { timeout: 45000 }).toBe(1);
    expect(await observer.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.publishedAudio)).toBe(false);
    await expect(observer.locator("#join-muted")).toBeChecked();
    const receivedColor = () => observer.evaluate(() => {
      const sample = (window as any).__VRATA_TEST__.sampleMediaSurfaceTexture("debug-main", { u: .5, v: .5 }, { width: .01, height: .01 });
      const pixel = sample?.samples?.[0];
      return pixel?.[0] > pixel?.[2] + 30 ? "red" : pixel?.[2] > pixel?.[0] + 30 ? "blue" : null;
    });
    await expect.poll(receivedColor, { timeout: 30000 }).toBe("red");
    await page.evaluate(() => (window as any).__setReferenceCaptureColor("#2040e8"));
    await expect.poll(receivedColor, { timeout: 30000 }).toBe("blue");
    await captureReferenceView(observer, "presentation-real-screen-share");
    await page.locator("#stop-share").click();
    await expect.poll(() => observer.evaluate(() => (window as any).__VRATA_DEBUG__?.screenShare?.remoteSubscribedTrackCount ?? 0), { timeout: 30000 }).toBe(0);
  } catch (error) {
    const states = await Promise.all([page, observer].map(client => client.evaluate(() => {
      const d = (window as any).__VRATA_DEBUG__;
      return { frameBudgetMs: d?.avatarPoseTransport?.frameBudgetMs,
        viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
        scene: d?.sceneBundleState, issue: d?.issueCode, audioState: d?.media?.audioState, publishedAudio: d?.media?.publishedAudio, rtcAvailable: d?.media?.webrtc?.available, transportCount: d?.media?.webrtc?.transports?.length, share: d?.screenShare,
        videos: [...document.querySelectorAll("video")].map(video => ({ width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, paused: video.paused, frames: video.getVideoPlaybackQuality().totalVideoFrames })),
        pixel: (window as any).__VRATA_TEST__?.sampleMediaSurfaceTexture("debug-main", { u: .5, v: .5 }, { width: .01, height: .01 })?.samples?.[0] };
    }).catch(() => null)));
    await test.info().attach("reference-media-state", { body: JSON.stringify({ events, states }), contentType: "application/json" });
    throw error;
  } finally {
    await page.evaluate(() => (window as any).__stopReferenceCapture?.()).catch(() => undefined);
    await browser.close();
  }
});

if (!staging) test("retained legacy fixtures remain editable without reopening deprecated creates", async () => {
  const request = await playwrightRequest.newContext({ baseURL: fixture.origin });
  try {
    for (let run = 0; run < 2; run++) {
      const response = await createLegacyStagingRoom(request, "normal-product", { headers, data: { templateId: "personal-workspace-basic", name: "Retained legacy regression", sceneBundleUrl: "https://fixture.example/scene.json" } });
      expect(response.status()).toBe(200);
      const room = await response.json();
      expect(room.templateVersion).toBe("0.1.0");
      expect(room.sceneBundleUrl).toBe("https://fixture.example/scene.json");
      expect((await releaseLegacyStagingRoom(request, room.roomId, { headers })).ok()).toBe(true);
    }
    const rejected = await request.post("/api/rooms", { headers, data: { templateId: "personal-workspace-basic", tenantId: "demo-tenant", name: "Forbidden legacy create" } });
    expect(rejected.status()).toBe(409);
    expect((await rejected.json()).error).toBe("deprecated_template");
    const catalog = await (await request.get("/api/templates")).json();
    expect(catalog.items).toHaveLength(3);
  } finally { await request.dispose(); }
});

if (!staging) test("modified mirrored scene bytes fail integrity before rendering", async ({ page, request }) => {
  const room = await create(request, "meeting-room-basic");
  const restore = fixture.corruptAsset(new URL("scene.glb", room.sceneBundleUrl).pathname);
  try {
    await page.goto(`${room.roomLink}?debug=1&scenefit=0&onboard=0`);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneDebug?.failureReason), { timeout: 30000 }).toBe("scene_asset_checksum_mismatch");
    expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState)).toBe("failed");
    await expect(page.locator("#branding-line")).toContainText("Scene verification failed");
  } finally { restore(); }
});
}
