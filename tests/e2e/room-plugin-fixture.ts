import { expect, type Browser, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startReferenceTemplateFixture } from "./reference-template-fixture";
import { installFunctionalFrameBudget } from "./functional-frame-budget";
import { installMeetingPerformanceObservation, readMeetingPerformance } from "./meeting-tools-acceptance";
import { privateHttp, bearer, pluginPath, type ExternalArtifact } from "./plugin-author-scenarios";
import type { AuthorHttpSession, AuthorHttpPackage } from "../../apps/api/src/plugins/author-http.test-helper";

const secret = "owned-t07-room-runtime-state-secret-32-bytes";
export type RoomPluginFixture = Awaited<ReturnType<typeof startRoomPluginFixture>>;
export interface RoomPluginOrigin { origin: string; adminToken: string }

/** Owned reference fixture; protocol 2 raises only this disposable schema, never a shared floor. */
export async function startRoomPluginFixture(protocol: 1 | 2) {
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

export async function createOwnedPluginRoom(value: RoomPluginOrigin): Promise<string> {
  const created = await privateHttp(value.origin, "/api/rooms", "POST", { "x-vrata-admin-token": value.adminToken },
    { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned T07 runtime room", visibility: "private" });
  expect(created.status).toBe(201); return created.json<{ roomId: string }>().roomId;
}
export async function deleteOwnedPluginRoom(value: RoomPluginOrigin, roomId: string): Promise<void> {
  const deleted = await privateHttp(value.origin, `/api/rooms/${roomId}`, "DELETE", { "x-vrata-admin-token": value.adminToken });
  if (deleted.status !== 200) {
    const raw = deleted.json<{ error?: string }>().error;
    const code = ["plugin_upload_pending", "identity_fence_unavailable", "identity_fence_conflict", "room_not_found"].includes(raw ?? "") ? raw : "other";
    throw new Error(`owned_plugin_runtime_cleanup_${deleted.status}_${code}`);
  }
}

/** One browser participant through the normal private invitation and onboarding. */
export async function enterPluginRoom(browser: Browser, value: RoomPluginOrigin, roomId: string, role: "host" | "member" = "host",
  name = "Owned plugin runtime Host") {
  const invite = await privateHttp(value.origin, `/api/rooms/${roomId}/invites`, "POST", { "x-vrata-admin-token": value.adminToken }, { role, expiresInSeconds: 1200 });
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
  await page.locator("#guest-name-input").fill(name); await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  const session = await (await admission).json() as AuthorHttpSession;
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90_000 }).toBe("loaded");
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
  return { page, context, requests, session, roomId };
}

/** Host actor that owns its room: closing it deletes the room and its plugin blobs. */
export async function enterOwnedPluginRoom(browser: Browser, value: RoomPluginOrigin) {
  const roomId = await createOwnedPluginRoom(value);
  const actor = await enterPluginRoom(browser, value, roomId);
  return { ...actor, admin: { "x-vrata-admin-token": value.adminToken },
    async close() { await actor.context.close(); await deleteOwnedPluginRoom(value, roomId); } };
}

export async function useOwnedActor(actor: { close(): Promise<void> }, run: () => Promise<void>) {
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

type Actor = { roomId: string; session: AuthorHttpSession };
export async function installPluginArtifact(value: RoomPluginOrigin, actor: Actor, artifact: ExternalArtifact) {
  const response = await privateHttp(value.origin, pluginPath(actor.roomId, "packages"), "POST", bearer(actor.session.token), artifact.bytes);
  expect(response.status).toBe(201); return response.json<{ package: AuthorHttpPackage }>().package;
}
export async function bindPluginArtifact(value: RoomPluginOrigin, actor: Actor, pkg: AuthorHttpPackage,
  expectedRevision: number, greeting: string, enabled = true) {
  const response = await privateHttp(value.origin, pluginPath(actor.roomId, `bindings/${pkg.pluginId}`), "PUT", bearer(actor.session.token), {
    expectedRevision, packageId: pkg.packageId, version: pkg.version, artifactSha256: pkg.artifactSha256, enabled,
    config: { greeting }, approvedCapabilities: ["status.set"]
  });
  expect(response.status).toBe(200); return response.json<{ revision: number }>().revision;
}

export async function expectPluginStatus(page: Page, stage: string, expected: string, timeout = 30_000) {
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
