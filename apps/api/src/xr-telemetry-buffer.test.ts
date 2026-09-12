import assert from "node:assert/strict";
import test from "node:test";

import {
  appendXrTelemetryRecord,
  cloneXrTelemetryBuffer,
  createXrTelemetryRecord,
  mergeXrTelemetryBuffers,
  type XrTelemetryParticipantBuffer,
  type XrTelemetryRecord
} from "./xr-telemetry-buffer.js";

function record(overrides: Partial<XrTelemetryRecord> = {}): XrTelemetryRecord {
  return {
    roomId: "room-1",
    participantId: "participant-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    currentSeatId: null,
    ...overrides
  };
}

function buffer(latest: XrTelemetryRecord, history: XrTelemetryRecord[] = []): XrTelemetryParticipantBuffer {
  return { latest, history };
}

test("record creation overrides identity, preserves a supplied timestamp and does not mutate the payload", () => {
  const payload = record({ kind: "snap_turn", xrAxes: { turnX: 1 } });
  const original = structuredClone(payload);
  const result = createXrTelemetryRecord("room-2", "participant-2", payload);
  assert.deepEqual(result, { ...payload, roomId: "room-2", participantId: "participant-2" });
  assert.deepEqual(payload, original);
  assert.notEqual(result, payload);
  assert.equal(result.xrAxes, payload.xrAxes);
  assert.equal(createXrTelemetryRecord("r", "p", record({ updatedAt: "not-a-date" })).updatedAt, "not-a-date");
});

test("record creation supplies the current timestamp only when it is empty", (t) => {
  const now = Date.parse("2026-02-03T04:05:06.789Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  assert.equal(createXrTelemetryRecord("r", "p", record({ updatedAt: "" })).updatedAt, new Date(now).toISOString());
  assert.equal(createXrTelemetryRecord("r", "p", record({ updatedAt: " " })).updatedAt, " ");
});

test("idle telemetry updates latest without creating history", () => {
  const telemetry = new Map<string, XrTelemetryParticipantBuffer>();
  const next = record();
  assert.equal(appendXrTelemetryRecord(telemetry, next), false);
  assert.equal(telemetry.get(next.participantId)?.latest, next);
  assert.deepEqual(telemetry.get(next.participantId)?.history, []);
});

test("history selection preserves event, ray, controller and profile conditions", async (t) => {
  const cases: Array<{ name: string; payload: Partial<XrTelemetryRecord>; expected: boolean }> = [
    { name: "event kind", payload: { kind: "snap_turn" }, expected: true },
    { name: "empty kind", payload: { kind: "" }, expected: false },
    { name: "kinds alone", payload: { kinds: ["snap_turn"] }, expected: false },
    { name: "active ray", payload: { interactionRay: { active: true } }, expected: true },
    { name: "inactive ray", payload: { interactionRay: { active: false } }, expected: false },
    { name: "first button", payload: { xrRawInputs: [{ index: 0, button0Pressed: true }] }, expected: true },
    { name: "second button on later input", payload: { xrRawInputs: [{ index: 0 }, { index: 1, button1Pressed: true }] }, expected: true },
    { name: "released buttons", payload: { xrRawInputs: [{ index: 0, button0Pressed: false, button1Pressed: false }] }, expected: false },
    { name: "raw axis above threshold", payload: { xrRawInputs: [{ index: 0, axes: [0, -0.010001] }] }, expected: true },
    { name: "raw axes at threshold", payload: { xrRawInputs: [{ index: 0, axes: [0.01, -0.01] }] }, expected: false },
    { name: "empty input", payload: { xrRawInputs: [{ index: 0 }] }, expected: false },
    { name: "dual profile", payload: { xrAvatarDebug: { profile: "dual" } }, expected: true },
    { name: "right-only profile", payload: { xrAvatarDebug: { profile: "right-only" } }, expected: true },
    { name: "left-only profile", payload: { xrAvatarDebug: { profile: "left-only" } }, expected: true },
    { name: "other profile", payload: { xrAvatarDebug: { profile: "desktop" } }, expected: false },
    { name: "turn candidates alone", payload: { xrTurnCandidates: { snapTurnFired: true } }, expected: false }
  ];
  for (const { name, payload, expected } of cases) {
    await t.test(name, () => {
      const telemetry = new Map<string, XrTelemetryParticipantBuffer>();
      const next = record(payload);
      assert.equal(appendXrTelemetryRecord(telemetry, next), expected);
      assert.equal(telemetry.get(next.participantId)?.latest, next);
      assert.deepEqual(telemetry.get(next.participantId)?.history, expected ? [next] : []);
    });
  }
});

test("each mapped axis uses a strict absolute threshold", () => {
  for (const axis of ["moveX", "moveY", "turnX", "turnY"] as const) {
    for (const value of [0, 0.009, -0.009, 0.01, -0.01, 0.010001, -0.010001, Number.NaN]) {
      const telemetry = new Map<string, XrTelemetryParticipantBuffer>();
      assert.equal(appendXrTelemetryRecord(telemetry, record({ xrAxes: { [axis]: value } })), Math.abs(value) > 0.01, `${axis}=${value}`);
    }
  }
});

test("seat transitions are recorded while an unchanged seat is not", () => {
  const telemetry = new Map<string, XrTelemetryParticipantBuffer>();
  const seated = record({ currentSeatId: "seat-1" });
  const unchanged = record({ currentSeatId: "seat-1", statusLine: "still seated" });
  const released = record({ currentSeatId: null });
  assert.equal(appendXrTelemetryRecord(telemetry, seated), true);
  assert.equal(appendXrTelemetryRecord(telemetry, unchanged), false);
  assert.equal(appendXrTelemetryRecord(telemetry, released), true);
  assert.deepEqual(telemetry.get(seated.participantId)?.history, [seated, released]);
});

test("an omitted currentSeatId retains its existing distinction from null", () => {
  const telemetry = new Map<string, XrTelemetryParticipantBuffer>();
  const omitted = record();
  delete omitted.currentSeatId;
  assert.equal(appendXrTelemetryRecord(telemetry, omitted), true);
  assert.equal(appendXrTelemetryRecord(telemetry, omitted), true);
  assert.equal(appendXrTelemetryRecord(telemetry, record()), false);
  assert.deepEqual(telemetry.get(omitted.participantId)?.history, [omitted, omitted]);
});

test("idle updates retain the history array while event updates allocate a new one", () => {
  const event = record({ kind: "event" });
  const history = [event];
  const previous = buffer(event, history);
  const telemetry = new Map([[event.participantId, previous]]);
  const idle = record();
  assert.equal(appendXrTelemetryRecord(telemetry, idle), false);
  assert.equal(telemetry.get(event.participantId)?.history, history);
  assert.notEqual(telemetry.get(event.participantId), previous);
  const next = record({ kind: "next" });
  assert.equal(appendXrTelemetryRecord(telemetry, next), true);
  assert.deepEqual(history, [event]);
  assert.notEqual(telemetry.get(event.participantId)?.history, history);
  assert.equal(telemetry.get(event.participantId)?.history[1], next);
});

test("append keeps the last 80 events in arrival order without deduplicating", () => {
  const telemetry = new Map<string, XrTelemetryParticipantBuffer>();
  const events = Array.from({ length: 82 }, (_, index) => record({ kind: `event-${index}`, updatedAt: String(100 - index) }));
  for (const event of events) assert.equal(appendXrTelemetryRecord(telemetry, event), true);
  assert.deepEqual(telemetry.get("participant-1")?.history, events.slice(-80));
  const duplicate = record({ kind: "duplicate" });
  appendXrTelemetryRecord(telemetry, duplicate);
  appendXrTelemetryRecord(telemetry, duplicate);
  assert.deepEqual(telemetry.get("participant-1")?.history.slice(-2), [duplicate, duplicate]);
});

test("append isolates participants in the supplied map", () => {
  const telemetry = new Map<string, XrTelemetryParticipantBuffer>();
  const first = record({ kind: "event" });
  const second = record({ participantId: "participant-2" });
  appendXrTelemetryRecord(telemetry, first);
  const firstBuffer = telemetry.get(first.participantId);
  appendXrTelemetryRecord(telemetry, second);
  assert.equal(telemetry.get(first.participantId), firstBuffer);
  assert.deepEqual(telemetry.get(second.participantId), buffer(second));
});

test("clone creates independent deep copies of latest and history", () => {
  const event = record({ xrRawInputs: [{ index: 0, axes: [1, 2] }] });
  const source = buffer(event, [event]);
  const result = cloneXrTelemetryBuffer(source);
  assert.deepEqual(result, source);
  assert.notEqual(result.latest, event);
  assert.notEqual(result.history, source.history);
  assert.notEqual(result.latest, result.history[0]);
  result.latest.xrRawInputs![0]!.axes![0] = 9;
  result.history[0]!.xrRawInputs![0]!.axes![1] = 8;
  assert.deepEqual(event.xrRawInputs![0]!.axes, [1, 2]);
  assert.deepEqual(result.latest.xrRawInputs![0]!.axes, [9, 2]);
  assert.deepEqual(result.history[0]!.xrRawInputs![0]!.axes, [1, 8]);
});

test("merge chooses the newest latest and prefers the left buffer on equal timestamps", () => {
  const older = record({ updatedAt: "2026-01-01T00:00:00.000Z", statusLine: "older" });
  const newer = record({ updatedAt: "2026-01-02T00:00:00.000Z", statusLine: "newer" });
  assert.deepEqual(mergeXrTelemetryBuffers(buffer(older), buffer(newer)).latest, newer);
  assert.deepEqual(mergeXrTelemetryBuffers(buffer(newer), buffer(older)).latest, newer);
  const equal = record({ updatedAt: newer.updatedAt, statusLine: "equal" });
  assert.deepEqual(mergeXrTelemetryBuffers(buffer(newer), buffer(equal)).latest, newer);
});

test("merge sorts histories stably, deduplicates full records and preserves distinct same-time events", () => {
  const early = record({ updatedAt: "2026-01-01T00:00:00.000Z", kind: "early" });
  const left = record({ updatedAt: "2026-01-02T00:00:00.000Z", kind: "left" });
  const right = record({ updatedAt: left.updatedAt, kind: "right" });
  const result = mergeXrTelemetryBuffers(buffer(left, [left, early]), buffer(right, [structuredClone(early), right]));
  assert.deepEqual(result.history, [early, left, right]);
  assert.deepEqual(result.latest, left);
});

test("merge keeps JSON-based equality, including object property order", () => {
  const first = record({ kind: "event" });
  const reordered = { kind: first.kind, ...record() };
  assert.notEqual(JSON.stringify(first), JSON.stringify(reordered));
  const result = mergeXrTelemetryBuffers(buffer(first, [first]), buffer(reordered, [reordered]));
  assert.equal(result.history.length, 2);
});

test("merge keeps the latest 80 unique history records after sorting and deduplication", () => {
  const events = Array.from({ length: 100 }, (_, index) => record({ kind: `event-${index}`, updatedAt: new Date(index * 1000).toISOString() }));
  const left = buffer(events[99]!, events.slice(0, 70).reverse());
  const right = buffer(events[98]!, events.slice(30).reverse());
  const before = structuredClone([left, right]);
  assert.deepEqual(mergeXrTelemetryBuffers(left, right).history, events.slice(-80));
  assert.deepEqual([left, right], before);
});

test("merge deep-clones both outputs and does not add latest to empty history", () => {
  const event = record({ xrAxes: { turnX: 1 } });
  const source = buffer(event, [event]);
  const result = mergeXrTelemetryBuffers(source, source);
  result.latest.xrAxes!.turnX = 2;
  result.history[0]!.xrAxes!.turnX = 3;
  assert.equal(event.xrAxes!.turnX, 1);
  assert.notEqual(result.latest, result.history[0]);
  assert.deepEqual(mergeXrTelemetryBuffers(buffer(event), buffer(event)).history, []);
});

test("merge compares timestamp strings lexically rather than parsing dates or numbers", () => {
  const left = record({ updatedAt: "9" });
  const right = record({ updatedAt: "10" });
  const result = mergeXrTelemetryBuffers(buffer(left, [left]), buffer(right, [right]));
  assert.deepEqual(result.latest, left);
  assert.deepEqual(result.history, [right, left]);
});
