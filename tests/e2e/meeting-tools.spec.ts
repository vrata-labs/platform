import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startReferenceTemplateFixture } from "./reference-template-fixture";

test.use({ trace: "off", screenshot: "off", video: "off" });
type Fixture = Awaited<ReturnType<typeof startReferenceTemplateFixture>>;
let fixture: Fixture;
const sections = ["audio", "present", "board", "notes", "people"] as const;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { devRoleQuery: false,
    stateTokenSecret: "owned-meeting-tools-state-secret-32-bytes" });
});
test.afterAll(async () => { test.setTimeout(120_000); await fixture?.close(); });

async function enter(page: Page, invitation: string, displayName: string) {
  const pageErrors: string[] = [];
  page.on("pageerror", error => {
    if (pageErrors.length < 8) {
      const category = /^missing_meeting_ui_element:[a-z0-9-]+$/.test(error.message) ? error.message
        : ["Error", "TypeError", "ReferenceError", "RangeError", "DOMException"].includes(error.name) ? error.name : "OtherError";
      const property = /Cannot (?:read|set) properties of (?:undefined|null) \((?:reading|setting) '([A-Za-z][A-Za-z0-9_]{0,40})'\)/.exec(error.message)?.[1];
      const frames = [...(error.stack ?? "").matchAll(/\/assets\/([A-Za-z0-9._-]{1,80}):(\d+):(\d+)/g)].slice(0, 4).map(match => `${match[1]}:${match[2]}:${match[3]}`);
      pageErrors.push(JSON.stringify({ category, property, frames }));
    }
  });
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
  const admission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
  void admission.catch(() => undefined);
  // Normal trusted invitation and onboarding. No role/debug/onboard override.
  try { await page.goto(invitation); }
  catch { void admission.catch(() => undefined); throw new Error("meeting_room_navigation_failed"); }
  try { await expect(page.locator("#guest-onboarding")).toBeVisible(); }
  catch {
    const facts = await page.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__, query = new URL(location.href).searchParams;
      return { debugPresent: !!debug, invitePresent: query.has("invite"), onboardDisabled: query.get("onboard") === "0", bot: query.has("bot"),
        onboardingRequired: debug?.guestOnboarding?.required, onboardingCompleted: debug?.guestOnboarding?.completed,
        sceneState: debug?.sceneBundleState, issue: debug?.issueCode, navigationPresent: !!document.getElementById("meeting-nav") };
    });
    throw new Error(`meeting_onboarding_not_ready:${JSON.stringify({ facts, pageErrors })}`);
  }
  await page.locator("#guest-name-input").fill(displayName);
  await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  const issued = await (await admission).json();
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90_000 }).toBe("loaded");
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
  return issued;
}

async function choosePanel(page: Page, section: typeof sections[number], touch: boolean) {
  const button = page.locator(`#meeting-nav-${section}`);
  if (touch) await button.tap();
  else { await button.focus(); await page.keyboard.press("Enter"); }
  await expect(page.locator(`#meeting-${section}`)).toHaveAttribute("open", "");
  expect(await page.evaluate(id => document.activeElement === document.querySelector(`#meeting-${id} > summary`), section)).toBe(true);
  const nav = await page.locator("#meeting-nav").boundingBox(), summary = await page.locator(`#meeting-${section} > summary`).boundingBox();
  expect(!!nav && !!summary && summary.y >= nav.y + nav.height - 1).toBe(true);
}

for (const mobile of [false, true]) {
  for (const role of ["host", "member", "guest"] as const) test(`meeting tools ${mobile ? "Android viewport" : "desktop"}: ${role} finds tools without capture or implicit surface changes`, async ({ browser, request }) => {
    test.setTimeout(180_000);
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
        hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 0.5 });
      const page = await context.newPage(), headers = { "x-vrata-admin-token": fixture.adminToken };
      const created = await request.post(`${fixture.origin}/api/rooms`, { headers, data: { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned tools navigation" } });
      expect(created.status()).toBe(201); const room = await created.json();
      const invitation = await request.post(`${fixture.origin}/api/rooms/${room.roomId}/invites`, { headers, data: { role, expiresInSeconds: 600 } });
      expect(invitation.status()).toBe(201);
      const issued = await enter(page, (await invitation.json()).inviteLink, `Tools ${role}`);
      expect(issued.access.role).toBe(role);
      await expect(page.getByRole("navigation", { name: "Meeting tools" })).toBeVisible();
      await expect(page.locator("#media-surface-select")).toHaveValue("debug-main");
      for (const section of sections) {
        await choosePanel(page, section, mobile);
        await expect(page.locator("#media-surface-select")).toHaveValue("debug-main");
        const box = await page.locator(`#meeting-nav-${section}`).boundingBox();
        expect(!!box && box.height >= 48 && box.width >= 48).toBe(true);
      }
      if (!mobile) {
        await page.keyboard.press("Escape"); await expect(page.locator("#meeting-nav-people")).toBeFocused();
        await page.keyboard.press("Shift+Tab"); await expect(page.locator("#meeting-nav-notes")).toBeFocused();
        await page.keyboard.press("Enter"); await expect(page.locator("#meeting-notes > summary")).toBeFocused();
      }
      expect(await page.evaluate(() => (window as any).__meetingCaptureCounts)).toEqual({ microphone: 0, screen: 0 });
      expect(await page.evaluate(() => location.hash === "")).toBe(true);
      await choosePanel(page, "board", mobile);
      await expect(page.locator("#meeting-use-board-surface")).toBeVisible();
      if (mobile) await page.locator("#meeting-use-board-surface").tap(); else await page.locator("#meeting-use-board-surface").click();
      await expect(page.locator("#media-surface-select")).toHaveValue("whiteboard-wall");
      await expect(page.locator("#meeting-board > summary")).toBeFocused();
      await expect(page.locator("#meeting-announcement")).toContainText("for board.");
      await choosePanel(page, "present", mobile);
      await expect(page.locator("#media-surface-select")).toHaveValue("whiteboard-wall");
      await page.locator("#meeting-use-presentation-surface").click();
      await expect(page.locator("#media-surface-select")).toHaveValue("debug-main");
      await expect(page.locator("#meeting-present > summary")).toBeFocused();
      if (role === "host") {
        await choosePanel(page, "notes", mobile);
        const before = await page.evaluate(() => ({ ...(window as any).__VRATA_DEBUG__.localPose.root }));
        await page.locator("#notes-editor").fill("WASD keyboard notes stay in the editor");
        await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowRight");
        await page.keyboard.press("End"); await page.keyboard.down("w");
        await page.evaluate(() => new Promise<void>(resolve => {
          let frames = 0; const next = () => { if (++frames >= 4) resolve(); else requestAnimationFrame(next); }; requestAnimationFrame(next);
        }));
        await page.keyboard.up("w");
        expect(await page.evaluate(() => ({ ...(window as any).__VRATA_DEBUG__.localPose.root }))).toEqual(before);
        await expect(page.locator("#notes-editor")).toHaveValue("WASD keyboard notes stay in the editorw");
        await choosePanel(page, "board", mobile);
        await page.locator("#meeting-use-board-surface").click();
        await expect(page.locator("#start-whiteboard")).toBeEnabled(); await page.locator("#start-whiteboard").click();
        await expect(page.locator("#start-whiteboard")).toBeDisabled();
        await expect(page.locator("#meeting-board-status")).toContainText("surface is in use");
        await expect(page.locator("#start-whiteboard")).toHaveAttribute("aria-describedby", /meeting-why-start-whiteboard/);
      } else {
        await choosePanel(page, "present", mobile);
        await expect(page.locator("#document-upload-button")).toBeDisabled();
        await expect(page.locator("#meeting-present-status")).toContainText("Host or Presenter");
        await expect(page.locator("#document-upload-button")).toHaveAttribute("aria-describedby", /meeting-why-document-upload-button/);
        if (role === "guest") {
          await choosePanel(page, "notes", mobile);
          await expect(page.locator("#notes-editor")).toBeDisabled();
          await expect(page.locator("#meeting-notes-status")).toContainText("View only");
        }
      }
      // A normal API-admitted colleague uses the same merged presence source as
      // the avatar/host UI. Their name is text, never HTML or a raw-ID fallback.
      const peerId = randomUUID(), otherInvite = await request.post(`${fixture.origin}/api/rooms/${room.roomId}/invites`, { headers, data: { role: "member", expiresInSeconds: 600 } });
      expect(otherInvite.status()).toBe(201);
      const other = await request.post(`${fixture.origin}/api/tokens/state`, { data: { roomId: room.roomId, participantId: peerId,
        inviteToken: (await otherInvite.json()).inviteToken, displayName: "Colleague" } }); expect(other.status()).toBe(200);
      const unsafeName = "<img src=x>";
      expect((await request.put(`${fixture.origin}/api/rooms/${room.roomId}/presence/${peerId}`, {
        headers: { authorization: `Bearer ${(await other.json()).token}` }, data: { participantId: peerId, displayName: unsafeName, mode: "desktop",
          rootTransform: { x: 2, y: 0, z: 2, yaw: 0 }, bodyTransform: { x: 2, y: 0.92, z: 2, yaw: 0 },
          headTransform: { x: 2, y: 1.6, z: 2, yaw: 0, pitch: 0 }, audioJoined: false, muted: true,
          speaking: false, activeMedia: { audio: false, screenShare: false }, seq: 1, clientTimeMs: Date.now() }
      })).status()).toBe(200);
      await choosePanel(page, "people", mobile);
      await expect(page.locator("#meeting-people-list bdi").filter({ hasText: unsafeName })).toHaveText(unsafeName, { timeout: 10_000 });
      await expect(page.locator("#meeting-people-list img")).toHaveCount(0);
      expect(await page.locator("#meeting-people-list").textContent()).not.toContain(peerId);
      const vrButton = page.locator(".vr-button");
      if (await vrButton.count()) expect(await vrButton.evaluate(button => button.parentElement?.id)).toBe("primary-controls");
      await expect(page.locator("#scene canvas")).toHaveAttribute("tabindex", "0");
      await expect(page.locator("#scene canvas")).toHaveAttribute("aria-label", /Room scene/);
    } finally { await context?.close(); }
  });
}

test("meeting tools explain unsupported capture without changing the producer or starting capture", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 0.5 });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => { if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, writable: true, value: undefined }); });
    const headers = { "x-vrata-admin-token": fixture.adminToken };
    const roomResponse = await request.post(`${fixture.origin}/api/rooms`, { headers, data: { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned unsupported capture" } }); expect(roomResponse.status()).toBe(201);
    const room = await roomResponse.json(), invite = await request.post(`${fixture.origin}/api/rooms/${room.roomId}/invites`, { headers, data: { role: "host", expiresInSeconds: 600 } }); expect(invite.status()).toBe(201);
    await enter(page, (await invite.json()).inviteLink, "No capture"); await choosePanel(page, "present", true);
    await expect(page.locator("#start-share")).toBeDisabled();
    await expect(page.locator("#meeting-present-status")).toContainText("Screen sharing is unsupported on this device");
    expect(await page.evaluate(() => (window as any).__meetingCaptureCounts)).toEqual({ microphone: 0, screen: 0 });
  } finally { await context.close(); }
});

test("meeting navigation preserves WASD after a button while native arrows stay in the HUD and blur releases keys", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 0.5 });
  try {
    const page = await context.newPage();
    await page.goto(new URL("/rooms/demo-room", process.env.BASE_URL ?? "http://127.0.0.1:4000").href);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
    await choosePanel(page, "audio", false);
    const pose = () => page.evaluate(() => ({ ...(window as any).__VRATA_DEBUG__.localPose.root }));
    const frames = () => page.evaluate(() => new Promise<void>(resolve => {
      let count = 0; const next = () => { if (++count >= 6) resolve(); else requestAnimationFrame(next); }; requestAnimationFrame(next);
    }));
    const before = await pose(); await page.keyboard.down("w"); await frames(); await page.keyboard.up("w");
    const moved = await pose(); expect(Math.abs(moved.x - before.x) + Math.abs(moved.z - before.z)).toBeGreaterThan(0.01);
    await page.keyboard.down("ArrowDown"); await frames(); await page.keyboard.up("ArrowDown");
    expect(await pose()).toEqual(moved);
    await page.keyboard.down("w"); await frames();
    await page.evaluate(() => window.dispatchEvent(new Event("blur"))); const stopped = await pose();
    await frames(); await page.keyboard.up("w"); expect(await pose()).toEqual(stopped);
  } finally { await context.close(); }
});
