import test from "node:test";
import assert from "node:assert/strict";

import type { Storage } from "./storage.js";
import type { XrTelemetryRecord } from "./xr-telemetry-buffer.js";
import {
  createXrTelemetryScheduler, createXrTelemetryService, XrTelemetryQueueFull, type XrTelemetryScheduler
} from "./xr-telemetry-service.js";

type Commit = (record: XrTelemetryRecord, persist: boolean) => Promise<void>;
interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }

function record(overrides: Partial<XrTelemetryRecord> = {}): XrTelemetryRecord {
  return {
    roomId: "payload-room", participantId: "payload-participant",
    updatedAt: "2026-09-01T00:00:00.000Z", currentSeatId: null, ...overrides
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function flush(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

function service(scheduler?: XrTelemetryScheduler) {
  const storage: Pick<Storage, "addXrTelemetry" | "getXrTelemetry"> = {
    async addXrTelemetry() { throw new Error("fenced telemetry must not use global storage"); },
    async getXrTelemetry() { return []; }
  };
  return createXrTelemetryService(Promise.resolve(storage), scheduler);
}

function gate() {
  const calls: Array<{ record: XrTelemetryRecord; persist: boolean; done: Deferred<void> }> = [];
  const commit: Commit = (committed, persist) => {
    const done = deferred<void>();
    calls.push({ record: committed, persist, done });
    return done.promise;
  };
  async function drain() {
    await flush();
    for (let index = 0; index < calls.length; index += 1) { calls[index].done.resolve(); await flush(); }
  }
  return { calls, commit, drain };
}

test("fenced significant and idle updates stay invisible until their commit settles", async () => {
  const telemetry = service();
  const fence = gate();
  const significant = telemetry.upsertXrTelemetryWithFence("room", "p", record({ kind: "seat" }), fence.commit);
  await flush();
  assert.deepEqual(fence.calls.map((call) => call.persist), [true]);
  assert.deepEqual(fence.calls[0].record, { ...record({ kind: "seat" }), roomId: "room", participantId: "p" });
  assert.deepEqual(await telemetry.listXrTelemetry("room"), []);
  fence.calls[0].done.resolve();
  await significant;
  const committed = await telemetry.listXrTelemetry("room");
  assert.deepEqual(committed.map((entry) => [entry.kind, entry.history.length]), [["seat", 1]]);
  const idle = telemetry.upsertXrTelemetryWithFence("room", "p",
    record({ updatedAt: "2026-09-02T00:00:00.000Z", statusLine: "idle" }), fence.commit);
  await flush();
  assert.deepEqual(fence.calls.map((call) => call.persist), [true, false]);
  assert.deepEqual(await telemetry.listXrTelemetry("room"), committed);
  fence.calls[1].done.resolve();
  await idle;
  const [latest] = await telemetry.listXrTelemetry("room");
  assert.equal(latest.statusLine, "idle");
  assert.equal(latest.kind, undefined);
  assert.deepEqual(latest.history.map((entry) => entry.kind), ["seat"]);
});

test("a rejected commit leaves live state untouched and the same pair continues", async () => {
  const telemetry = service();
  const fence = gate();
  const first = telemetry.upsertXrTelemetryWithFence("room", "p", record({ kind: "seat" }), fence.commit);
  await flush();
  fence.calls[0].done.resolve();
  await first;
  const before = await telemetry.listXrTelemetry("room");
  const error = new Error("fence denied");
  const denied = telemetry.upsertXrTelemetryWithFence("room", "p", record({ kind: "turn", updatedAt: "2026-09-02T00:00:00.000Z" }), fence.commit);
  const next = telemetry.upsertXrTelemetryWithFence("room", "p", record({ kind: "snap", updatedAt: "2026-09-03T00:00:00.000Z" }), fence.commit);
  await flush();
  assert.equal(fence.calls.length, 2);
  fence.calls[1].done.reject(error);
  await assert.rejects(denied, (value) => value === error);
  assert.deepEqual(await telemetry.listXrTelemetry("room"), before);
  await flush();
  assert.deepEqual(fence.calls.map((call) => [call.record.kind, call.persist]), [["seat", true], ["turn", true], ["snap", true]]);
  fence.calls[2].done.resolve();
  await next;
  const [latest] = await telemetry.listXrTelemetry("room");
  assert.equal(latest.kind, "snap");
  assert.deepEqual(latest.history.map((entry) => entry.kind), ["seat", "snap"]);
});

test("queued updates for one pair commit FIFO and classify against the committed predecessor", async () => {
  const telemetry = service();
  const fence = gate();
  const pending = [null, "seat-a", null].map((currentSeatId, index) => telemetry.upsertXrTelemetryWithFence("room", "p",
    record({ currentSeatId, statusLine: `step-${index}`, updatedAt: `2026-09-0${index + 1}T00:00:00.000Z` }), fence.commit));
  await flush();
  assert.equal(fence.calls.length, 1);
  assert.deepEqual(await telemetry.listXrTelemetry("room"), []);
  await fence.drain();
  await Promise.all(pending);
  assert.deepEqual(fence.calls.map((call) => [call.record.statusLine, call.persist]),
    [["step-0", false], ["step-1", true], ["step-2", true]]);
  const [latest] = await telemetry.listXrTelemetry("room");
  assert.deepEqual(latest, { ...fence.calls[2].record, history: fence.calls.filter((call) => call.persist).map((call) => call.record) });
  assert.deepEqual(latest.history.map((entry) => entry.currentSeatId), ["seat-a", null]);
});

test("admitted payloads and callback-mutated commit records cannot change the live map", async () => {
  const telemetry = service();
  const fence = gate();
  const blocker = telemetry.upsertXrTelemetryWithFence("room", "p", record({ kind: "seat" }), fence.commit);
  const original = () => record({ kind: "input", updatedAt: "2026-09-02T00:00:00.000Z", xrRawInputs: [{ index: 0, axes: [1] }] });
  const payload = original();
  const queued = telemetry.upsertXrTelemetryWithFence("room", "p", payload, async (committed, persist) => {
    assert.equal(persist, true);
    assert.deepEqual(committed, { ...original(), roomId: "room", participantId: "p" });
    committed.xrRawInputs![0].axes![0] = 99;
    committed.kind = "mutated";
  });
  payload.xrRawInputs![0].axes![0] = 2;
  payload.kind = "changed";
  await fence.drain();
  await Promise.all([blocker, queued]);
  payload.xrRawInputs![0].axes![0] = 3;
  const [latest] = await telemetry.listXrTelemetry("room");
  const newest = latest.history[latest.history.length - 1];
  assert.deepEqual([latest.roomId, latest.kind, latest.xrRawInputs![0].axes![0]], ["room", "input", 1]);
  assert.deepEqual([newest.kind, newest.xrRawInputs![0].axes![0]], ["input", 1]);
});

test("colon-ambiguous room/participant pairs never share a queue or its capacity", async () => {
  const telemetry = service();
  const left = gate();
  const right = gate();
  const blocked = Array.from({ length: 32 }, (_, index) =>
    telemetry.upsertXrTelemetryWithFence("a:b", "c", record({ statusLine: `left-${index}` }), left.commit));
  await assert.rejects(telemetry.upsertXrTelemetryWithFence("a:b", "c", record(), left.commit), XrTelemetryQueueFull);
  const crossing = telemetry.upsertXrTelemetryWithFence("a", "b:c", record({ kind: "seat" }), right.commit);
  await flush();
  assert.deepEqual([left.calls.length, right.calls.length], [1, 1]);
  right.calls[0].done.resolve();
  await crossing;
  assert.deepEqual((await telemetry.listXrTelemetry("a")).map((entry) => entry.participantId), ["b:c"]);
  assert.deepEqual(await telemetry.listXrTelemetry("a:b"), []);
  await left.drain();
  await Promise.all(blocked);
  assert.deepEqual((await telemetry.listXrTelemetry("a:b")).map((entry) => [entry.participantId, entry.statusLine]), [["c", "left-31"]]);
  assert.deepEqual((await telemetry.listXrTelemetry("a")).map((entry) => entry.kind), ["seat"]);
});

test("pair capacity is exactly 32 and is released after failure and completion", async () => {
  const telemetry = service();
  const fence = gate();
  const admit = (label: string) => telemetry.upsertXrTelemetryWithFence("room", "p", record({ statusLine: label }), fence.commit);
  const pending = Array.from({ length: 32 }, (_, index) => admit(`q-${index}`));
  await assert.rejects(admit("overflow"), (error) => error instanceof XrTelemetryQueueFull && error.code === "XR_TELEMETRY_QUEUE_FULL");
  await flush();
  const failure = new Error("commit failed");
  fence.calls[0].done.reject(failure);
  await assert.rejects(pending[0], (value) => value === failure);
  const afterFailure = admit("after-failure");
  await assert.rejects(admit("overflow-again"), XrTelemetryQueueFull);
  await flush();
  fence.calls[1].done.resolve();
  await pending[1];
  const afterCompletion = admit("after-completion");
  await assert.rejects(admit("overflow-third"), XrTelemetryQueueFull);
  await fence.drain();
  await Promise.all([...pending.slice(1), afterFailure, afterCompletion]);
  assert.equal(fence.calls.length, 34);
  assert.equal((await telemetry.listXrTelemetry("room"))[0].statusLine, "after-completion");
  const fresh = Array.from({ length: 32 }, (_, index) => admit(`fresh-${index}`));
  await assert.rejects(admit("fresh-overflow"), XrTelemetryQueueFull);
  await fence.drain();
  await Promise.all(fresh);
});

test("room capacity is exactly 256 across pairs, per room, and released after completion", async () => {
  const telemetry = service();
  const fence = gate();
  const admit = (roomId: string, participantId: string) =>
    telemetry.upsertXrTelemetryWithFence(roomId, participantId, record({ kind: participantId }), fence.commit);
  const pending = Array.from({ length: 256 }, (_, index) => admit("room", `p-${index % 8}`));
  await assert.rejects(admit("room", "fresh"), XrTelemetryQueueFull);
  const elsewhere = admit("other-room", "fresh");
  await flush();
  assert.equal(fence.calls.filter(call => call.record.roomId === "room").length, 1);
  fence.calls.find((call) => call.record.roomId === "other-room")!.done.resolve();
  await elsewhere;
  fence.calls.find((call) => call.record.participantId === "p-0")!.done.resolve();
  await pending[0];
  const released = admit("room", "fresh");
  await assert.rejects(admit("room", "fresh-2"), XrTelemetryQueueFull);
  await fence.drain();
  await Promise.all([...pending, released]);
  assert.deepEqual((await telemetry.listXrTelemetry("room")).map((entry) => entry.participantId).sort(),
    [...Array.from({ length: 8 }, (_, index) => `p-${index}`), "fresh"].sort());
  const commitNow: Commit = async () => {};
  await Promise.all(Array.from({ length: 256 }, (_, index) =>
    telemetry.upsertXrTelemetryWithFence("room", `n-${index}`, record(), commitNow)));
});

test("a guard that expires while queued denies without touching the map", async () => {
  const telemetry = service();
  const fence = gate();
  const clock = { now: 1_000 };
  class GuardExpired extends Error {}
  const guarded = (expiresAt: number): Commit => async (committed, persist) => {
    if (clock.now >= expiresAt) throw new GuardExpired();
    await fence.commit(committed, persist);
  };
  const first = telemetry.upsertXrTelemetryWithFence("room", "p", record({ kind: "seat" }), guarded(clock.now + 50));
  const queued = telemetry.upsertXrTelemetryWithFence("room", "p",
    record({ kind: "turn", updatedAt: "2026-09-02T00:00:00.000Z" }), guarded(clock.now + 50));
  const denied = assert.rejects(queued, GuardExpired);
  await flush();
  clock.now += 100;
  fence.calls[0].done.resolve();
  await first;
  await denied;
  assert.equal(fence.calls.length, 1);
  const [afterDenial] = await telemetry.listXrTelemetry("room");
  assert.deepEqual([afterDenial.kind, afterDenial.history.map((entry) => entry.kind)], ["seat", ["seat"]]);
  const renewed = telemetry.upsertXrTelemetryWithFence("room", "p",
    record({ kind: "renewed", updatedAt: "2026-09-03T00:00:00.000Z" }), guarded(clock.now + 50));
  await flush();
  fence.calls[1].done.resolve();
  await renewed;
  assert.deepEqual((await telemetry.listXrTelemetry("room"))[0].history.map((entry) => entry.kind), ["seat", "renewed"]);
});

test("one room commits one pair head at a time and rotates queued pairs", async () => {
  const telemetry = service(); const fence = gate();
  let active = 0, peak = 0;
  const commit: Commit = async (committed, persist) => {
    active += 1; peak = Math.max(peak, active);
    try { await fence.commit(committed, persist); } finally { active -= 1; }
  };
  const pending = ["a", "a", "b", "c"].map((participantId, index) =>
    telemetry.upsertXrTelemetryWithFence("room", participantId, record({ statusLine: `${participantId}-${index}` }), commit));
  await flush(); assert.equal(fence.calls.length, 1);
  await fence.drain(); await Promise.all(pending);
  assert.equal(peak, 1);
  assert.deepEqual(fence.calls.map(call => call.record.statusLine), ["a-0", "b-2", "c-3", "a-1"]);
});

test("commits across rooms share two service-wide slots handed off in order", async () => {
  const telemetry = service(); const fence = gate();
  const pending = ["r1", "r2", "r3"].map(roomId => telemetry.upsertXrTelemetryWithFence(roomId, "p", record(), fence.commit));
  await flush();
  assert.deepEqual(fence.calls.map(call => call.record.roomId), ["r1", "r2"]);
  assert.deepEqual(await telemetry.listXrTelemetry("r3"), []);
  fence.calls[0].done.resolve(); await pending[0]; await flush();
  assert.deepEqual(fence.calls.map(call => call.record.roomId), ["r1", "r2", "r3"]);
  await fence.drain(); await Promise.all(pending);
});

test("a rejected commit or a queued expired proof releases its room turn and service slot", async () => {
  const telemetry = service(); const fence = gate(); const clock = { now: 0 };
  class GuardExpired extends Error {}
  const guarded: Commit = async (committed, persist) => {
    if (clock.now >= 50) throw new GuardExpired();
    await fence.commit(committed, persist);
  };
  const upsert = (roomId: string, participantId: string, kind: string, commit: Commit = fence.commit) =>
    telemetry.upsertXrTelemetryWithFence(roomId, participantId, record({ kind }), commit);
  const failing = upsert("r1", "a", "fail"), other = upsert("r2", "a", "other");
  const expired = upsert("r1", "b", "expired", guarded), waiting = upsert("r3", "a", "waiting");
  const denied = assert.rejects(expired, GuardExpired);
  await flush(); assert.deepEqual(fence.calls.map(call => call.record.kind), ["fail", "other"]);
  clock.now = 100;
  const failure = new Error("fence denied"); fence.calls[0].done.reject(failure);
  await assert.rejects(failing, value => value === failure); await flush();
  assert.deepEqual(fence.calls.map(call => call.record.kind), ["fail", "other", "waiting"]);
  fence.calls[1].done.resolve(); await other; await denied;
  assert.equal(fence.calls.length, 3); assert.deepEqual(await telemetry.listXrTelemetry("r1"), []);
  const after = upsert("r1", "a", "after"); await flush();
  assert.deepEqual(fence.calls.map(call => call.record.kind), ["fail", "other", "waiting", "after"]);
  await fence.drain(); await Promise.all([waiting, after]);
  assert.deepEqual((await telemetry.listXrTelemetry("r1")).map(entry => [entry.participantId, entry.kind]), [["a", "after"]]);
});

test("service capacity is exactly 512 across rooms and released after failure", async () => {
  const telemetry = service(); const fence = gate();
  const admit = (roomId: string, statusLine: string) =>
    telemetry.upsertXrTelemetryWithFence(roomId, "p", record({ statusLine }), fence.commit);
  const pending = Array.from({ length: 512 }, (_, index) => admit(`room-${index % 32}`, `q-${index}`));
  await assert.rejects(admit("fresh-room", "overflow"), XrTelemetryQueueFull);
  await flush(); assert.equal(fence.calls.length, 2);
  const failure = new Error("commit failed"); fence.calls[0].done.reject(failure);
  await assert.rejects(pending[0], value => value === failure);
  const released = admit("fresh-room", "released");
  await assert.rejects(admit("fresh-room", "overflow-again"), XrTelemetryQueueFull);
  await fence.drain(); await Promise.all([...pending.slice(1), released]);
  assert.equal(fence.calls.length, 513);
  assert.equal((await telemetry.listXrTelemetry("fresh-room"))[0].statusLine, "released");
});

test("services sharing a scheduler share pair, room, service, slot and room-turn limits but not live state", async () => {
  const scheduler = createXrTelemetryScheduler();
  const persisted = service(scheduler), virtual = service(scheduler), fence = gate();
  const admit = (telemetry: typeof persisted, roomId: string, participantId: string, statusLine: string) =>
    telemetry.upsertXrTelemetryWithFence(roomId, participantId, record({ statusLine }), fence.commit);
  const full = async (roomId: string, participantId: string) => {
    for (const telemetry of [persisted, virtual]) {
      await assert.rejects(admit(telemetry, roomId, participantId, "overflow"), XrTelemetryQueueFull);
    }
  };
  const pending = Array.from({ length: 32 }, (_, index) =>
    admit(index < 16 ? persisted : virtual, "room", "p", `${index < 16 ? "persisted" : "virtual"}-${index % 16}`));
  await full("room", "p");
  for (let index = 32; index < 256; index += 1) pending.push(admit(index % 2 ? virtual : persisted, "room", `p-${index % 8}`, `fill-${index}`));
  await full("room", "fresh");
  for (let index = 256; index < 512; index += 1) pending.push(admit(index % 2 ? virtual : persisted, `room-${index % 16}`, "p", `spill-${index}`));
  await full("fresh-room", "p");
  await flush();
  assert.deepEqual(fence.calls.map(call => [call.record.roomId, call.record.statusLine]),
    [["room", "persisted-0"], ["room-0", "spill-256"]]);
  await fence.drain(); await Promise.all(pending);
  assert.equal(fence.calls.length, 512);
  for (const [telemetry, name, offset] of [[persisted, "persisted", 0], [virtual, "virtual", 1]] as const) {
    const entries = await telemetry.listXrTelemetry("room");
    assert.deepEqual(entries.map(entry => entry.participantId), ["p", ...[0, 2, 4, 6].map(index => `p-${index + offset}`)]);
    assert.equal(entries[0].statusLine, `${name}-15`);
  }
  assert.deepEqual([scheduler.pending, scheduler.queuesByRoom.size], [0, 0]);
});

test("a rejected callback in one namespace releases shared capacity without poisoning the other", async () => {
  const scheduler = createXrTelemetryScheduler();
  const persisted = service(scheduler), virtual = service(scheduler), fence = gate();
  const upsert = (telemetry: typeof persisted, roomId: string, statusLine: string) =>
    telemetry.upsertXrTelemetryWithFence(roomId, "p", record({ statusLine }), fence.commit);
  const failing = upsert(persisted, "room", "fail");
  const queued = Array.from({ length: 31 }, (_, index) => upsert(virtual, "room", `virtual-${index}`));
  const holder = upsert(virtual, "r2", "holder"), waiting = upsert(persisted, "r3", "waiting");
  await assert.rejects(upsert(virtual, "room", "overflow"), XrTelemetryQueueFull);
  await flush();
  assert.deepEqual(fence.calls.map(call => call.record.statusLine), ["fail", "holder"]);
  const failure = new Error("fence denied"); fence.calls[0].done.reject(failure);
  await assert.rejects(failing, value => value === failure); await flush();
  assert.deepEqual(fence.calls.map(call => call.record.statusLine), ["fail", "holder", "waiting"]);
  const released = upsert(virtual, "room", "released");
  await assert.rejects(upsert(persisted, "room", "overflow-again"), XrTelemetryQueueFull);
  await fence.drain(); await Promise.all([holder, waiting, ...queued, released]);
  assert.deepEqual(await persisted.listXrTelemetry("room"), []);
  assert.equal((await virtual.listXrTelemetry("room"))[0].statusLine, "released");
  assert.deepEqual([(await persisted.listXrTelemetry("r3")).length, (await virtual.listXrTelemetry("r3")).length], [1, 0]);
  assert.deepEqual([scheduler.pending, scheduler.queuesByRoom.size], [0, 0]);
});

test("a late apply lands only in its own namespace and storage keys stay the bare room id", async () => {
  const scheduler = createXrTelemetryScheduler(); const fence = gate(); const keys: string[] = [];
  const storage: Pick<Storage, "addXrTelemetry" | "getXrTelemetry"> = {
    async addXrTelemetry(roomId) { keys.push(`add:${roomId}`); },
    async getXrTelemetry(roomId) { keys.push(`get:${roomId}`); return []; }
  };
  const persisted = createXrTelemetryService(Promise.resolve(storage), scheduler);
  const virtual = createXrTelemetryService(Promise.resolve(storage), scheduler);
  const seat = (statusLine: string) => record({ currentSeatId: "seat-a", statusLine });
  const live = async (telemetry: typeof persisted) =>
    (await telemetry.listXrTelemetry("room")).map(entry => [entry.participantId, entry.statusLine ?? entry.kind]);
  const late = virtual.upsertXrTelemetryWithFence("room", "p", seat("virtual"), fence.commit);
  const queued = persisted.upsertXrTelemetryWithFence("room", "p", seat("persisted"), fence.commit);
  await persisted.upsertXrTelemetry("room", "q", record({ kind: "direct" }));
  await flush();
  assert.equal(fence.calls.length, 1);
  assert.deepEqual([await live(persisted), await live(virtual)], [[["q", "direct"]], []]);
  fence.calls[0].done.resolve(); await late; await flush();
  assert.deepEqual([await live(persisted), await live(virtual)], [[["q", "direct"]], [["p", "virtual"]]]);
  fence.calls[1].done.resolve(); await queued;
  assert.deepEqual([await live(persisted), await live(virtual)], [[["p", "persisted"], ["q", "direct"]], [["p", "virtual"]]]);
  // Each namespace classifies against its own predecessor, so both seat changes persist.
  assert.deepEqual(fence.calls.map(call => [call.record.roomId, call.persist]), [["room", true], ["room", true]]);
  assert.deepEqual(new Set(keys), new Set(["add:room", "get:room"]));
});
