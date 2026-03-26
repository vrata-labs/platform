import { expect, test } from "@playwright/test";

test("room shell loads and presence is registered", async ({ page, request }) => {
  await page.goto("/rooms/demo-room");
  await page.waitForTimeout(3000);

  await expect(page.locator("#room-name")).toContainText("meeting-room-basic - demo-room");
  await expect(page.locator("#status-line")).toContainText("Joined as");

  const debug = await page.evaluate(() => (window as Window & { __NOAH_DEBUG__?: unknown }).__NOAH_DEBUG__);
  expect(debug).toBeTruthy();

  const presenceResponse = await request.get("/api/rooms/demo-room/presence");
  const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
  expect(presence.items.length).toBeGreaterThan(0);
});

test("two participants can coexist in same room", async ({ browser, request }) => {
  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  await pageA.goto("http://127.0.0.1:4000/rooms/demo-room");
  await pageB.goto("http://127.0.0.1:4000/rooms/demo-room");
  await pageA.waitForTimeout(4000);
  await pageB.waitForTimeout(4000);

  const debugA = await pageA.evaluate(() => (window as Window & { __NOAH_DEBUG__?: { remoteAvatarCount: number } }).__NOAH_DEBUG__);
  const debugB = await pageB.evaluate(() => (window as Window & { __NOAH_DEBUG__?: { remoteAvatarCount: number } }).__NOAH_DEBUG__);

  expect(debugA?.remoteAvatarCount).toBeGreaterThanOrEqual(1);
  expect(debugB?.remoteAvatarCount).toBeGreaterThanOrEqual(1);

  const presenceResponse = await request.get("http://127.0.0.1:4000/api/rooms/demo-room/presence");
  const presence = (await presenceResponse.json()) as { items: Array<{ participantId: string }> };
  expect(presence.items.length).toBeGreaterThanOrEqual(2);

  await pageA.close();
  await pageB.close();
});
