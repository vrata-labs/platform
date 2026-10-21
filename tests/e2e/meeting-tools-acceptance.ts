import { expect, type Page } from "@playwright/test";

export type MeetingSection = "audio" | "present" | "board" | "notes" | "people";

/** Transport failures must not copy authenticated request headers into reports. */
export async function meetingRequest<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { throw new Error("meeting_request_failed"); }
}

/** Passive timing observation; never replaces render/input/media work. */
export async function installMeetingPerformanceObservation(page: Page) {
  await page.addInitScript(() => {
    const state = { frames: [] as number[], longTasks: [] as Array<{ at: number; ms: number }>,
      statsStarted: 0, statsPending: 0, statsPeak: 0, statsMaxMs: 0, diagnosticRequests: 0, diagnosticMaxMs: 0 };
    (window as any).__meetingPerformance = state;
    const frame = (now: number) => { state.frames.push(now); if (state.frames.length > 120) state.frames.shift(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    if (window.PerformanceObserver) {
      try { new PerformanceObserver(list => {
        for (const entry of list.getEntries()) { state.longTasks.push({ at: entry.startTime, ms: entry.duration }); if (state.longTasks.length > 32) state.longTasks.shift(); }
      }).observe({ type: "longtask", buffered: true }); } catch { /* Unsupported observation is not fabricated as an app failure. */ }
      try { new PerformanceObserver(list => {
        for (const entry of list.getEntries()) try {
          if (new URL(entry.name).pathname.endsWith("/diagnostics")) { state.diagnosticRequests++; state.diagnosticMaxMs = Math.max(state.diagnosticMaxMs, entry.duration); }
        } catch { /* Ignore non-URL resource labels. */ }
      }).observe({ type: "resource", buffered: true }); } catch { /* The renderer may not expose this observation. */ }
    }
    const original = window.RTCPeerConnection?.prototype.getStats;
    if (original) RTCPeerConnection.prototype.getStats = function (...args) {
      const beganAt = performance.now(); state.statsStarted++; state.statsPending++; state.statsPeak = Math.max(state.statsPeak, state.statsPending);
      const finish = () => { state.statsPending--; state.statsMaxMs = Math.max(state.statsMaxMs, performance.now()-beganAt); };
      try { const result = original.apply(this, args); void result.then(finish, finish); return result; }
      catch (error) { finish(); throw error; }
    };
  });
}

export async function readMeetingPerformance(page: Page): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([page.evaluate(() => {
      const state = (window as any).__meetingPerformance, now = performance.now();
      if (!state) return { unavailable: true };
      const debug = (window as any).__VRATA_DEBUG__;
      return { visibility: document.visibilityState, frameAgeMs: state.frames.length ? now-state.frames.at(-1) : null,
        lastFrameGapsMs: state.frames.slice(-8).map((at: number, index: number, values: number[]) => index ? at-values[index-1] : 0).slice(1),
        recentLongTasks: state.longTasks.filter((entry: { at: number }) => now-entry.at < 60_000),
        statsStarted: state.statsStarted, statsPending: state.statsPending, statsPeak: state.statsPeak, statsMaxMs: state.statsMaxMs,
        diagnosticRequests: state.diagnosticRequests, diagnosticMaxMs: state.diagnosticMaxMs,
        scene: debug?.sceneBundleState, meshes: debug?.sceneDebug?.meshCount, materials: debug?.sceneDebug?.materialCount,
        connected: debug?.roomStateConnected, role: ["host","member","presenter","guest","admin"].includes(debug?.access?.role) ? debug.access.role : "other",
        boardDisabled: document.querySelector<HTMLButtonElement>("#start-whiteboard")?.disabled,
        selectedMain: document.querySelector<HTMLSelectElement>("#media-surface-select")?.value === "debug-main",
        stopCapabilityMissing: document.getElementById("meeting-board-status")?.textContent?.includes("newer room server"),
        dialogs: [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].map(dialog => dialog.id) };
    }).catch(() => ({ unavailable: true })), new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: true }), 5000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

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
