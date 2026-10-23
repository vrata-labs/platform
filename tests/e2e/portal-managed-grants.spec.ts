import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startLocalLiveKitFixture } from "./local-livekit-fixture.js";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";

// A portal-managed deployment as the portal stage runs it: identity v2, entry only by grants, LiveKit with
// auto_create:false and the platform's own access enforcement. Codes and tokens stay in memory, never in artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ mode: "serial" });
const { RoomServiceClient } = createRequire(resolve("apps/api/package.json"))("livekit-server-sdk");
const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const tenantId = `pt_${Array.from({ length: 26 }, () => ULID[randomInt(ULID.length)]).join("")}`;
const key = () => `key_${randomUUID().replaceAll("-", "")}`;
const policy = { policyId: "qa-demo-v1", templates: ["meeting-room-basic", "presentation-room-basic"], absoluteLifetimeSeconds: 1800, idleTimeoutSeconds: 600,
  maxParticipants: 4, features: { voice: true, screenShare: false, documents: false, upload: false, remoteBrowser: false } };

let livekit: Awaited<ReturnType<typeof startLocalLiveKitFixture>>;
let fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>>;
let sign: (scope?: string[]) => string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  const assertions = await import(pathToFileURL(resolve("apps/api/dist/testing/integration-assertions.js")).href);
  const signer = assertions.createIntegrationTestKey("portal-stage-e2e", "portal:stage");
  sign = () => assertions.signIntegrationAssertion(signer);
  livekit = await startLocalLiveKitFixture("1.13.9", { autoCreate: false });
  fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, {
    identityProtocol: 2, livekitUrl: livekit.url, devRoleQuery: false,
    extraEnv: origin => ({
      VRATA_PORTAL_MANAGED: "true", VRATA_ADHOC_ROOMS: "false", VRATA_INTEGRATION_KEYS: assertions.integrationKeysEnv([signer]),
      VRATA_DEMO_POLICIES: JSON.stringify([policy]), RUNTIME_BASE_URL: origin, LIVEKIT_API_URL: livekit.httpUrl,
      VRATA_MANAGED_ENFORCER_INTERVAL_MS: "500"
    })
  });
});
test.afterAll(async () => { await fixture?.close(); await livekit?.close(); });

async function integration(request: APIRequestContext, method: "PUT" | "POST" | "GET", path: string, body?: unknown) {
  const response = await request.fetch(`${fixture.origin}${path}`, { method, data: body,
    headers: { authorization: `Bearer ${sign()}`, ...(method === "GET" ? {} : { "idempotency-key": key() }) } });
  return { status: response.status(), body: await response.json() };
}

async function enter(page: Page, entryUrl: string, name: string) {
  await page.goto(entryUrl);
  expect(page.url()).not.toContain("grant=");
  await page.locator("#guest-name-input").fill(name);
  await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
}

test("a portal grant opens one demo instance, an invite brings the others, and closing ends room-state and LiveKit", async ({ browser, request }) => {
  test.setTimeout(240_000);
  expect((await integration(request, "PUT", `/integration/v1/tenants/${tenantId}`, { displayName: "Demo" })).status).toBe(200);
  const room = await integration(request, "POST", `/integration/v1/tenants/${tenantId}/rooms`, {
    kind: "demo-instance", template: { templateId: "meeting-room-basic", version: "2.0.0" }, name: "Demo meeting",
    accessUntil: new Date(Date.now() + 1_200_000).toISOString(), demoPolicyId: "qa-demo-v1" });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  const roomId = room.body.roomId as string;
  const grants = `/integration/v1/tenants/${tenantId}/rooms/${roomId}/grants`;
  const visit = await integration(request, "POST", grants, { role: "guest", purpose: "visit", maxUses: 1 });
  const invite = await integration(request, "POST", grants, { role: "guest", purpose: "invite", maxUses: 3 });
  expect(visit.body.entryUrl, JSON.stringify(visit.body)).toMatch(new RegExp(`^${fixture.origin}/rooms/${roomId}#grant=`));

  const creator = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  const late = await (await browser.newContext()).newPage();
  await enter(creator, visit.body.entryUrl, "Creator");
  await enter(guest, invite.body.entryUrl, "Guest");
  for (const page of [creator, guest]) {
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 60_000 }).toBe(true);
  }
  // The visit link was spent by the creator: the same link in another browser is not an entry.
  await late.goto(visit.body.entryUrl);
  await late.locator("#guest-name-input").fill("Late");
  await late.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  await expect(late.locator("#room-access-ended")).toBeVisible({ timeout: 30_000 });
  await expect(late.locator("#room-access-ended-title")).toHaveText("This invitation is not valid");
  await late.context().close();

  // Media: the platform created the LiveKit room of the current epoch; nobody else can create one.
  const identityCredential = await creator.evaluate(roomId => sessionStorage.getItem(`vrata.identity.v2.${roomId}`), roomId);
  const session = await request.post(`${fixture.origin}/api/tokens/state`, { data: { identityProtocolVersion: 2, roomId, identityCredential } });
  expect(session.status()).toBe(200);
  const media = await request.post(`${fixture.origin}/api/tokens/media`, { data: { roomId, canPublishAudio: true, canPublishVideo: false },
    headers: { authorization: `Bearer ${(await session.json()).token}` } });
  expect(media.status()).toBe(200);
  const mediaToken = (await media.json()).token as string;
  const native = new RoomServiceClient(livekit.httpUrl, "devkey", "secret");
  const epochRooms = async () => (await native.listRooms()).map((value: { name: string }) => value.name).filter((name: string) => name.includes(roomId));
  const [epochRoom] = await epochRooms();
  expect(epochRoom).toMatch(new RegExp(`:${roomId}:[0-9a-f-]{36}$`));
  const observer = await (await browser.newContext()).newPage();
  await observer.goto(`${fixture.origin}/health`);
  await observer.addScriptTag({ path: resolve("apps/runtime-web/node_modules/livekit-client/dist/livekit-client.umd.js") });
  const connect = (token: string) => observer.evaluate(async input => {
    const L = (window as any).LivekitClient, room = new L.Room();
    (window as any).__managedObserver = { room, disconnected: null as string | null };
    room.on(L.RoomEvent.Disconnected, (reason: unknown) => { (window as any).__managedObserver.disconnected = String(reason); });
    try { await room.connect(input.url, input.token); return true; } catch { return false; }
  }, { url: livekit.url, token });
  expect(await connect(mediaToken)).toBe(true);
  const validate = async (token: string) => (await fetch(`${livekit.httpUrl}/rtc/validate?access_token=${encodeURIComponent(token)}`)).status;
  expect(await validate(mediaToken)).toBe(200);

  // Close: room-state sockets end within a second, the old epoch room is deleted and its JWT no longer joins anything.
  const closed = await integration(request, "POST", `/integration/v1/tenants/${tenantId}/rooms/${roomId}/close`, { expectedRevision: 0, reason: "e2e" });
  expect(closed.body.status).toBe("closed");
  for (const page of [creator, guest]) {
    await expect(page.locator("#room-access-ended")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#room-access-ended-title")).toHaveText("This room has ended");
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(false);
  }
  await expect.poll(epochRooms, { timeout: 15_000 }).toEqual([]);
  await expect.poll(() => observer.evaluate(() => (window as any).__managedObserver.disconnected), { timeout: 15_000 }).not.toBeNull();
  // With auto_create:false nothing recreates the deleted epoch room, so the still unexpired JWT joins nothing.
  expect(await validate(mediaToken)).toBe(404);
  const reopened = await request.post(`${fixture.origin}/api/tokens/state`, { data: { identityProtocolVersion: 2, roomId, identityCredential } });
  expect(reopened.status()).toBe(410);
});
