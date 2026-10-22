import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startReferenceTemplateFixture } from "./reference-template-fixture";
import { installFunctionalFrameBudget } from "./functional-frame-budget";
import { chooseMeetingPanel, installMeetingPerformanceObservation, readMeetingPerformance } from "./meeting-tools-acceptance";
import { PDFDocument } from "pdf-lib";
import { privateHttp, bearer, pluginPath, createExternalAuthorProject, downloadPublicSdk, nativeMarker, type ExternalArtifact } from "./plugin-author-scenarios";
import type { AuthorHttpSession, AuthorHttpPackage } from "../../apps/api/src/plugins/author-http.test-helper";

// Room invitations, RS2 and private config must never enter trace/video/snapshots.
test.use({ trace: "off", screenshot: "off", video: "off" });
const secret = "owned-t07-room-runtime-state-secret-32-bytes";

async function fixture(protocol: 1 | 2) {
  expect(Boolean(process.env.VRATA_TEST_POSTGRES_URL)).toBe(true);
  const value = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { devRoleQuery: false, stateTokenSecret: secret });
  if (protocol === 2) {
    expect(value.schema).toMatch(/^template_e2e_[0-9a-f]{32}$/);
    const { Pool } = createRequire(resolve("apps/api/package.json"))("pg");
    const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${value.schema},public` });
    try {
      const policy = await pool.query("select current_schema() as schema,n.nspname as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid='room_identity_protocol_policy'::regclass");
      expect(policy.rows).toEqual([{ schema: value.schema, owner: value.schema }]);
      const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
      await new PostgresStorage(pool).identityProtocol.raise(2);
    } finally { await pool.end(); }
  }
  return value;
}

async function enter(browser: Browser, value: { origin: string; adminToken: string }) {
  const admin = { "x-vrata-admin-token": value.adminToken };
  const created = await privateHttp(value.origin, "/api/rooms", "POST", admin,
    { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned T07 runtime room", visibility: "private" });
  expect(created.status).toBe(201); const roomId = created.json<{ roomId: string }>().roomId;
  const invite = await privateHttp(value.origin, `/api/rooms/${roomId}/invites`, "POST", admin, { role: "host", expiresInSeconds: 1200 });
  expect(invite.status).toBe(201);
  const context = await browser.newContext({ viewport: { width: 800, height: 500 }, deviceScaleFactor: .4 });
  const page = await context.newPage(); await installFunctionalFrameBudget(page); await installMeetingPerformanceObservation(page);
  const requests = { plugin: 0, workers: 0, wasm: 0 };
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.includes("/plugins/")) requests.plugin++;
    if (/room-plugin-(?:worker|kernel)-/.test(url.pathname)) requests.workers++;
    if (/emscripten.*\.wasm$/.test(url.pathname)) requests.wasm++;
  });
  const admission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
  void admission.catch(() => undefined);
  try { await page.goto(invite.json<{ inviteLink: string }>().inviteLink); } catch { throw new Error("owned_plugin_runtime_navigation_failed"); }
  await page.locator("#guest-name-input").fill("Owned plugin runtime Host"); await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  const session = await (await admission).json() as AuthorHttpSession;
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90_000 }).toBe("loaded");
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
  return { page, context, requests, session, roomId, admin,
    async close() {
      await context.close();
      const deleted = await privateHttp(value.origin, `/api/rooms/${roomId}`, "DELETE", admin);
      if (deleted.status !== 200) {
        const raw = deleted.json<{ error?: string }>().error;
        const code = ["plugin_upload_pending", "identity_fence_unavailable", "identity_fence_conflict", "room_not_found"].includes(raw ?? "") ? raw : "other";
        throw new Error(`owned_plugin_runtime_cleanup_${deleted.status}_${code}`);
      }
    } };
}

async function useActor(actor: Awaited<ReturnType<typeof enter>>, run: () => Promise<void>) {
  let failed = false;
  try { await run(); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await actor.close(); }
    catch (error) {
      if (!failed) throw error;
      console.warn("owned_plugin_runtime_cleanup_also_failed");
    }
  }
}

async function install(value: Awaited<ReturnType<typeof fixture>>, actor: Awaited<ReturnType<typeof enter>>, artifact: ExternalArtifact) {
  const response = await privateHttp(value.origin, pluginPath(actor.roomId, "packages"), "POST", bearer(actor.session.token), artifact.bytes);
  expect(response.status).toBe(201); return response.json<{ package: AuthorHttpPackage }>().package;
}
async function bind(value: Awaited<ReturnType<typeof fixture>>, actor: Awaited<ReturnType<typeof enter>>, pkg: AuthorHttpPackage,
  expectedRevision: number, greeting: string, enabled = true) {
  const response = await privateHttp(value.origin, pluginPath(actor.roomId, `bindings/${pkg.pluginId}`), "PUT", bearer(actor.session.token), {
    expectedRevision, packageId: pkg.packageId, version: pkg.version, artifactSha256: pkg.artifactSha256, enabled,
    config: { greeting }, approvedCapabilities: ["status.set"]
  });
  expect(response.status).toBe(200); return response.json<{ revision: number }>().revision;
}

async function expectStatus(page: Page, stage: string, expected: string, timeout = 30_000) {
  try { await expect(page.locator("#room-plugin-status-list")).toContainText(expected, { timeout }); }
  catch (error) {
    const facts = await page.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      return { plugins: debug?.plugins, scene: debug?.sceneBundleState, connected: debug?.roomStateConnected };
    }).catch(() => ({ unavailable: true }));
    console.warn("owned_plugin_runtime_failed", JSON.stringify({ stage, facts, performance: await readMeetingPerformance(page) }));
    throw error;
  }
}

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
