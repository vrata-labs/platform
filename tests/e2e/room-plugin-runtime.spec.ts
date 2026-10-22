import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chooseMeetingPanel } from "./meeting-tools-acceptance";
import { PDFDocument } from "pdf-lib";
import { createExternalAuthorProject, downloadPublicSdk, nativeMarker } from "./plugin-author-scenarios";
import { bindPluginArtifact as bind, enterOwnedPluginRoom as enter, expectPluginStatus as expectStatus, installPluginArtifact as install,
  startRoomPluginFixture as fixture, useOwnedActor as useActor } from "./room-plugin-fixture";

// Room invitations, RS2 and private config must never enter trace/video/snapshots.
test.use({ trace: "off", screenshot: "off", video: "off" });

for (const staging of [false, true]) test(`${staging ? "@staging " : ""}legacy room loads without plugin discovery, Worker or VM download`, async ({ browser, request }) => {
  test.setTimeout(180_000);
  const value = staging ? { origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN!, close: async () => {} } : await fixture(1);
  expect(Boolean(value.origin && value.adminToken)).toBe(true);
  try {
    if (staging) {
      const health = await request.get(`${value.origin}/health`); expect(health.ok()).toBe(true);
      expect((await health.json()).features?.identityProtocolVersion).not.toBe(2);
    }
    const actor = await enter(browser, value);
    await useActor(actor, async () => {
      await actor.page.waitForTimeout(2200);
      expect(actor.requests).toEqual({ plugin: 0, workers: 0, wasm: 0 });
      await expect(actor.page.locator("#room-plugin-statuses")).toBeHidden();
      await expect(actor.page.locator("#room-plugin-author")).toBeHidden();
    });
  } finally { await value.close(); }
});

test("isolated v2 discovers first external SDK artifact, changes config and disables without reload", async ({ browser, request }) => {
  test.setTimeout(300_000); const value = await fixture(2);
  let author: Awaited<ReturnType<typeof createExternalAuthorProject>> | undefined;
  try {
    const actor = await enter(browser, value);
    await useActor(actor, async () => {
      await expect.poll(() => actor.requests.plugin, { timeout: 15_000 }).toBeGreaterThan(0);
      expect(actor.requests.workers).toBe(0); expect(actor.requests.wasm).toBe(0);
      author = await createExternalAuthorProject(await downloadPublicSdk(request));
      const artifact = await author.build(`external.t07-${randomUUID().replaceAll("-", "")}`, "1.0.0", ["status.set"],
        "export function init(context: RoomPluginContext) { return context.sdk.status.set(String(context.config.greeting)); }");
      const pkg = await install(value, actor, artifact);
      let revision = await bind(value, actor, pkg, 0, "<b>literal greeting</b>");
      const status = actor.page.locator("#room-plugin-status-list");
      await expectStatus(actor.page, "first-enable", "<b>literal greeting</b>", 45_000);
      expect(await status.locator("b").count()).toBe(0);
      expect(await actor.page.evaluate(marker => Reflect.has(window, marker), nativeMarker)).toBe(false);
      expect(actor.requests.workers).toBeGreaterThan(0); expect(actor.requests.wasm).toBeGreaterThan(0);
      revision = await bind(value, actor, pkg, revision, "updated config");
      await expectStatus(actor.page, "config-update", "updated config");
      const beforeDisable = actor.requests.workers;
      revision = await bind(value, actor, pkg, revision, "updated config", false);
      await expect(actor.page.locator("#room-plugin-statuses")).toBeHidden({ timeout: 10_000 });
      await bind(value, actor, pkg, revision, "enabled again");
      await expectStatus(actor.page, "re-enable", "enabled again");
      expect(actor.requests.workers).toBeGreaterThan(beforeDisable);
      await expect(actor.page.locator("#room-name")).not.toContainText("Loading");
      await author.assertNotExecuted();
    });
  } finally { await author?.close(); await value.close(); }
});

test("isolated v2 failed behavior is sticky while room state and document controls remain usable", async ({ browser, request }) => {
  test.setTimeout(240_000); const value = await fixture(2);
  let author: Awaited<ReturnType<typeof createExternalAuthorProject>> | undefined;
  try {
    const actor = await enter(browser, value);
    await useActor(actor, async () => {
      author = await createExternalAuthorProject(await downloadPublicSdk(request));
      const artifact = await author.build(`external.loop-${randomUUID().replaceAll("-", "")}`, "1.0.0", ["status.set"], "export function init() { while(true) {} }");
      const pkg = await install(value, actor, artifact); await bind(value, actor, pkg, 0, "unused");
      await expectStatus(actor.page, "guest-loop", "Stopped", 45_000);
      const failure = await actor.page.evaluate(() => (window as any).__VRATA_DEBUG__?.plugins);
      expect(["execution_timeout", "interrupt_limit"]).toContain(failure.lastFailure); expect(failure.hostFailed).toBe(false);
      const workers = actor.requests.workers;
      await actor.page.waitForTimeout(4200); expect(actor.requests.workers).toBe(workers);
      expect(await actor.page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
      await chooseMeetingPanel(actor.page, "present", false);
      const pdf = await PDFDocument.create(); pdf.addPage([320, 180]);
      await actor.page.locator("#document-upload-input").setInputFiles({ name: "owned-after-plugin-failure.pdf", mimeType: "application/pdf", buffer: Buffer.from(await pdf.save()) });
      const uploaded = actor.page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/rooms/${actor.roomId}/documents`);
      void uploaded.catch(() => undefined); await actor.page.locator("#document-upload-button").click(); expect((await uploaded).status()).toBe(201);
      expect(await actor.page.evaluate(marker => Reflect.has(window, marker), nativeMarker)).toBe(false);
      await author.assertNotExecuted();
    });
  } finally { await author?.close(); await value.close(); }
});
