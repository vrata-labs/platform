import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";

// Entry from the portal: the room speaks the participant's language, "Leave the space" returns to the page the grant
// came from (the platform's allowlist, never a URL from the grant), and a reload, Back or a language switch keeps the room.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ mode: "serial" });
const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const tenantId = `pt_${Array.from({ length: 26 }, () => ULID[randomInt(ULID.length)]).join("")}`;
const key = () => `key_${randomUUID().replaceAll("-", "")}`;
const policy = { policyId: "qa-demo-v1", templates: ["meeting-room-basic"], absoluteLifetimeSeconds: 1800, idleTimeoutSeconds: 600,
  maxParticipants: 4, features: { voice: false, screenShare: false, documents: false, upload: false, remoteBrowser: false } };
const returnTargets = {
  "catalog-entry": { ru: "https://ru.portal.test/demos/{id}", en: "https://en.portal.test/demos/{id}" },
  fallback: { ru: "https://ru.portal.test/", en: "https://en.portal.test/" }
};

let fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>>;
let sign: () => string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  const assertions = await import(pathToFileURL(resolve("apps/api/dist/testing/integration-assertions.js")).href);
  const signer = assertions.createIntegrationTestKey("portal-stage-e2e", "portal:stage");
  sign = () => assertions.signIntegrationAssertion(signer);
  fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, {
    identityProtocol: 2, devRoleQuery: false,
    extraEnv: origin => ({
      VRATA_PORTAL_MANAGED: "true", VRATA_ADHOC_ROOMS: "false", VRATA_INTEGRATION_KEYS: assertions.integrationKeysEnv([signer]),
      VRATA_DEMO_POLICIES: JSON.stringify([policy]), VRATA_RETURN_TARGETS: JSON.stringify(returnTargets), RUNTIME_BASE_URL: origin
    })
  });
});
test.afterAll(async () => { await fixture?.close(); });

async function integration(request: APIRequestContext, method: "PUT" | "POST", path: string, body: unknown) {
  const response = await request.fetch(`${fixture.origin}${path}`, { method, data: body, headers: { authorization: `Bearer ${sign()}`, "idempotency-key": key() } });
  return { status: response.status(), body: await response.json() };
}

let tenantReady = false;
async function demoEntry(request: APIRequestContext, returnContext?: unknown) {
  if (!tenantReady) {
    expect((await integration(request, "PUT", `/integration/v1/tenants/${tenantId}`, { displayName: "Demo" })).status).toBe(200);
    tenantReady = true;
  }
  const room = await integration(request, "POST", `/integration/v1/tenants/${tenantId}/rooms`, {
    kind: "demo-instance", template: { templateId: "meeting-room-basic", version: "2.0.0" }, name: "Demo meeting",
    accessUntil: new Date(Date.now() + 1_200_000).toISOString(), demoPolicyId: "qa-demo-v1" });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  const grant = await integration(request, "POST", `/integration/v1/tenants/${tenantId}/rooms/${room.body.roomId}/grants`,
    { role: "guest", purpose: "invite", maxUses: 2, ...(returnContext ? { returnContext } : {}) });
  expect(grant.status, JSON.stringify(grant.body)).toBe(201);
  return { roomId: room.body.roomId as string, entryUrl: grant.body.entryUrl as string };
}

// The portal pages are not served here: the browser gets a stub for every portal.test address.
async function portalContext(browser: import("@playwright/test").Browser, cookieLocale?: "ru" | "en"): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: "en-US" });
  await context.route(/^https:\/\/[a-z]+\.portal\.test\//, route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>portal</title><h1 id=\"portal-page\">portal</h1>" }));
  if (cookieLocale) await context.addCookies([{ name: "vrata-locale", value: cookieLocale, url: fixture.origin }]);
  return context;
}

const debug = (page: Page) => page.evaluate(() => {
  const state = (window as any).__VRATA_DEBUG__;
  return { connected: Boolean(state?.roomStateConnected), participantId: state?.participantId as string | undefined };
});

async function enter(page: Page, entryUrl: string, name: string, button = "#guest-enter-without-audio") {
  await page.goto(entryUrl);
  expect(page.url()).not.toContain("grant=");
  await page.locator("#guest-name-input").fill(name);
  await page.locator(button).click({ noWaitAfter: true });
  await expect.poll(async () => (await debug(page)).connected, { timeout: 60_000 }).toBe(true);
}

test("a Russian guest gets the room in Russian, switches language in place, and a reload keeps the room", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const { entryUrl } = await demoEntry(request, { kind: "catalog-entry", id: "meeting-room", locale: "ru" });
  const context = await portalContext(browser, "ru");
  try {
    const page = await context.newPage();
    await page.goto(entryUrl);
    await expect(page.locator("#guest-onboarding-title")).toHaveText("Вход в комнату");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.locator("#guest-enter-without-audio")).toHaveText("Войти без звука");
    await page.locator("#guest-name-input").fill("Аня");
    await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
    await expect.poll(async () => (await debug(page)).connected, { timeout: 60_000 }).toBe(true);
    await expect(page.locator("#leave-space")).toHaveText("Покинуть пространство");
    await expect(page.locator("#meeting-nav-people")).toHaveText("Участники");
    const roomUrl = page.url();
    const { participantId } = await debug(page);

    await page.locator("#language-select").selectOption("en");
    await expect(page.locator("#leave-space")).toHaveText("Leave the space");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(page.url()).toBe(roomUrl);
    expect(await debug(page)).toEqual({ connected: true, participantId });

    await page.reload();
    await expect.poll(async () => (await debug(page)).connected, { timeout: 60_000 }).toBe(true);
    expect((await debug(page)).participantId).toBe(participantId);
    await expect(page.locator("#guest-onboarding")).toBeHidden();
    await expect(page.locator("#leave-space")).toHaveText("Leave the space", { timeout: 1000 });
  } finally {
    await context.close();
  }
});

test("leaving the space removes the presence and returns to the card; Back enters the same room again", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const { roomId, entryUrl } = await demoEntry(request, { kind: "catalog-entry", id: "meeting-room", locale: "ru" });
  const context = await portalContext(browser);
  try {
    const page = await context.newPage();
    await enter(page, entryUrl, "Guest");
    await expect(page.locator("html")).toHaveAttribute("lang", "en", { timeout: 1000 });
    const { participantId } = await debug(page);
    const presenceRemoved = page.waitForRequest(request => request.method() === "DELETE" && request.url().includes(`/api/rooms/${roomId}/presence/`));
    await page.locator("#leave-space").click();
    await presenceRemoved;
    // An English browser goes to the English card, whatever language the inviter had.
    await page.waitForURL("https://en.portal.test/demos/meeting-room");
    await expect(page.locator("#portal-page")).toBeVisible();

    await page.goBack();
    await expect.poll(async () => (await debug(page)).connected, { timeout: 60_000 }).toBe(true);
    expect((await debug(page)).participantId).toBe(participantId);
    expect(new URL(page.url()).pathname).toBe(`/rooms/${roomId}`);
  } finally {
    await context.close();
  }
});

test("without a return context the fallback page is the way back, and the left screen appears without any", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const context = await portalContext(browser, "ru");
  try {
    const page = await context.newPage();
    await enter(page, (await demoEntry(request)).entryUrl, "Гость");
    await page.locator("#leave-space").click();
    await page.waitForURL("https://ru.portal.test/");

    // A tab that lost its way back (here: removed by hand) leaves to the left screen and can come back.
    const second = await context.newPage();
    await enter(second, (await demoEntry(request)).entryUrl, "Гость");
    await second.evaluate(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith("vrata.return.")) sessionStorage.removeItem(key); });
    await second.reload();
    await expect.poll(async () => (await debug(second)).connected, { timeout: 60_000 }).toBe(true);
    await second.locator("#leave-space").click();
    await expect(second.locator("#space-left")).toBeVisible();
    await expect(second.locator("#space-left-title")).toHaveText("Вы покинули пространство");
    await expect.poll(async () => (await debug(second)).connected).toBe(false);
    await second.locator("#space-left-rejoin").click();
    await expect.poll(async () => (await debug(second)).connected, { timeout: 60_000 }).toBe(true);
  } finally {
    await context.close();
  }
});

test("a refused microphone is explained in the guest's language and the guest still enters", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const context = await portalContext(browser, "ru");
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const devices = navigator.mediaDevices;
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
        enumerateDevices: devices?.enumerateDevices?.bind(devices) ?? (async () => []),
        getUserMedia: async () => { throw new DOMException("blocked", "NotAllowedError"); }
      } });
    });
    await page.goto((await demoEntry(request, { kind: "catalog-entry", id: "meeting-room", locale: "ru" })).entryUrl);
    await page.locator("#guest-name-input").fill("Без звука");
    await page.locator("#guest-check-microphone").click();
    await expect(page.locator("#guest-onboarding-status")).toHaveText(/Браузер запретил доступ к микрофону/);
    await expect(page.locator("#guest-join-muted")).toBeChecked();
    await page.locator("#guest-enter-room").click({ noWaitAfter: true });
    await expect.poll(async () => (await debug(page)).connected, { timeout: 60_000 }).toBe(true);
    expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.media?.publishedAudio)).toBe(false);
  } finally {
    await context.close();
  }
});
