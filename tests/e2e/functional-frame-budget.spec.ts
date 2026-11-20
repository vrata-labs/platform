import { expect, test } from "@playwright/test";
import { installFunctionalFrameBudget } from "./functional-frame-budget";

test("functional frame budget batches, cancels and preserves subsequent frames", async ({ page }) => {
  await installFunctionalFrameBudget(page); await page.goto("/health");
  const result = await page.evaluate(() => new Promise<{ events: string[]; together: boolean; gap: number }>(resolve => {
    const events: string[] = [];
    const cancelled = requestAnimationFrame(() => events.push("cancelled")); cancelAnimationFrame(cancelled);
    let firstAt = 0, secondAt = 0;
    requestAnimationFrame(now => {
      events.push("first"); firstAt = now;
      requestAnimationFrame(next => { events.push("next"); resolve({ events, together: firstAt === secondAt, gap: next - firstAt }); });
    });
    requestAnimationFrame(now => { events.push("second"); secondAt = now; });
  }));
  expect(result.events).toEqual(["first", "second", "next"]); expect(result.together).toBe(true); expect(result.gap).toBeGreaterThanOrEqual(90);
});

test("functional frame budget can cancel a later callback in the same batch", async ({ page }) => {
  await installFunctionalFrameBudget(page); await page.goto("/health");
  const result = await page.evaluate(() => new Promise<{ events: string[]; windowThis: boolean }>(resolve => {
    const events: string[] = []; let later = 0, windowThis = false;
    requestAnimationFrame(function (this: Window) { windowThis = this === window; events.push("first"); cancelAnimationFrame(later); });
    later = requestAnimationFrame(() => events.push("cancelled"));
    requestAnimationFrame(() => { events.push("last"); resolve({ events, windowThis }); });
  }));
  expect(result).toEqual({ events: ["first", "last"], windowThis: true });
});

test("functional frame budget restarts after cancelling all pending callbacks", async ({ page }) => {
  await installFunctionalFrameBudget(page); await page.goto("/health");
  expect(await page.evaluate(() => new Promise<string[]>(resolve => {
    const events: string[] = [];
    const first = requestAnimationFrame(() => events.push("cancelled-first"));
    const second = requestAnimationFrame(() => events.push("cancelled-second"));
    cancelAnimationFrame(first); cancelAnimationFrame(second);
    requestAnimationFrame(() => { events.push("restarted"); resolve(events); });
  }))).toEqual(["restarted"]);
});

test("functional frame budget reports an exception without losing the remaining callbacks", async ({ page }) => {
  await installFunctionalFrameBudget(page); await page.goto("/health");
  const reported = page.waitForEvent("pageerror"); void reported.catch(() => undefined);
  expect(await page.evaluate(() => new Promise<string[]>(resolve => {
    requestAnimationFrame(() => { throw new Error("owned_frame_callback_error"); });
    requestAnimationFrame(() => resolve(["remaining-callback-ran"]));
  }))).toEqual(["remaining-callback-ran"]);
  expect((await reported).message).toBe("owned_frame_callback_error");
});

test("functional frame budget honours a longer interval", async ({ page }) => {
  await installFunctionalFrameBudget(page, 600); await page.goto("/health");
  const gap = await page.evaluate(() => new Promise<number>(resolve => {
    requestAnimationFrame(first => requestAnimationFrame(second => resolve(second - first)));
  }));
  expect(gap).toBeGreaterThanOrEqual(550);
});

test("functional context budget covers new pages and reloads", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await installFunctionalFrameBudget(context);
    const page = await context.newPage();
    const frameGap = () => page.evaluate(() => new Promise<number>(resolve => {
      requestAnimationFrame(first => requestAnimationFrame(second => resolve(second - first)));
    }));
    await page.goto("/health");
    expect(await frameGap()).toBeGreaterThanOrEqual(90);
    await page.reload();
    expect(await frameGap()).toBeGreaterThanOrEqual(90);
    const second = await context.newPage();
    await second.goto("/health");
    expect(await second.evaluate(() => new Promise<number>(resolve => {
      requestAnimationFrame(first => requestAnimationFrame(next => resolve(next - first)));
    }))).toBeGreaterThanOrEqual(90);
  } finally { await context.close(); }
});
