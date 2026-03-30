import { expect, test } from "@playwright/test";

const stagingRoomId = process.env.STAGING_ROOM_ID;
const stagingTargetRoomId = process.env.STAGING_TARGET_ROOM_ID;

test.describe("@staging runtime HUD space selector", () => {
  test.skip(!stagingRoomId || !stagingTargetRoomId, "STAGING_ROOM_ID and STAGING_TARGET_ROOM_ID are required");

  test("selector is visible for the configured staging room", async ({ page, baseURL }) => {
    const currentBaseUrl = baseURL ?? "http://127.0.0.1:4000";
    await page.goto(`${currentBaseUrl}/rooms/${stagingRoomId}`);
    await expect(page.locator("#room-name")).not.toContainText("Loading room");
    await expect(page.locator("#space-select")).toBeVisible();

    const options = await page.locator("#space-select option").allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(2);
  });

  test("selector switches to the configured staging target room", async ({ page, baseURL }) => {
    const currentBaseUrl = baseURL ?? "http://127.0.0.1:4000";
    await page.goto(`${currentBaseUrl}/rooms/${stagingRoomId}`);
    const targetRoomLink = new URL(`/rooms/${stagingTargetRoomId!}`, currentBaseUrl).toString();
    await page.selectOption("#space-select", { value: targetRoomLink });
    await page.waitForURL(`**/rooms/${stagingTargetRoomId!}`);
    await expect(page.locator("#room-name")).toContainText(stagingTargetRoomId!);
  });
});
