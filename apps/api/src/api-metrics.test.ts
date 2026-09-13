import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createApiMetrics, incrementCounter } from "./api-metrics.js";
import type { RoomRecord, Storage } from "./storage.js";

type Metrics = ReturnType<typeof createApiMetrics>["metrics"];
const emptyStorage: Pick<Storage, "listRooms"> = { async listRooms() { return []; } };
const create = () => createApiMetrics(new Map(), () => {}, () => 0);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function room(presenterParticipantId?: string | null): RoomRecord {
  // Only the session-control field is read by this reporter.
  return { sessionControl: { presenterParticipantId } } as RoomRecord;
}
function populate(metrics: Metrics): void {
  for (const [index, [key, value]] of Object.entries(metrics).entries()) {
    if (typeof value === "number") Object.assign(metrics, { [key]: index + 1 });
    else if (value instanceof Map) {
      value.set("alpha:ok", index + 1);
      value.set("beta:denied", index + 2);
    } else {
      value.add("room:participant-a");
      value.add("room:participant-b");
    }
  }
}

test("construction initializes counters without reading presence or storage", () => {
  let calls = 0;
  const { metrics } = createApiMetrics(new Map(), () => { calls += 1; }, () => { calls += 1; return 0; });
  for (const value of Object.values(metrics)) {
    if (typeof value === "number") assert.equal(value, 0);
    else assert.equal(value.size, 0);
  }
  assert.equal(calls, 0);
});

test("factories have independent counters, maps and screen-share sets", () => {
  const left = create();
  const right = create();
  populate(left.metrics);
  assert.notStrictEqual(left.metrics, right.metrics);
  for (const [key, value] of Object.entries(right.metrics)) {
    if (typeof value === "number") assert.equal(value, 0);
    else {
      assert.equal(value.size, 0);
      assert.notStrictEqual(value, left.metrics[key as keyof Metrics]);
    }
  }
});

test("incrementCounter uses unknown for absent or whitespace-only labels", () => {
  const counter = new Map<string, number>();
  for (const label of [undefined, "", " ", "\t\n"]) incrementCounter(counter, label);
  assert.deepEqual([...counter], [["unknown", 4]]);
});

test("incrementCounter preserves nonblank labels and insertion order", () => {
  const counter = new Map<string, number>();
  incrementCounter(counter, " z ");
  incrementCounter(counter, "a", 4);
  incrementCounter(counter, " z ", 2);
  assert.deepEqual([...counter], [[" z ", 3], ["a", 4]]);
});

test("incrementCounter preserves explicit amounts and existing nonfinite values", () => {
  const counter = new Map<string, number>();
  incrementCounter(counter, "zero", 0);
  incrementCounter(counter, "negative", -2.5);
  incrementCounter(counter, "infinite", Infinity);
  incrementCounter(counter, "nan", NaN);
  incrementCounter(counter, "nan");
  assert.deepEqual([...counter], [["zero", 0], ["negative", -2.5], ["infinite", Infinity], ["nan", NaN]]);
});

test("incrementCounter propagates errors without silently choosing a label", () => {
  const counter = new Map<string, number>();
  assert.throws(() => incrementCounter(counter, 1 as unknown as string), TypeError);
  assert.equal(counter.size, 0);
});

test("empty report matches the entire pre-extraction output byte-for-byte", async () => {
  const output = await create().apiMetricsText(emptyStorage);
  // Golden digest captured from the original index.ts functions before extraction.
  assert.equal(digest(output), "b43d647abb30388f21e7a23b50747c9fd0b1ff9540fd9d1f24d7cc6c7c687a38");
  assert.ok(output.endsWith("\n") && !output.endsWith("\n\n"));
  assert.ok(output.includes("# TYPE vrata_active_rooms gauge\nvrata_active_rooms 0\n"));
  assert.ok(output.includes("# TYPE vrata_room_join_failures_total counter\n"));
  assert.ok(!output.includes("vrata_room_join_failures_total{"));
});

test("populated report preserves every metric, HELP text, TYPE, label and line order", async () => {
  const reporter = createApiMetrics(new Map([["one", {}], ["two", {}]]), () => {}, () => 7);
  populate(reporter.metrics);
  const output = await reporter.apiMetricsText({ async listRooms() { return [room("p"), room(null), room("")]; } });
  assert.equal(digest(output), "6c67f108978310514abdca62b3b5685ac623a075151e39d7e285a7ffff573db2");
  assert.ok(output.includes("vrata_rooms_total 3\n"));
  assert.ok(output.includes("vrata_active_rooms 2\n"));
  assert.ok(output.includes("vrata_active_participants 7\n"));
  assert.ok(output.includes("vrata_active_presenter_sessions 1\n"));
  assert.ok(output.includes("vrata_screen_share_active_sessions 2\n"));
});

test("reading a report does not reset or replace any counter collection", async () => {
  const reporter = create();
  populate(reporter.metrics);
  const before = structuredClone(reporter.metrics);
  const references = Object.values(reporter.metrics);
  const first = await reporter.apiMetricsText(emptyStorage);
  assert.equal(await reporter.apiMetricsText(emptyStorage), first);
  assert.deepEqual(reporter.metrics, before);
  Object.values(reporter.metrics).forEach((value, index) => assert.strictEqual(value, references[index]));
});

test("labels retain insertion order, escape backslashes and quotes, and preserve newlines", async () => {
  const reporter = create();
  reporter.metrics.roomJoinFailuresTotal.set('z\\"\n', 3);
  reporter.metrics.roomJoinFailuresTotal.set("a", 2);
  const lines = await reporter.apiMetricsText(emptyStorage);
  const first = 'vrata_room_join_failures_total{reason="z\\\\\\"\n"} 3\n';
  assert.ok(lines.includes(first));
  assert.ok(lines.indexOf(first) < lines.indexOf('vrata_room_join_failures_total{reason="a"} 2'));
});

for (const [field, name, firstLabel, secondLabel] of [
  ["hostActionsTotal", "vrata_host_actions_total", "action", "result"],
  ["presenterChangesTotal", "vrata_presenter_changes_total", "action", "result"],
  ["roomsCreatedTotal", "vrata_rooms_created_total", "source", "visibility"],
  ["documentsUploadedTotal", "vrata_documents_uploaded_total", "mime", "result"],
  ["notesSavedTotal", "vrata_notes_saved_total", "scope", "result"],
  ["notesRestoresTotal", "vrata_note_restores_total", "scope", "result"],
  ["notesExportsTotal", "vrata_note_exports_total", "format", "result"],
  ["adminActionsTotal", "vrata_admin_actions_total", "action", "result"]
] as const) {
  test(`${field} preserves missing, empty and extra compound label segments`, async () => {
    const reporter = create();
    reporter.metrics[field].set("only", 1).set(":", 2).set("one:two:ignored", 3);
    const output = await reporter.apiMetricsText(emptyStorage);
    assert.ok(output.includes(`${name}{${firstLabel}="only",${secondLabel}="unknown"} 1\n`));
    assert.ok(output.includes(`${name}{${firstLabel}="",${secondLabel}=""} 2\n`));
    assert.ok(output.includes(`${name}{${firstLabel}="one",${secondLabel}="two"} 3\n`));
  });
}

for (const field of ["documentMediaValidationFailuresTotal", "documentMediaContentTotal"] as const) {
  test(`${field} retains the original rejection for a missing second label`, async () => {
    const reporter = create();
    reporter.metrics[field].set("image", 1);
    await assert.rejects(reporter.apiMetricsText(emptyStorage), TypeError);
  });
}

test("numeric samples retain fractions, negative values, NaN and Infinity", async () => {
  const reporter = create();
  reporter.metrics.requestsTotal = -1.5;
  reporter.metrics.requestFailuresTotal = NaN;
  reporter.metrics.diagnosticsReportsCreatedTotal = Infinity;
  reporter.metrics.roomLockedTotal = -0;
  const output = await reporter.apiMetricsText(emptyStorage);
  for (const sample of ["vrata_api_requests_total -1.5", "vrata_api_request_failures_total NaN", "vrata_diagnostic_reports_created_total Infinity", "vrata_room_locked_total 0"]) {
    assert.ok(output.includes(`${sample}\n`));
  }
});

test("cleanup runs before storage; counters and presence are read after storage resolves", async () => {
  const order: string[] = [];
  const presence = new Map<string, unknown>();
  let release!: (rooms: RoomRecord[]) => void;
  const pending = new Promise<RoomRecord[]>((resolve) => { release = resolve; });
  const reporter = createApiMetrics(presence, () => { order.push("cleanup"); }, () => { order.push("count"); return 4; });
  const storage = { listRooms() { assert.strictEqual(this, storage); order.push("list"); return pending; } };
  const result = reporter.apiMetricsText(storage);
  assert.deepEqual(order, ["cleanup", "list"]);
  reporter.metrics.requestsTotal = 9;
  presence.set("late", {});
  release([room("presenter")]);
  const output = await result;
  assert.deepEqual(order, ["cleanup", "list", "count"]);
  assert.ok(output.includes("vrata_api_requests_total 9\n"));
  assert.ok(output.includes("vrata_active_rooms 1\n"));
});

test("active room size is sampled before the participant callback performs its own cleanup", async () => {
  const presence = new Map([["expiring", {}]]);
  const reporter = createApiMetrics(presence, () => {}, () => { presence.clear(); return 0; });
  const output = await reporter.apiMetricsText(emptyStorage);
  assert.ok(output.includes("vrata_active_rooms 1\n"));
  assert.ok(output.includes("vrata_active_participants 0\n"));
  assert.equal(presence.size, 0);
});

test("the participant callback observes the original position in counter evaluation", async () => {
  const reporter = createApiMetrics(new Map(), () => {}, () => {
    reporter.metrics.requestsTotal = 7;
    reporter.metrics.diagnosticsReportsCreatedTotal = 8;
    return 1;
  });
  const output = await reporter.apiMetricsText(emptyStorage);
  assert.ok(output.includes("vrata_api_requests_total 0\n"));
  assert.ok(output.includes("vrata_diagnostic_reports_created_total 8\n"));
});

test("presenter sessions use truthiness without applying room status or host-control policy", async () => {
  const records = [room(), room(null), room(""), room("p"), room(" ")];
  records.push({ ...room("p"), status: "disabled", sessionControl: { presenterParticipantId: "p", endedAt: "ended" } });
  const output = await create().apiMetricsText({ async listRooms() { return records; } });
  assert.ok(output.includes("vrata_active_presenter_sessions 3\n"));
});

for (const failure of ["cleanup", "storage-sync", "storage-async", "count"] as const) {
  test(`${failure} errors reject with the original object and preserve prior effects`, async () => {
    const error = new Error(failure);
    const order: string[] = [];
    const reporter = createApiMetrics(new Map(), () => {
      order.push("cleanup");
      if (failure === "cleanup") throw error;
    }, () => { order.push("count"); throw error; });
    const storage = { listRooms(): Promise<RoomRecord[]> {
      order.push("list");
      if (failure === "storage-sync") throw error;
      return failure === "storage-async" ? Promise.reject(error) : Promise.resolve([]);
    } };
    await assert.rejects(reporter.apiMetricsText(storage), (value) => value === error);
    assert.deepEqual(order, failure === "cleanup" ? ["cleanup"] : failure === "count" ? ["cleanup", "list", "count"] : ["cleanup", "list"]);
  });
}

test("concurrent reports use their own room results and current shared counters", async () => {
  const reporter = create();
  const releases: Array<(rooms: RoomRecord[]) => void> = [];
  const storage = { listRooms: () => new Promise<RoomRecord[]>((resolve) => { releases.push(resolve); }) };
  const first = reporter.apiMetricsText(storage);
  const second = reporter.apiMetricsText(storage);
  reporter.metrics.requestsTotal = 2;
  releases[1]([room(), room()]);
  const secondOutput = await second;
  reporter.metrics.requestsTotal = 3;
  releases[0]([room()]);
  const firstOutput = await first;
  assert.ok(secondOutput.includes("vrata_rooms_total 2\n") && secondOutput.includes("vrata_api_requests_total 2\n"));
  assert.ok(firstOutput.includes("vrata_rooms_total 1\n") && firstOutput.includes("vrata_api_requests_total 3\n"));
});
