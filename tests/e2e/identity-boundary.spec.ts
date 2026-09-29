import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { startReferenceTemplateFixture } from "./reference-template-fixture";

// Raising the floor is irreversible. This case owns an isolated schema and is
// intentionally never tagged for the shared staging database.
test.use({ trace: "off", screenshot: "off", video: "off", viewport: { width: 390, height: 844 } });

for (const staging of [false, true]) test(`${staging ? "@staging " : ""}obsolete development-key credentials trigger a real upgrade denial`, async ({ page, request }) => {
  test.skip(!staging && !process.env.VRATA_TEST_POSTGRES_URL, "Requires isolated PostgreSQL");
  test.setTimeout(90_000);
  const fixture = staging ? null : await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { stateTokenSecret: "identity-key-rotation-browser-test-secret-32" });
  const origin = fixture?.origin ?? process.env.BASE_URL!;
  const roomId = staging ? process.env.STAGING_ROOM_ID ?? "demo-room" : "demo-room";
  const participantId = `old-key-${randomUUID()}`;
  const { signRoomSessionToken } = await import(pathToFileURL(resolve("packages/shared-types/dist/session-token.js")).href);
  const now = Math.floor(Date.now() / 1000);
  const token = signRoomSessionToken({ tenantId: "demo-tenant", roomId, participantId, displayName: "Old-key denial check",
    role: "guest", permissions: [], sessionId: randomUUID(), jti: randomUUID(), iat: now, exp: now + 600 }, "dev-state-secret");
  try {
    await page.addInitScript(id => sessionStorage.setItem("vrata.participantId", id), participantId);
    // Forward a real obsolete credential; do not synthesize the server response.
    await page.route("**/api/tokens/state", route => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }));
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await page.goto(`${origin}/rooms/${roomId}?onboard=0`);
    const response = await denied;
    expect(response.status()).toBe(409);
    expect(await response.json()).toEqual({ error: "identity_required", reason: "identity_upgrade_required" });
    await expect(page.locator("#session-upgrade-dialog")).toBeVisible();
    await expect(page.locator("#session-upgrade-title")).toHaveText("Update required to rejoin this room");
    expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(false);
    if (fixture) {
      const policy = await request.get(`${origin}/api/internal/identity-policy`, { headers: { "x-vrata-internal-token": "test-internal-token" } });
      expect((await policy.json()).minimumProtocolVersion).toBe(1);
    }
  } finally { await page.goto("about:blank").catch(() => {}); await fixture?.close(); }
});

test("real protocol activation stops a live legacy client, protects its draft and denies fresh entry after restart", async ({ page, request, browser }) => {
  test.skip(!process.env.VRATA_TEST_POSTGRES_URL, "Requires an isolated PostgreSQL fixture");
  test.setTimeout(120_000);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!);
  const requireApi = createRequire(resolve("apps/api/package.json"));
  const { Pool } = requireApi("pg");
  const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${fixture.schema},public` });
  let releaseWrite: (() => void) | undefined;
  const fresh = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    expect(fixture.schema).toMatch(/^template_e2e_[0-9a-f]{32}$/);
    const namespace = await pool.query("select current_schema() as name, 'room_identity_protocol_policy'::regclass::oid as policy");
    expect(namespace.rows[0].name).toBe(fixture.schema);
    const owner = await pool.query("select n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=$1", [namespace.rows[0].policy]);
    expect(owner.rows[0].nspname).toBe(fixture.schema);
    const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
    const storage = new PostgresStorage(pool);
    await page.goto(`${fixture.origin}/rooms/demo-room?role=host&onboard=0`);
    await expect(page.locator("#notes-editor")).toBeEnabled({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    const before = await page.locator("#notes-editor").inputValue();
    const scope = await page.locator("#notes-scope-select").inputValue();
    let sent!: () => void;
    const started = new Promise<void>(done => { sent = done; });
    const held = new Promise<void>(done => { releaseWrite = done; });
    await page.route("**/api/rooms/demo-room/notes/*", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      sent(); await held;
      await route.continue().catch(() => undefined);
    });
    const draft = "Draft retained across the real server protocol boundary";
    await page.locator("#notes-editor").fill(draft);
    await started;
    await storage.identityProtocol.raise(2);
    releaseWrite();
    await expect(page.locator("#session-upgrade-dialog")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`#session-upgrade-draft-${scope}`)).toHaveValue(draft);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(false);
    const persisted = await request.get(`${fixture.origin}/api/rooms/demo-room/notes/${scope}`, { headers: { "x-vrata-admin-token": fixture.adminToken } });
    expect(persisted.status()).toBe(200);
    expect((await persisted.json()).note.content).toBe(before);
    await fixture.restartApi();
    const denied = fresh.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await fresh.goto(`${fixture.origin}/rooms/demo-room?onboard=0`);
    const response = await denied;
    expect(response.status()).toBe(409);
    expect(await response.json()).toEqual({ error: "identity_required", reason: "identity_upgrade_required" });
    await expect(fresh.locator("#session-upgrade-dialog")).toBeVisible();
    expect(await storage.identityProtocol.minimum()).toBe(2);
  } finally {
    releaseWrite?.();
    await Promise.allSettled([page.goto("about:blank"), fresh.close()]);
    await pool.end();
    await fixture.close();
  }
});
