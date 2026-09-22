import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PDFDocument, rgb } from "pdf-lib";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";

let fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>>;
const headers = { "x-vrata-admin-token": "test-admin-token" };
const postgres = process.env.VRATA_TEST_POSTGRES_URL;
test.use({ viewport: { width: 960, height: 600 } });
test.beforeAll(async () => { test.setTimeout(120000); if (postgres) fixture = await startReferenceTemplateFixture(postgres); });
test.afterAll(async () => { if (fixture) await fixture.close(); });
test.beforeEach(() => { test.skip(!postgres, "Reference-template browser tests require VRATA_TEST_POSTGRES_URL"); test.setTimeout(300000); });

async function create(request: APIRequestContext, templateId: string) {
  const response = await request.post(`${fixture.origin}/api/rooms`, { headers, data: { tenantId: "demo-tenant", templateId, name: `Reference ${randomUUID().slice(0, 8)}` } });
  expect(response.status()).toBe(201); return response.json();
}
async function hostLink(request: APIRequestContext, roomId: string) {
  const invite = await request.post(`${fixture.origin}/api/rooms/${roomId}/invites`, { headers, data: { role: "host", expiresInSeconds: 600 } });
  expect(invite.ok()).toBe(true);
  const url = new URL((await invite.json()).inviteLink); url.searchParams.set("debug", "1"); url.searchParams.set("scenefit", "0"); return url.href;
}
async function join(page: Page, url: string) {
  await page.goto(url);
  await expect.poll(async () => await page.locator("#guest-onboarding").isVisible()
    || await page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState === "loaded"), { timeout: 120000 }).toBe(true);
  if (await page.locator("#guest-onboarding").isVisible()) {
    await page.locator("#guest-name-input").fill("Reference participant");
    await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  }
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90000 }).toBe("loaded");
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30000 }).toBe(true);
}

test("reference UI shows three real previews and creates an owner-bound private workspace", async ({ page, request }) => {
  await page.goto(`${fixture.origin}/control-plane`);
  await page.locator("#admin-token-input").fill("test-admin-token");
  await expect(page.locator(".template-card")).toHaveCount(3);
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
  expect(room.templateVersion).toBe("2.0.0"); expect(room.visibility).toBe("private"); expect(room.ownerParticipantId).toBe(owner);
  await expect(page.locator("#template-select")).toBeDisabled();
  await expect(page.locator("#bind-scene-bundle")).toBeDisabled();
  await page.addInitScript(id => { sessionStorage.setItem("vrata.participantId", id); localStorage.setItem("vrata.notes.scope", "shared"); }, owner);
  await join(page, `${room.roomLink}?debug=1&scenefit=0&onboard=0`);
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
  await page.locator("#admin-token-input").fill("test-admin-token");
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
  await page.goto(await hostLink(request, room.roomId));
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
  } finally { await context.close(); }
});

test("reference meeting synchronizes only declared surfaces across two participants", async ({ page, request, browser }) => {
  const room = await create(request, "meeting-room-basic");
  await join(page, await hostLink(request, room.roomId));
  const context = await browser.newContext({ viewport: { width: 640, height: 400 } });
  try {
    const observer = await context.newPage();
    await join(observer, `${room.roomLink}?debug=1&scenefit=0&onboard=0`);
    expect(await page.evaluate(() => (window as any).__VRATA_TEST__.createWhiteboardObject("whiteboard-wall"))).toBe(true);
    await expect.poll(() => observer.evaluate(() => (window as any).__VRATA_DEBUG__?.mediaObjects?.surfaces.find((s: any) => s.surfaceId === "whiteboard-wall")?.activeObjectType), { timeout: 15000 }).toBe("whiteboard");
    const surfaces = await page.evaluate(() => (window as any).__VRATA_DEBUG__.mediaObjects.surfaces.map((s: any) => s.surfaceId).sort());
    expect(surfaces).toEqual(["debug-main", "whiteboard-wall"]);
  } finally { await context.close(); }
});

test("modified mirrored scene bytes fail integrity before rendering", async ({ page, request }) => {
  const room = await create(request, "meeting-room-basic");
  const restore = fixture.corruptAsset(new URL("scene.glb", room.sceneBundleUrl).pathname);
  try {
    await page.goto(`${room.roomLink}?debug=1&scenefit=0&onboard=0`);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneDebug?.failureReason), { timeout: 30000 }).toBe("scene_asset_checksum_mismatch");
    expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState)).toBe("failed");
    await expect(page.locator("#branding-line")).toContainText("Scene verification failed");
  } finally { restore(); }
});
