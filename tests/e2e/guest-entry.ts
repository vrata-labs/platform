import { expect, type Page } from "@playwright/test";

export async function completeGuestEntry(page: Page, displayName: string) {
  // Metadata/access requests may finish after the page load event. An immediate
  // isVisible() probe can miss the not-yet-open onboarding dialog.
  await expect.poll(async () => await page.locator("#guest-onboarding").isVisible()
    || await page.evaluate(() => Boolean((window as Window & { __VRATA_DEBUG__?: { roomStateConnected?: boolean } }).__VRATA_DEBUG__?.roomStateConnected)),
  { timeout: 30000 }).toBe(true);
  if (await page.locator("#guest-onboarding").isVisible()) {
    await page.locator("#guest-name-input").fill(displayName);
    await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
  }
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __VRATA_DEBUG__?: { roomStateConnected?: boolean } }).__VRATA_DEBUG__?.roomStateConnected)),
  { timeout: 30000 }).toBe(true);
}
