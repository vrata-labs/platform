import { expect, test, type Page } from "@playwright/test";

async function readAccessDebug(page: Page) {
  return page.evaluate(() => (window as Window & {
    __VRATA_DEBUG__?: {
      roomStateConnected?: boolean;
      access?: {
        role?: string;
        permissions?: string[];
        canStartScreenShare?: boolean;
        canCreateWhiteboard?: boolean;
        canControlSurface?: boolean;
        lastDeniedPermission?: string | null;
        lastSurfaceCommandAccepted?: boolean | null;
      };
    };
  }).__VRATA_DEBUG__);
}

async function waitForAccess(page: Page, role: "guest" | "host") {
  await expect.poll(async () => {
    const debug = await readAccessDebug(page);
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null
    };
  }, {
    timeout: 15000,
    intervals: [500, 1000, 2000]
  }).toEqual({
    connected: true,
    role
  });
}

test("M1.1 guest has guest role and cannot use host controls", async ({ page }) => {
  await page.goto("/rooms/demo-room?debug=1");
  await waitForAccess(page, "guest");

  const debug = await readAccessDebug(page);
  expect(debug?.access?.permissions).toContain("surface.view");
  expect(debug?.access?.canStartScreenShare).toBe(false);
  expect(debug?.access?.canCreateWhiteboard).toBe(false);
  expect(debug?.access?.canControlSurface).toBe(false);
  await expect(page.locator("#start-share")).toBeHidden();

  const sent = await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { sendPrivilegedSurfaceCreate: () => boolean };
  }).__VRATA_TEST__?.sendPrivilegedSurfaceCreate() ?? false);
  expect(sent).toBe(true);

  await expect.poll(async () => {
    const nextDebug = await readAccessDebug(page);
    return nextDebug?.access?.lastDeniedPermission ?? null;
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe("surface.create-object");
});

test("M1.1 host role exposes host controls and privileged action", async ({ page }) => {
  await page.goto("/rooms/demo-room?role=host&debug=1&sharemock=1");
  await waitForAccess(page, "host");

  const debug = await readAccessDebug(page);
  expect(debug?.access?.permissions).toContain("screen-share.start");
  expect(debug?.access?.canStartScreenShare).toBe(true);
  await expect(page.locator("#start-share")).toBeVisible();
  await expect(page.locator("#start-share")).toBeEnabled();

  const sent = await page.evaluate(() => (window as Window & {
    __VRATA_TEST__?: { sendPrivilegedSurfaceCreate: () => boolean };
  }).__VRATA_TEST__?.sendPrivilegedSurfaceCreate() ?? false);
  expect(sent).toBe(true);

  await expect.poll(async () => {
    const nextDebug = await readAccessDebug(page);
    return nextDebug?.access?.lastSurfaceCommandAccepted ?? null;
  }, {
    timeout: 10000,
    intervals: [500, 1000, 2000]
  }).toBe(true);
});
