import { expect, test, type Page } from "@playwright/test";

// The XR menu through the runtime's synthetic XR input (?debug=1&avatarvrmock=1): B or Y opens it in front of the head,
// the controller ray picks a button, locomotion rests meanwhile, and leaving takes a confirmed second press.
type Vector = { x: number; y: number; z: number };
type MenuDebug = { open: boolean; hovered: string | null; leaveArmed: boolean; lastCommand: string | null; head: Vector | null; buttons: Record<string, Vector> | null };

const menu = (page: Page) => page.evaluate(() => (window as any).__VRATA_DEBUG__?.xrMenu as MenuDebug);
const position = (page: Page) => page.evaluate(() => (window as any).__VRATA_DEBUG__?.localPosition as { x: number; z: number });

async function xr(page: Page, state: { at?: Vector; to?: Vector; trigger?: boolean; menu?: boolean; moveY?: number }) {
  const at = state.at ?? { x: 0, y: 1.4, z: 0 };
  const to = state.to ?? { x: at.x, y: at.y, z: at.z - 1 };
  await page.evaluate(input => (window as any).__VRATA_TEST__.setSyntheticXrState(input), {
    rightController: at, rayDirection: { x: to.x - at.x, y: to.y - at.y, z: to.z - at.z },
    axes: { moveX: 0, moveY: state.moveY ?? 0, turnX: 0, turnY: 0 },
    triggerPressed: state.trigger ?? false, menuPressed: state.menu ?? false, rayVisible: true
  });
}

async function press(page: Page, button: string) {
  const { head, buttons } = await menu(page);
  await xr(page, { at: head!, to: buttons![button] });
  await expect.poll(async () => (await menu(page)).hovered).toBe(button);
  await xr(page, { at: head!, to: buttons![button], trigger: true });
  await page.waitForTimeout(150);
  await xr(page, { at: head!, to: buttons![button] });
}

async function openMenu(page: Page) {
  await xr(page, { menu: true });
  await expect.poll(async () => (await menu(page)).open).toBe(true);
  await xr(page, {});
}

test("the XR menu opens with B or Y, rests locomotion, goes back to the screen and leaves only after confirmation", async ({ page }) => {
  await page.goto("/rooms/demo-room?debug=1&avatarvrmock=1&onboard=0&name=XR%20Guest&lang=ru");
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__VRATA_DEBUG__?.roomStateConnected)), { timeout: 30_000 }).toBe(true);

  await openMenu(page);
  const before = await position(page);
  await xr(page, { moveY: -1 });
  await page.waitForTimeout(500);
  expect(await position(page)).toEqual(before);

  await press(page, "to_screen");
  await expect.poll(async () => (await menu(page)).lastCommand).toBe("end_xr_session");
  expect((await menu(page)).open).toBe(false);
  expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);

  await openMenu(page);
  await press(page, "close");
  await expect.poll(async () => (await menu(page)).open).toBe(false);

  await openMenu(page);
  await press(page, "leave");
  await expect.poll(async () => (await menu(page)).leaveArmed).toBe(true);
  expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.leave?.requested)).toBe(false);
  await press(page, "leave");
  await expect.poll(async () => (await menu(page)).lastCommand).toBe("leave_space");
  // No portal way back on a standalone platform: the left screen, in the guest's language.
  await expect(page.locator("#space-left")).toBeVisible();
  await expect(page.locator("#space-left-title")).toHaveText("Вы покинули пространство");
  await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(false);
});
