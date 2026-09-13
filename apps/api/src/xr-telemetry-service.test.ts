import test from "node:test";
import assert from "node:assert/strict";

import type { Storage, XrTelemetryEventRecord } from "./storage.js";
import type { XrTelemetryRecord } from "./xr-telemetry-buffer.js";
import { createXrTelemetryService } from "./xr-telemetry-service.js";

type TelemetryStorage = Pick<Storage, "addXrTelemetry" | "getXrTelemetry">;

function record(overrides: Partial<XrTelemetryRecord> = {}): XrTelemetryRecord {
  return {
    roomId: "payload-room", participantId: "payload-participant",
    updatedAt: "2026-09-01T00:00:00.000Z", currentSeatId: null, ...overrides
  };
}

function event(participantId: string, payload: XrTelemetryRecord): XrTelemetryEventRecord {
  return { participantId, payload: payload as unknown as Record<string, unknown>, createdAt: "2000-01-01T00:00:00.000Z" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(entries: XrTelemetryEventRecord[] = []) {
  const reads: string[] = [];
  const writes: Array<{ roomId: string; participantId: string; payload: Record<string, unknown> }> = [];
  const storage: TelemetryStorage = {
    async addXrTelemetry(roomId, participantId, payload) { writes.push({ roomId, participantId, payload }); },
    async getXrTelemetry(roomId) { reads.push(roomId); return entries; }
  };
  return { storage, reads, writes, ...createXrTelemetryService(Promise.resolve(storage)) };
}

test("creation is lazy and every list reloads storage", async () => {
  const service = fixture();
  await Promise.resolve();
  assert.deepEqual(service.reads, []);
  assert.deepEqual(service.writes, []);
  assert.deepEqual(await service.listXrTelemetry("empty"), []);
  assert.deepEqual(await service.listXrTelemetry("empty"), []);
  assert.deepEqual(service.reads, ["empty", "empty"]);
});

test("idle updates complete without waiting for storage and still become the latest record", async () => {
  const ready = deferred<TelemetryStorage>();
  const service = createXrTelemetryService(ready.promise);
  await service.upsertXrTelemetry("room-a", "participant-a", record());
  const backing = fixture();
  ready.resolve(backing.storage);
  assert.deepEqual(await service.listXrTelemetry("room-a"), [{ ...record(), roomId: "room-a", participantId: "participant-a", history: [] }]);
  assert.deepEqual(backing.writes, []);
});

test("significant updates await storage readiness and persistence completion", async () => {
  const ready = deferred<TelemetryStorage>();
  const persisted = deferred<void>();
  const backing = fixture();
  const original = backing.storage.addXrTelemetry;
  backing.storage.addXrTelemetry = async (...args) => { await original(...args); await persisted.promise; };
  const service = createXrTelemetryService(ready.promise);
  let completed = false;
  const pending = service.upsertXrTelemetry("room", "p", record({ kind: "snap-turn" })).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(backing.writes.length, 0);
  ready.resolve(backing.storage);
  await Promise.resolve();
  assert.equal(backing.writes.length, 1);
  assert.equal(completed, false);
  persisted.resolve();
  await pending;
  assert.equal(completed, true);
});

test("significant records are live before persistence completes", async () => {
  const service = fixture();
  const persisted = deferred<void>();
  service.storage.addXrTelemetry = () => persisted.promise;
  const pending = service.upsertXrTelemetry("room", "p", record({ kind: "seat" }));
  const [live] = await service.listXrTelemetry("room");
  assert.equal(live.kind, "seat");
  assert.equal(live.history.length, 1);
  persisted.resolve();
  await pending;
});

test("request identity overrides payload identity and the persisted payload is deeply cloned", async () => {
  const service = fixture();
  const payload = record({ kind: "input", xrRawInputs: [{ index: 0, axes: [0.2, 0.4] }], interactionRay: { active: true, origin: { x: 2 } } });
  const before = structuredClone(payload);
  await service.upsertXrTelemetry("room-a", "participant-a", payload);
  const expected = { ...before, roomId: "room-a", participantId: "participant-a" };
  assert.deepEqual(service.writes, [{ roomId: "room-a", participantId: "participant-a", payload: expected }]);
  assert.deepEqual(payload, before);
  assert.notEqual(service.writes[0].payload.xrRawInputs, payload.xrRawInputs);
  payload.xrRawInputs![0].axes![0] = 9;
  assert.deepEqual(service.writes[0].payload, expected);
  // Preserve the existing shallow live-record copy; do not silently change ownership.
  assert.equal((await service.listXrTelemetry("room-a"))[0].xrRawInputs![0].axes![0], 9);
});

test("the persistence adapter cannot mutate the live record through its cloned payload", async () => {
  const service = fixture();
  service.storage.addXrTelemetry = async (_room, _participant, payload) => {
    (payload.xrRawInputs as XrTelemetryRecord["xrRawInputs"])![0].axes![0] = 99;
  };
  await service.upsertXrTelemetry("room", "p", record({ kind: "input", xrRawInputs: [{ index: 0, axes: [1] }] }));
  assert.equal((await service.listXrTelemetry("room"))[0].xrRawInputs![0].axes![0], 1);
});

test("cloning for persistence happens after storage readiness, not before it", async () => {
  const ready = deferred<TelemetryStorage>();
  const backing = fixture();
  const service = createXrTelemetryService(ready.promise);
  const payload = record({ kind: "input", xrRawInputs: [{ index: 0, axes: [1] }] });
  const pending = service.upsertXrTelemetry("room", "p", payload);
  payload.xrRawInputs![0].axes![0] = 2;
  ready.resolve(backing.storage);
  await pending;
  assert.equal((backing.writes[0].payload.xrRawInputs as XrTelemetryRecord["xrRawInputs"])![0].axes![0], 2);
});

test("storage initialization errors propagate unchanged for writes and reads", async () => {
  const error = new Error("storage unavailable");
  const service = createXrTelemetryService(Promise.reject(error));
  await assert.rejects(service.upsertXrTelemetry("room", "p", record({ kind: "seat" })), (value) => value === error);
  await assert.rejects(service.listXrTelemetry("room"), (value) => value === error);
});

test("persistence failure propagates unchanged without reverting the live update", async () => {
  const service = fixture();
  const error = new Error("write failed");
  service.storage.addXrTelemetry = async () => { throw error; };
  await assert.rejects(service.upsertXrTelemetry("room", "p", record({ kind: "seat" })), (value) => value === error);
  const [live] = await service.listXrTelemetry("room");
  assert.equal(live.kind, "seat");
  assert.equal(live.history.length, 1);
});

test("read failures propagate instead of silently falling back to live data", async () => {
  const service = fixture();
  await service.upsertXrTelemetry("room", "p", record());
  const error = new Error("read failed");
  service.storage.getXrTelemetry = async () => { throw error; };
  await assert.rejects(service.listXrTelemetry("room"), (value) => value === error);
});

test("lists await both storage readiness and the requested persisted records", async () => {
  const ready = deferred<TelemetryStorage>();
  const loaded = deferred<XrTelemetryEventRecord[]>();
  const backing = fixture();
  backing.storage.getXrTelemetry = async (roomId) => { backing.reads.push(roomId); return loaded.promise; };
  const service = createXrTelemetryService(ready.promise);
  let completed = false;
  const listing = service.listXrTelemetry("requested-room").then((value) => { completed = true; return value; });
  await Promise.resolve();
  assert.deepEqual(backing.reads, []);
  ready.resolve(backing.storage);
  await Promise.resolve();
  assert.deepEqual(backing.reads, ["requested-room"]);
  assert.equal(completed, false);
  loaded.resolve([event("persisted-p", record({ kind: "seat" }))]);
  assert.equal((await listing)[0].participantId, "persisted-p");
});

test("live updates arriving during a persisted read are included in that list", async () => {
  const service = fixture();
  const loaded = deferred<XrTelemetryEventRecord[]>();
  service.storage.getXrTelemetry = () => loaded.promise;
  const listing = service.listXrTelemetry("room");
  await Promise.resolve();
  await service.upsertXrTelemetry("room", "arrived-during-read", record());
  loaded.resolve([]);
  assert.equal((await listing)[0].participantId, "arrived-during-read");
});

test("persisted records use requested room and event participant, not payload identity or createdAt", async () => {
  const payload = record({ kind: "seat" });
  const service = fixture([event("event-p", payload)]);
  const [actual] = await service.listXrTelemetry("requested-room");
  const expected = { ...payload, roomId: "requested-room", participantId: "event-p" };
  assert.deepEqual(actual, { ...expected, history: [expected] });
  assert.deepEqual(payload, record({ kind: "seat" }));
});

test("live and persisted participants are combined in localeCompare order without duplicates", async () => {
  const ids = ["z", "A", "a", "10", "2", "я"];
  const service = fixture(ids.slice(0, 4).map((id) => event(id, record({ kind: "stored" }))));
  for (const id of ids.slice(2)) await service.upsertXrTelemetry("room", id, record({ kind: "live" }));
  assert.deepEqual((await service.listXrTelemetry("room")).map((entry) => entry.participantId), [...ids].sort((a, b) => a.localeCompare(b)));
});

for (const [persistedAt, liveAt, expectedKind] of [
  ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", "live"],
  ["2026-09-02T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "stored"],
  ["2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "stored"]
] as const) {
  test(`latest record preserves stored/live timestamp precedence: ${persistedAt} / ${liveAt}`, async () => {
    const service = fixture([event("p", record({ kind: "stored", updatedAt: persistedAt }))]);
    await service.upsertXrTelemetry("room", "p", record({ kind: "live", updatedAt: liveAt }));
    assert.equal((await service.listXrTelemetry("room"))[0].kind, expectedKind);
  });
}

test("a persisted-only participant retains storage iteration order, not a new timestamp sort", async () => {
  const service = fixture([
    event("p", record({ kind: "newer", updatedAt: "2026-09-02T00:00:00.000Z" })),
    event("p", record({ kind: "older", updatedAt: "2026-09-01T00:00:00.000Z" }))
  ]);
  const [actual] = await service.listXrTelemetry("room");
  assert.equal(actual.kind, "older");
  assert.deepEqual(actual.history.map((entry) => entry.kind), ["newer", "older"]);
});

test("identical live and persisted events are deduplicated while distinct events at the same time survive", async () => {
  const duplicate = record({ kind: "seat" });
  const service = fixture([event("p", duplicate), event("p", record({ kind: "turn" }))]);
  await service.upsertXrTelemetry("room", "p", duplicate);
  assert.deepEqual((await service.listXrTelemetry("room"))[0].history.map((entry) => entry.kind), ["seat", "turn"]);
});

test("idle live updates replace latest without persisting or appending history", async () => {
  const service = fixture();
  await service.upsertXrTelemetry("room", "p", record({ kind: "seat" }));
  await service.upsertXrTelemetry("room", "p", record({ updatedAt: "2026-09-02T00:00:00.000Z", statusLine: "idle" }));
  const [actual] = await service.listXrTelemetry("room");
  assert.equal(actual.statusLine, "idle");
  assert.equal(actual.kind, undefined);
  assert.deepEqual(actual.history.map((entry) => entry.kind), ["seat"]);
  assert.equal(service.writes.length, 1);
});

test("live, persisted and combined histories retain the existing 80-record bound", async () => {
  for (const mode of ["live", "stored", "combined"] as const) {
    const records = Array.from({ length: 100 }, (_, index) => record({ kind: String(index), updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString() }));
    const service = fixture(mode === "live" ? [] : records.slice(0, mode === "combined" ? 50 : 100).map((value) => event("p", value)));
    if (mode !== "stored") for (const value of records.slice(mode === "combined" ? 50 : 0)) await service.upsertXrTelemetry("room", "p", value);
    const [actual] = await service.listXrTelemetry("room");
    assert.equal(actual.kind, "99", mode);
    assert.deepEqual(actual.history.map((entry) => entry.kind), Array.from({ length: 80 }, (_, index) => String(index + 20)), mode);
  }
});

test("live state is isolated between rooms and between service instances", async () => {
  const backing = fixture();
  const first = createXrTelemetryService(Promise.resolve(backing.storage));
  const second = createXrTelemetryService(Promise.resolve(backing.storage));
  await first.upsertXrTelemetry("room-a", "p", record());
  await first.upsertXrTelemetry("room-b", "other", record());
  assert.deepEqual((await first.listXrTelemetry("room-a")).map((entry) => entry.participantId), ["p"]);
  assert.deepEqual((await first.listXrTelemetry("room-b")).map((entry) => entry.participantId), ["other"]);
  assert.deepEqual(await second.listXrTelemetry("room-a"), []);
});

test("mutating returned records and histories does not corrupt stored or live state", async () => {
  for (const mode of ["live", "stored", "combined"] as const) {
    const value = record({ kind: "input", xrRawInputs: [{ index: 0, axes: [1, 2] }] });
    const service = fixture(mode === "live" ? [] : [event("p", value)]);
    if (mode !== "stored") await service.upsertXrTelemetry("room", "p", value);
    const before = await service.listXrTelemetry("room");
    const changed = await service.listXrTelemetry("room");
    changed[0].xrRawInputs![0].axes![0] = 99;
    changed[0].history[0].xrRawInputs![0].axes![0] = 88;
    changed[0].history.push(record());
    assert.deepEqual(await service.listXrTelemetry("room"), before, mode);
  }
});

test("missing timestamps are generated at operation time and existing timestamps remain untouched", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-03T04:05:06.000Z") });
  const service = fixture([event("stored", record({ updatedAt: "", kind: "input" }))]);
  await service.upsertXrTelemetry("room", "live", record({ updatedAt: "", kind: "input" }));
  context.mock.timers.setTime(new Date("2026-09-04T04:05:06.000Z").getTime());
  const actual = await service.listXrTelemetry("room");
  assert.equal(actual.find((entry) => entry.participantId === "live")!.updatedAt, "2026-09-03T04:05:06.000Z");
  assert.equal(actual.find((entry) => entry.participantId === "stored")!.updatedAt, "2026-09-04T04:05:06.000Z");
  assert.equal(service.writes[0].payload.updatedAt, "2026-09-03T04:05:06.000Z");
});
