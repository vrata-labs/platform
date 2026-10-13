export interface SessionControlPollerTimers {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/** The control plane does not depend on rendered frames or optional boot work. */
export function createSessionControlPoller(input: {
  refresh: () => Promise<void>;
  intervalMs: number;
  timers?: SessionControlPollerTimers;
}) {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1) throw new RangeError("invalid_session_control_poll_interval");
  const timers = input.timers ?? {
    schedule: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
  let active = false, pending = false, handle: unknown;
  const schedule = () => {
    if (!active || pending || handle !== undefined) return;
    handle = timers.schedule(() => {
      handle = undefined;
      if (!active || pending) return;
      pending = true;
      void Promise.resolve().then(input.refresh).catch(() => undefined).finally(() => {
        pending = false;
        schedule();
      });
    }, input.intervalMs);
  };
  return {
    start() { active = true; schedule(); },
    stop() {
      active = false;
      if (handle !== undefined) timers.cancel(handle);
      handle = undefined;
    }
  };
}
