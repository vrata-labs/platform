import assert from "node:assert/strict";
import test from "node:test";
import { attachFrameTokenLease } from "./frame-socket-lease.js";

test("an open frame socket closes at token expiry and cannot process subsequent messages", () => {
  let at = 9_000;
  let timer!: () => void;
  let closeHandler!: () => void;
  let cancelled = false;
  const closes: Array<{ code: number; reason: string }> = [];
  const lease = attachFrameTokenLease({ expiresAtSeconds: 10,
    now: () => at, close: (code, reason) => { closes.push({ code, reason }); },
    onClose: callback => { closeHandler = callback; },
    schedule: (callback, delayMs) => { assert.equal(delayMs, 1000); timer = callback; return () => { cancelled = true; }; }
  });
  assert.equal(lease.closeIfExpired(), false);
  at = 10_000;
  timer();
  assert.deepEqual(closes, [{ code: 1008, reason: "frame_token_expired" }]);
  assert.equal(lease.closeIfExpired(), true);
  assert.equal(closes.length, 1);
  closeHandler();
  assert.equal(cancelled, true);
});

test("an already elapsed proof closes immediately; disconnect cancels a pending expiry timer", () => {
  let timer!: () => void;
  let closeHandler!: () => void;
  let cancelled = false;
  const closes: number[] = [];
  const lease = attachFrameTokenLease({ expiresAtSeconds: 10, now: () => 10_100,
    close: code => { closes.push(code); }, onClose: callback => { closeHandler = callback; },
    schedule: (callback, delayMs) => { assert.equal(delayMs, 0); timer = callback; return () => { cancelled = true; }; }
  });
  assert.equal(lease.closeIfExpired(), true);
  timer();
  assert.deepEqual(closes, [1008]);
  closeHandler();
  assert.equal(cancelled, true);
});

test("an early timer reschedules until expiry and a closed socket cannot rearm the lease", () => {
  let at = 9_000;
  let tick!: () => void;
  let disconnected!: () => void;
  const delays: number[] = [];
  let closed = 0;
  attachFrameTokenLease({ expiresAtSeconds: 10, now: () => at,
    close: () => { closed++; }, onClose: callback => { disconnected = callback; },
    schedule: (callback, delayMs) => { delays.push(delayMs); tick = callback; return () => undefined; } });
  at = 9_990;
  tick();
  assert.deepEqual(delays, [1000, 10]);
  assert.equal(closed, 0);
  at = 10_000;
  tick();
  assert.equal(closed, 1);
  disconnected();
  tick();
  assert.equal(closed, 1);
  assert.equal(delays.length, 2);
});

test("disconnect before expiry cancels the timer and suppresses a queued early callback", () => {
  let tick!: () => void;
  let disconnected!: () => void;
  let schedules = 0;
  let cancellations = 0;
  let closes = 0;
  const lease = attachFrameTokenLease({ expiresAtSeconds: 10, now: () => 9_000,
    close: () => { closes++; }, onClose: callback => { disconnected = callback; },
    schedule: callback => { schedules++; tick = callback; return () => { cancellations++; }; } });
  disconnected();
  tick();
  assert.equal(lease.closeIfExpired(), true);
  assert.equal(closes, 0);
  assert.equal(schedules, 1);
  assert.equal(cancellations, 1);
});
