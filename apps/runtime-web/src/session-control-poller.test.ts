import assert from "node:assert/strict";
import test from "node:test";
import { createSessionControlPoller } from "./session-control-poller.js";

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
function clock() {
  let now = 0, id = 0;
  const callbacks = new Map<number, { at: number; run: () => void }>();
  return {
    timers: {
      schedule(run: () => void, delayMs: number) { const handle = ++id; callbacks.set(handle, { at: now + delayMs, run }); return handle; },
      cancel(handle: unknown) { callbacks.delete(handle as number); }
    },
    size: () => callbacks.size,
    advance(ms: number) {
      now += ms;
      for (const [key, value] of [...callbacks]) if (value.at <= now) { callbacks.delete(key); value.run(); }
    }
  };
}

test("authority polling advances without renderer frames or boot completion", async () => {
  const time = clock(); let calls = 0;
  const poller = createSessionControlPoller({ timers: time.timers, intervalMs: 1000, refresh: async () => { calls += 1; } });
  poller.start(); poller.start(); assert.equal(time.size(), 1);
  time.advance(999); await flush(); assert.equal(calls, 0);
  time.advance(1); await flush(); assert.equal(calls, 1);
  time.advance(1000); await flush(); assert.equal(calls, 2);
  poller.stop(); assert.equal(time.size(), 0);
  time.advance(5000); await flush(); assert.equal(calls, 2);
});

test("pending reads never overlap and a stopped completion stays stopped", async () => {
  const time = clock(); let calls = 0, complete!: () => void;
  const wait = new Promise<void>(resolve => { complete = resolve; });
  const poller = createSessionControlPoller({ timers: time.timers, intervalMs: 1000, refresh: async () => { calls += 1; await wait; } });
  poller.start(); time.advance(1000); await flush(); assert.equal(calls, 1);
  time.advance(10_000); poller.start(); await flush(); assert.equal(calls, 1); assert.equal(time.size(), 0);
  poller.stop(); complete(); await flush(); assert.equal(time.size(), 0);
});

test("failed reads schedule bounded recovery and stop cancels retry", async () => {
  const time = clock(); let calls = 0;
  const poller = createSessionControlPoller({ timers: time.timers, intervalMs: 1000, refresh: async () => { calls += 1; throw new Error("fixture_read_failed"); } });
  poller.start(); time.advance(1000); await flush(); assert.equal(calls, 1); assert.equal(time.size(), 1);
  time.advance(1000); await flush(); assert.equal(calls, 2);
  poller.stop(); assert.equal(time.size(), 0);
});

test("invalid polling intervals are refused", () => {
  for (const intervalMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createSessionControlPoller({ intervalMs, refresh: async () => {} }), /invalid_session_control_poll_interval/);
  }
});

test("page restore waits for an old pending read then schedules one timer", async () => {
  const time = clock(); let calls = 0, complete!: () => void;
  const wait = new Promise<void>(resolve => { complete = resolve; });
  const poller = createSessionControlPoller({ timers: time.timers, intervalMs: 1000, refresh: async () => { calls += 1; await wait; } });
  poller.start(); time.advance(1000); await flush();
  poller.stop(); poller.start(); poller.start(); assert.equal(time.size(), 0);
  complete(); await flush(); assert.equal(time.size(), 1);
  time.advance(1000); await flush(); assert.equal(calls, 2);
  poller.stop(); poller.start(); poller.start(); assert.equal(time.size(), 1);
  poller.stop(); assert.equal(time.size(), 0);
});
