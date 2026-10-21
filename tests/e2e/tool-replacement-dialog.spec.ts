import { expect, test, type Page } from "@playwright/test";
import { startReferenceTemplateFixture } from "./reference-template-fixture";
import { chooseMeetingPanel, meetingRequest, installMeetingPerformanceObservation, readMeetingPerformance } from "./meeting-tools-acceptance";

test.use({ trace: "off", screenshot: "off", video: "off", actionTimeout: 30_000 });
for (const staging of [false, true]) for (const mobile of [false, true]) test(`${staging ? "@staging " : ""}replacement dialog normal-DPR ${mobile ? "Android viewport" : "desktop"}: focus, warning and reconnect cancellation`, async ({ browser, request }, testInfo) => {
  // This is cumulative functional/visual work on a software-rendered full-DPR
  // scene, not an interaction-latency benchmark. Individual waits stay bounded.
  test.setTimeout(mobile ? 180_000 : 300_000); if (!staging) expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  const startedAt = Date.now(); const phases: Array<{ phase: string; atMs: number }> = [];
  let phase = "fixture-setup"; const mark = (value: string) => { phase = value; phases.push({ phase, atMs: Date.now()-startedAt }); };
  if (staging) expect(!!process.env.BASE_URL && !!process.env.STAGING_ADMIN_TOKEN).toBe(true);
  const fixture = staging ? { origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN!, close: async () => {} }
    : await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { devRoleQuery: false });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 }, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile });
  let page: Page | undefined;
  let roomId: string | undefined;
  try {
    const headers = { "x-vrata-admin-token": fixture.adminToken };
    mark("create-room");
    const created = await meetingRequest(() => request.post(`${fixture.origin}/api/rooms`, { headers, data: { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned replacement dialog" } }));
    expect(created.status()).toBe(201); roomId = (await created.json()).roomId;
    mark("create-invitation");
    const invitation = await meetingRequest(() => request.post(`${fixture.origin}/api/rooms/${roomId}/invites`, { headers, data: { role: "host", expiresInSeconds: 600 } }));
    expect(invitation.status()).toBe(201); page = await context.newPage(); await installMeetingPerformanceObservation(page);
    mark("navigate");
    try { await page.goto((await invitation.json()).inviteLink); } catch { throw new Error("replacement_dialog_navigation_failed"); }
    mark("onboarding-input"); await page.locator("#guest-name-input").fill("Dialog host");
    mark("onboarding-submit"); await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
    mark("scene-load");
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90_000 }).toBe("loaded");
    mark("board-navigation"); await chooseMeetingPanel(page, "board", mobile); await page.locator("#meeting-use-board-surface").click();
    mark("sticky-start"); await page.locator("#start-markdown-board").click();
    mark("sticky-input"); await page.locator("#markdown-board-note-text").fill("Keep the current decisions until confirmed");
    mark("sticky-add");
    await page.locator("#add-sticky-note").click(); await expect(page.locator("#markdown-board-status")).toContainText("1 note");
    mark("replacement-request"); await page.locator("#media-surface-select").selectOption("debug-main"); await page.locator("#start-whiteboard").click({ noWaitAfter: true });
    mark("dialog-assertions");
    const dialog = page.getByRole("dialog", { name: "Replace surface content?" }); await expect(dialog).toBeVisible();
    // One coherent read-only renderer sample replaces repeated protocol/layout
    // round trips; normal DPR, numeric bounds and native actions stay intact.
    await expect.poll(() => page!.evaluate(viewport => {
      const dialog = document.querySelector<HTMLDialogElement>("#meeting-replace-dialog")!, rect = dialog.getBoundingClientRect();
      return { open: dialog.open, cancelFocused: document.activeElement?.id === "meeting-replace-cancel",
        warning: document.getElementById("meeting-replace-explanation")!.textContent!.includes("Its current notes or strokes will be removed"),
        normalViewport: innerWidth === viewport.width && innerHeight === viewport.height && devicePixelRatio === 1,
        sameRoom: location.pathname === viewport.path,
        inBounds: rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.right <= viewport.width && rect.bottom <= viewport.height,
        targets: ["meeting-replace-cancel","meeting-replace-confirm"].every(id => {
          const box = document.getElementById(id)!.getBoundingClientRect(); return box.width >= 48 && box.height >= 48;
        }) };
    }, { width: mobile ? 390 : 1280, height: mobile ? 844 : 720, path: `/rooms/${roomId}` })).toEqual({ open: true, cancelFocused: true,
      warning: true, normalViewport: true, sameRoom: true, inBounds: true, targets: true });
    mark("keyboard-cycle"); await page.keyboard.press("Tab"); await expect(page.locator("#meeting-replace-confirm")).toBeFocused();
    await page.keyboard.press("Tab"); await expect(page.locator("#meeting-replace-cancel")).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(page.locator("#meeting-replace-confirm")).toBeFocused();
    await page.keyboard.press("Tab"); await expect(page.locator("#meeting-replace-cancel")).toBeFocused();
    mark("screenshot"); await page.screenshot({ path: testInfo.outputPath("replacement-dialog.png") });
    mark("cancel"); await page.keyboard.press("Escape");
    await expect.poll(() => page!.evaluate(() => ({ closed: !document.querySelector<HTMLDialogElement>("#meeting-replace-dialog")!.open,
      focusRestored: document.activeElement?.id === "start-whiteboard" }))).toEqual({ closed: true, focusRestored: true });
    mark("reconnect-request"); await expect(page.locator("#start-whiteboard")).toBeEnabled();
    if (mobile) await page.locator("#start-whiteboard").click({ timeout: 15_000, noWaitAfter: true });
    else {
      // The first opening covers the pointer path; reopen from the restored
      // focus with real keyboard input before exercising reconnect cancellation.
      await test.step("reopen from restored keyboard focus", async () => {
        await expect(page.locator("#start-whiteboard")).toBeFocused();
        await page.keyboard.press("Enter");
      }, { timeout: 15_000 });
    }
    await expect(dialog).toBeVisible();
    await expect(page.locator("#meeting-replace-cancel")).toBeFocused();
    expect(new URL(page.url()).pathname === `/rooms/${roomId}`).toBe(true);
    mark("force-reconnect"); await test.step("close the owned room-state socket", () => page!.evaluate(() => (window as any).__VRATA_TEST__.forceRoomStateReconnect()), { timeout: 10_000 });
    mark("reconnect-assertions");
    await expect.poll(() => page!.evaluate(() => ({ closed: !document.querySelector<HTMLDialogElement>("#meeting-replace-dialog")!.open,
      cancellation: document.getElementById("meeting-transition-status")!.textContent!.includes("pending action was cancelled") }))).toEqual({ closed: true, cancellation: true });
    mark("complete");
  } catch (error) {
    console.warn("replacement_dialog_failed", JSON.stringify({ phase, phases, mobile, staging, elapsedMs: Date.now()-startedAt,
      performance: page ? await readMeetingPerformance(page) : { unavailable: true } }));
    throw error;
  } finally {
    console.info("replacement_dialog_cleanup", JSON.stringify({ phase, phases, mobile, staging, elapsedMs: Date.now()-startedAt }));
    await context.close();
    if (roomId) expect((await meetingRequest(() => request.delete(`${fixture.origin}/api/rooms/${roomId}`, { headers: { "x-vrata-admin-token": fixture.adminToken } }))).ok()).toBe(true);
    await fixture.close();
  }
});
