import type { Page } from "@playwright/test";

/** Functional multi-client coverage renders real scenes, but does not measure
 * scene frame rate. Keep four software-rendered rooms from starving RTC/WS
 * tasks. Normal-DPR visual and locomotion/performance checks do not use this. */
export async function installFunctionalFrameBudget(page: Pick<Page, "addInitScript">): Promise<void> {
  await page.addInitScript(() => {
    const nativeRequest = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map<number, FrameRequestCallback>();
    let sequence = 0, nativeHandle: number | undefined, timer: number | undefined, lastFrameAt = -Infinity, dispatching = false;
    const intervalMs = 100;
    const schedule = () => {
      if (dispatching || !pending.size || nativeHandle !== undefined || timer !== undefined) return;
      const request = () => {
        timer = undefined;
        nativeHandle = nativeRequest(now => {
          nativeHandle = undefined;
          // Preserve native timestamps for the runtime, but reserve the idle
          // budget after the entire callback batch, including expensive rendering.
          if (now - lastFrameAt < intervalMs) { schedule(); return; }
          dispatching = true;
          const ids = [...pending.keys()];
          for (const id of ids) {
            const callback = pending.get(id); pending.delete(id);
            if (callback) try { callback.call(window, now); } catch (error) { setTimeout(() => { throw error; }, 0); }
          }
          lastFrameAt = performance.now(); dispatching = false;
          schedule();
        });
      };
      const delay = intervalMs - (performance.now() - lastFrameAt);
      if (delay > 0) timer = window.setTimeout(request, delay); else request();
    };
    window.requestAnimationFrame = callback => { const id = ++sequence; pending.set(id, callback); schedule(); return id; };
    window.cancelAnimationFrame = id => {
      pending.delete(id);
      if (!pending.size) {
        if (nativeHandle !== undefined) nativeCancel(nativeHandle);
        if (timer !== undefined) window.clearTimeout(timer);
        nativeHandle = undefined; timer = undefined;
      }
    };
  });
}
