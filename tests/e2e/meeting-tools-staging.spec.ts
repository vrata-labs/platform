import { expect, test } from "@playwright/test";
import { chooseMeetingPanel } from "./meeting-tools-acceptance";

test.use({ trace: "off", screenshot: "off", video: "off" });

for (const mobile of [false, true]) {
  test(`@staging meeting tools: ${mobile ? "Android viewport touch" : "desktop keyboard"} navigation for Host, Member and Guest`, async ({ browser, request }) => {
    test.setTimeout(600_000);
    const headers = { "x-vrata-admin-token": process.env.STAGING_ADMIN_TOKEN ?? "" };
    const created = await request.post("/api/rooms", { headers, data: {
      tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned meeting tools acceptance"
    } });
    expect(created.status()).toBe(201);
    const room = await created.json();
    try {
      for (const role of ["host", "member", "guest"] as const) {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
          hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 0.5 });
        try {
          const page = await context.newPage();
          await page.addInitScript(() => {
            const counts = { microphone: 0, screen: 0 }; (window as any).__meetingCaptureCounts = counts;
            for (const [method, key] of [["getUserMedia", "microphone"], ["getDisplayMedia", "screen"]] as const) {
              const original = navigator.mediaDevices?.[method];
              if (!original) continue;
              Object.defineProperty(navigator.mediaDevices, method, { configurable: true, writable: true, value: (...args: any[]) => {
                counts[key]++; return Reflect.apply(original, navigator.mediaDevices, args);
              } });
            }
          });
          const invited = await request.post(`/api/rooms/${room.roomId}/invites`, { headers, data: { role, expiresInSeconds: 600 } });
          expect(invited.status()).toBe(201);
          const invitation = await invited.json();
          const admission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
          void admission.catch(() => undefined);
          try { await page.goto(invitation.inviteLink); }
          catch { throw new Error("meeting_staging_navigation_failed"); }
          await expect(page.locator("#guest-onboarding")).toBeVisible();
          await page.locator("#guest-name-input").fill(`Tools ${role}`);
          await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
          const issued = await (await admission).json();
          expect(issued.access.role).toBe(role);
          await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
          await expect(page.getByRole("navigation", { name: "Meeting tools" })).toBeVisible();
          const selected = await page.locator("#media-surface-select").inputValue();
          for (const section of ["audio", "present", "board", "notes", "people"] as const) {
            await chooseMeetingPanel(page, section, mobile);
            await expect(page.locator("#media-surface-select")).toHaveValue(selected);
          }
          await expect(page.locator("#meeting-people-list")).toContainText(`Tools ${role}`, { timeout: 15_000 });
          if (!mobile) {
            await page.keyboard.press("Escape"); await expect(page.locator("#meeting-nav-people")).toBeFocused();
            await page.keyboard.press("Shift+Tab"); await expect(page.locator("#meeting-nav-notes")).toBeFocused();
          }
          expect(await page.evaluate(() => (window as any).__meetingCaptureCounts)).toEqual({ microphone: 0, screen: 0 });
          if (role !== "host") {
            await page.locator("#meeting-nav-present").click();
            await expect(page.locator("#document-upload-button")).toBeDisabled();
            await expect(page.locator("#meeting-present-status")).toContainText("Host or Presenter");
          }
        } finally { await context.close(); }
      }
    } finally {
      expect((await request.delete(`/api/rooms/${room.roomId}`, { headers })).ok()).toBe(true);
    }
  });
}
