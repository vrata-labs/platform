import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { PublicHttpsSessions, type PublicHttpsLeaseClock } from "./public-https-sessions.js";

const binding = {
  tenantId: "tenant", roomId: "room", surfaceId: "wall", objectId: "object",
  sessionId: "remote-browser:object", executorInstanceId: "remote-browser:object:instance:1", policyRevision: "rule-1"
};
const allowed = { status: "allowed", validForMs: 10_000, url: "https://controlled.test/" } as const;

function fixture(authorize: ConstructorParameters<typeof PublicHttpsSessions>[0]["authorize"], options: {
  dropConsumerStops?: boolean;
  retirePredecessor?: () => Promise<void>;
} = {}) {
  let now = 0;
  const timers = new Map<() => void, number>();
  const clock: PublicHttpsLeaseClock = {
    now: () => now,
    schedule(delay, callback) {
      timers.set(callback, now + delay);
      return () => timers.delete(callback);
    }
  };
  const advanceTo = async (target: number) => {
    for (;;) {
      const next = [...timers].sort((left, right) => left[1] - right[1])[0];
      if (!next || next[1] > target) break;
      const [callback, deadline] = next;
      timers.delete(callback);
      now = deadline;
      callback();
      await setImmediate();
    }
    now = target;
  };
  const deadlines = { gateway: 0, publisher: 0 };
  const closedAt = { gateway: -1, publisher: -1 };
  const consumer = (name: keyof typeof deadlines) => {
    let cancelExpiry: (() => void) | undefined;
    const close = () => {
      cancelExpiry?.();
      if (deadlines[name] > 0) closedAt[name] = now;
      deadlines[name] = 0;
    };
    return {
      setDeadline(deadline: number) {
        cancelExpiry?.();
        deadlines[name] = deadline;
        cancelExpiry = clock.schedule(deadline - now, close);
      },
      revoke() { if (!options.dropConsumerStops) close(); }
    };
  };
  const stops: string[] = [];
  const pageSignals: AbortSignal[] = [];
  let starts = 0;
  const sessions = new PublicHttpsSessions({
    clock, authorize, retirePredecessor: options.retirePredecessor, onStop: (_binding, reason) => stops.push(reason),
    runtime: { prepare() {
      assert.deepEqual(deadlines, { gateway: 0, publisher: 0 });
      starts++;
      return {
        gateway: consumer("gateway"), publisher: consumer("publisher"),
        async open(url, signal) {
          assert.equal(url, allowed.url);
          pageSignals.push(signal);
          await new Promise(() => {}); // Chromium never answers shutdown or finishes opening.
        }
      };
    } }
  });
  return { sessions, advanceTo, deadlines, closedAt, pageSignals, stops, starts: () => starts };
}

test("a fresh grant opens both gates once; direct stop is fenced and independent of the page", async () => {
  let checks = 0;
  const f = fixture(async () => { checks++; return allowed; });
  const start = f.sessions.start(binding, 60_000);
  assert.equal(f.sessions.start(binding, 60_000), start);
  assert.equal(await start, true);
  assert.equal(checks, 1);
  assert.equal(f.starts(), 1);
  assert.deepEqual(f.deadlines, { gateway: 10_000, publisher: 10_000 });
  assert.equal(f.sessions.stop({ ...binding, executorInstanceId: "remote-browser:object:instance:0" }), false);
  await f.advanceTo(1234);
  assert.equal(f.sessions.stop(binding), true);
  assert.equal(f.sessions.stop(binding), false);
  assert.deepEqual(f.closedAt, { gateway: 1234, publisher: 1234 });
  assert.equal(f.pageSignals[0]?.aborted, true);
});

test("a missed stop notification and a hung authority cannot extend either gate, even with a late approval", async () => {
  let answer!: (grant: typeof allowed) => void;
  const f = fixture(async (_binding, purpose) => purpose === "start" ? allowed : new Promise(resolve => { answer = resolve; }),
    { dropConsumerStops: true });
  assert.equal(await f.sessions.start(binding, 60_000), true);
  await f.advanceTo(9999);
  assert.deepEqual(f.deadlines, { gateway: 10_000, publisher: 10_000 });
  await f.advanceTo(10_000);
  assert.deepEqual(f.closedAt, { gateway: 10_000, publisher: 10_000 });
  answer(allowed);
  await setImmediate();
  assert.equal(f.sessions.size, 0);
  assert.deepEqual(f.deadlines, { gateway: 0, publisher: 0 });
  assert.deepEqual(f.stops, ["expired"]);
});

test("renewal uses request time, observed denial closes both consumers, and session TTL is an upper bound", async () => {
  let respond!: (grant: typeof allowed) => void;
  let renewals = 0;
  const f = fixture(async (_binding, purpose) => {
    if (purpose === "start") return allowed;
    if (++renewals === 1) return new Promise(resolve => { respond = resolve; });
    return { status: "denied" };
  });
  assert.equal(await f.sessions.start(binding, 12_000), true);
  await f.advanceTo(4000);
  respond(allowed);
  await setImmediate();
  assert.deepEqual(f.deadlines, { gateway: 12_000, publisher: 12_000 });
  await f.advanceTo(6500);
  assert.deepEqual(f.closedAt, { gateway: 6500, publisher: 6500 });
  assert.deepEqual(f.stops, ["revoked"]);

  const delayed = fixture(async (_binding, purpose) => purpose === "start" ? allowed : new Promise(resolve => { respond = resolve; }));
  assert.equal(await delayed.sessions.start(binding, 60_000), true);
  await delayed.advanceTo(4000);
  respond(allowed);
  await setImmediate();
  assert.deepEqual(delayed.deadlines, { gateway: 12_500, publisher: 12_500 });
});

test("a pending or expired start cannot reopen resources when its authorization finally arrives", async () => {
  for (const stop of ["notification", "deadline"]) {
    let respond!: (grant: typeof allowed) => void;
    const f = fixture(async () => new Promise(resolve => { respond = resolve; }));
    const start = f.sessions.start(binding, 60_000);
    await setImmediate();
    if (stop === "notification") assert.equal(f.sessions.stop(binding), true);
    else await f.advanceTo(10_000);
    respond(allowed);
    assert.equal(await start, false);
    assert.equal(f.starts(), 0);
    assert.equal(f.sessions.size, 0);
  }
});

test("changing from allowlist waits for the predecessor only within the authorized window", async () => {
  let finish!: () => void;
  let checked = false;
  const f = fixture(async () => { checked = true; return allowed; }, {
    retirePredecessor() {
      assert.equal(checked, true);
      return new Promise(resolve => { finish = resolve; });
    }
  });
  const start = f.sessions.start(binding, 60_000);
  await setImmediate();
  assert.equal(f.starts(), 0);
  await f.advanceTo(10_000);
  assert.equal(await start, false);
  finish();
  await setImmediate();
  assert.equal(f.starts(), 0);
});
