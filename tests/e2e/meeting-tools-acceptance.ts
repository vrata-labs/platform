import { expect, type Page } from "@playwright/test";

export type MeetingSection = "audio" | "present" | "board" | "notes" | "people";

export async function chooseMeetingPanel(page: Page, section: MeetingSection, touch: boolean) {
  const button = page.locator(`#meeting-nav-${section}`);
  if (touch) await button.tap();
  else { await button.focus(); await page.keyboard.press("Enter"); }
  // Read the same layout/focus assertions in one renderer round trip. Separate
  // boundingBox calls each cross several protocol boundaries while the real
  // reference scene renders in software; they can consume the whole test budget.
  // Viewport, DPR, scene rendering, actions and acceptance thresholds stay intact.
  await expect.poll(() => page.evaluate(id => {
    const panel = document.getElementById(`meeting-${id}`) as HTMLDetailsElement;
    const summary = panel.querySelector("summary")!;
    const nav = document.getElementById("meeting-nav")!.getBoundingClientRect();
    const heading = summary.getBoundingClientRect();
    const target = document.getElementById(`meeting-nav-${id}`)!.getBoundingClientRect();
    return { open: panel.open, focused: document.activeElement === summary,
      headingBelowNavigation: heading.y >= nav.bottom - 1,
      targetWideEnough: target.width >= 48, targetTallEnough: target.height >= 48 };
  }, section)).toEqual({ open: true, focused: true, headingBelowNavigation: true,
    targetWideEnough: true, targetTallEnough: true });
}
