import { test, expect, type APIRequestContext, type Page, type WebSocketRoute } from "@playwright/test";
import { createLegacyStagingRoom, releaseLegacyStagingRoom } from "./staging-legacy-room";

// The migration server is deliberately not enabled in S1. Inject only its wire
// denial; exercise the published client shutdown/UI through normal entry.
test.use({ trace: "off", screenshot: "off", video: "off", viewport: { width: 390, height: 844 } });

async function fixture(request: APIRequestContext, staging: boolean) {
  const headers = { "x-vrata-admin-token": staging ? process.env.STAGING_ADMIN_TOKEN! : "test-admin-token" };
  const response = await createLegacyStagingRoom(request, "normal-product", { headers, data: {
    tenantId: "demo-tenant", templateId: "personal-workspace-basic", name: "Session upgrade regression",
    features: { voice: false, screenShare: false, spatialAudio: false }
  } });
  expect(response.ok()).toBe(true);
  const { roomId } = await response.json();
  try {
    const invite = await request.post(`/api/rooms/${roomId}/invites`, { headers, data: { role: "host", expiresInSeconds: 600 } });
    expect(invite.ok()).toBe(true);
    const { inviteId, inviteLink } = await invite.json();
    return { roomId: roomId as string, inviteLink: inviteLink as string, close: async () => {
      expect((await request.post(`/api/rooms/${roomId}/invites/${inviteId}/revoke`, { headers })).ok()).toBe(true);
      expect((await releaseLegacyStagingRoom(request, roomId, { headers })).ok()).toBe(true);
    } };
  } catch (error) {
    await releaseLegacyStagingRoom(request, roomId, { headers });
    throw error;
  }
}

async function enter(page: Page, link: string) {
  try { await page.goto(link, { waitUntil: "domcontentloaded" }); }
  catch { throw new Error("session_upgrade_test_navigation_failed"); }
  await expect(page.locator("#guest-onboarding")).toBeVisible();
  await page.evaluate(() => history.replaceState(null, "", location.pathname));
  await page.locator("#guest-name-input").fill("Migration participant");
  await page.locator("#guest-enter-without-audio").click();
}

const denial = (reason = "identity_upgrade_required") => ({ status: reason === "identity_upgrade_required" ? 426 : 409,
  contentType: "application/json", body: JSON.stringify({ error: "identity_required", reason, detail: "NEVER_RENDER_SERVER_DETAIL" }) });

for (const staging of [false, true]) {
  test.describe(staging ? "@staging session upgrade preparation" : "session upgrade preparation", () => {
    test("boot denial explains rejoin, retains identity and prevents same-build reload loops", async ({ page, request }) => {
      test.setTimeout(90_000);
      const room = await fixture(request, staging);
      try {
        expect((await request.get(`/rooms/${room.roomId}`)).headers()["cache-control"]).toBe("no-cache");
        await page.addInitScript(() => {
          sessionStorage.setItem("vrata.participantId", "session-upgrade-tab");
          sessionStorage.setItem("noah.participantId", "session-upgrade-legacy");
          localStorage.setItem("vrata.personalOwnerId", "session-upgrade-owner");
        });
        await page.route("**/api/tokens/state", route => {
          expect(route.request().postDataJSON().identityProtocolVersion).toBeUndefined();
          return route.fulfill(denial());
        });
        await enter(page, room.inviteLink);
        const dialog = page.locator("#session-upgrade-dialog");
        await expect(dialog).toBeVisible();
        await expect(page.locator("#session-upgrade-title")).toHaveText("Update required to rejoin this room");
        await expect(page.locator("#session-upgrade-reload")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await expect(dialog).not.toContainText("NEVER_RENDER_SERVER_DETAIL");
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        await Promise.all([page.waitForEvent("load"), page.locator("#session-upgrade-reload").click()]);
        await expect.poll(async () => await dialog.isVisible() || await page.locator("#guest-onboarding").isVisible()).toBe(true);
        if (await page.locator("#guest-onboarding").isVisible()) await page.locator("#guest-enter-without-audio").click();
        await expect(dialog).toBeVisible();
        await expect(page.locator("#session-upgrade-message")).toContainText("Updating did not restore access");
        await expect(page.locator("#session-upgrade-reload")).toBeHidden();
        expect(await page.evaluate(() => ({ id: sessionStorage.getItem("vrata.participantId"),
          legacy: sessionStorage.getItem("noah.participantId"), owner: localStorage.getItem("vrata.personalOwnerId") })))
          .toEqual({ id: "session-upgrade-tab", legacy: "session-upgrade-legacy", owner: "session-upgrade-owner" });
      } finally { await page.goto("about:blank"); await room.close(); }
    });

    test("live REST denial protects the draft, blocks old requests and does not republish it on rejoin", async ({ page, request }) => {
      test.setTimeout(120_000);
      const room = await fixture(request, staging);
      let releasePoll: (() => void) | undefined;
      try {
        await enter(page, room.inviteLink);
        await expect(page.locator("#notes-editor")).toBeEnabled({ timeout: 30_000 });
        await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
        const before = await page.locator("#notes-editor").inputValue();
        const scope = await page.locator("#notes-scope-select").inputValue();
        let writes = 0;
        await page.route(`**/api/rooms/${room.roomId}/notes/*`, async route => {
          if (route.request().method() !== "PUT") return route.continue();
          writes++;
          return route.fulfill(denial());
        });
        // Hold a valid response issued before the denial, then deliver it late.
        let pollStarted!: () => void;
        const started = new Promise<void>(resolve => { pollStarted = resolve; });
        const delayed = new Promise<void>(resolve => { releasePoll = resolve; });
        await page.route(`**/api/rooms/${room.roomId}/session-control`, async route => {
          const response = await route.fetch();
          pollStarted();
          await delayed;
          await route.fulfill({ response }).catch(() => undefined);
        }, { times: 1 });
        await started;
        const draft = `Local-only migration draft ${Date.now()} <script>not HTML</script>`;
        await page.locator("#notes-editor").fill(draft);
        await expect(page.locator("#session-upgrade-dialog")).toBeVisible();
        await expect(page.locator(`#session-upgrade-draft-${scope}`)).toHaveValue(draft);
        releasePoll();
        await page.waitForTimeout(1500);
        const requests: string[] = [];
        page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.method()); });
        await page.waitForTimeout(1500);
        expect(requests).toEqual([]);
        expect(writes).toBe(1);
        expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(false);
        await page.unroute(`**/api/rooms/${room.roomId}/notes/*`);
        await Promise.all([page.waitForEvent("load"), page.locator("#session-upgrade-reload").click()]);
        // Re-open the invitation, since test URLs deliberately redact its query.
        await enter(page, room.inviteLink);
        await expect(page.locator("#notes-editor")).toBeEnabled({ timeout: 30_000 });
        await expect(page.locator("#notes-editor")).toHaveValue(before);
        await expect(page.locator("#session-upgrade-dialog")).not.toBeVisible();
        await expect(page.locator(`#session-upgrade-draft-${scope}`)).toHaveValue(draft);
        await expect(page.locator(`#session-upgrade-draft-${scope}`)).toHaveAttribute("readonly", "");
        await page.locator("#session-upgrade-discard-drafts").click();
        await expect(page.locator("#session-upgrade-drafts")).toBeHidden();
      } finally { releasePoll?.(); await page.goto("about:blank"); await room.close(); }
    });

    test("room-state recovery close stops reconnect and explains administrator recovery", async ({ page, request }) => {
      test.setTimeout(90_000);
      const room = await fixture(request, staging);
      const sockets: WebSocketRoute[] = [];
      try {
        await page.routeWebSocket(/.*[?&]roomId=/, route => { sockets.push(route); route.connectToServer(); });
        await enter(page, room.inviteLink);
        await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
        expect(sockets.length).toBeGreaterThan(0);
        const count = sockets.length;
        await sockets.at(-1)!.close({ code: 4409, reason: "identity_recovery_required" });
        await expect(page.locator("#session-upgrade-dialog")).toBeVisible();
        await expect(page.locator("#session-upgrade-title")).toHaveText("Room access needs recovery");
        await expect(page.locator("#session-upgrade-message")).toContainText("Contact the room administrator");
        await expect(page.locator("#session-upgrade-reload")).toBeHidden();
        await page.waitForTimeout(2500);
        expect(sockets.length).toBe(count);
        expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(false);
      } finally { await page.goto("about:blank"); await room.close(); }
    });
  });
}
