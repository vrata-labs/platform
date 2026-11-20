import assert from "node:assert/strict";
import test from "node:test";
import { createMediaLifecycleDiagnostics, MEDIA_LIFECYCLE_LIMITS } from "./media-lifecycle-diagnostics.js";

test("stages distinguish pending, completion before/after a browser deadline, and failure", () => {
  let now = 10;
  const diagnostic = createMediaLifecycleDiagnostics(true, () => now);
  const room = {};
  diagnostic.created(room);
  const connect = diagnostic.start(room, "connect");
  let snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.currentGeneration, null);
  assert.deepEqual(snapshot.generations[0]!.stages.connect, { execution: 1, status: "pending", startedAtMs: 10, completedAtMs: null });
  assert.equal(snapshot.generations[0]!.stages.devices.status, "not-started");
  now = 19;
  diagnostic.finish(room, "connect", "succeeded", connect);
  const devices = diagnostic.start(room, "devices");
  const deadline = 20;
  now = 21;
  diagnostic.finish(room, "devices", "failed", devices);
  snapshot = diagnostic.snapshot()!;
  assert.ok(snapshot.generations[0]!.stages.connect.completedAtMs! < deadline);
  assert.ok(snapshot.generations[0]!.stages.devices.completedAtMs! > deadline);
  assert.equal(snapshot.generations[0]!.stages.devices.status, "failed");
  assert.equal(snapshot.clock, "performance.now");
  assert.equal(snapshot.observedAtMs, now);
});

test("each execution completes once, in source order, without inventing missing starts", () => {
  let now = 0;
  const diagnostic = createMediaLifecycleDiagnostics(true, () => ++now);
  const room = {};
  diagnostic.created(room);
  diagnostic.finish(room, "devices", "succeeded", null);
  for (const stage of ["connect", "devices", "install", "reconcile"] as const) {
    const execution = diagnostic.start(room, stage);
    if (stage === "install") diagnostic.installed(room);
    diagnostic.finish(room, stage, "succeeded", execution);
    diagnostic.finish(room, stage, "failed", execution);
  }
  const snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.currentGeneration, 1);
  assert.deepEqual(snapshot.events.map(event => `${event.stage}:${event.outcome}`), ["generation:created",
    "connect:pending", "connect:succeeded", "devices:pending", "devices:succeeded", "install:pending", "install:succeeded", "reconcile:pending", "reconcile:succeeded"]);
  assert.ok(snapshot.events.every((event, index) => index === 0 || event.atMs! >= snapshot.events[index - 1]!.atMs!));
});

test("clear, replacement and session block isolate late old-generation outcomes", () => {
  const diagnostic = createMediaLifecycleDiagnostics(true, () => 1);
  const old = {}, next = {};
  diagnostic.created(old); const oldConnect = diagnostic.start(old, "connect"); diagnostic.installed(old);
  diagnostic.created(next); diagnostic.start(next, "connect"); diagnostic.installed(next);
  diagnostic.finish(old, "connect", "succeeded", oldConnect); diagnostic.installed(old);
  diagnostic.invalidate(old, "disconnected");
  let snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.currentGeneration, 2);
  assert.equal(snapshot.generations[0]!.relation, "invalidated");
  assert.equal(snapshot.generations[0]!.invalidationReason, "replaced");
  assert.equal(snapshot.events.filter(event => event.stage === "connect" && event.generation === 1).at(-1)!.relation, "invalidated");
  diagnostic.invalidate(next, "cleared"); diagnostic.installed(next);
  assert.equal(diagnostic.snapshot()!.currentGeneration, null);
  const third = {}; diagnostic.created(third); const thirdDevices = diagnostic.start(third, "devices");
  diagnostic.invalidateAll(); diagnostic.finish(third, "devices", "succeeded", thirdDevices); diagnostic.installed(third);
  snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.latestGeneration, 3);
  assert.equal(snapshot.currentGeneration, null);
  assert.equal(snapshot.generations[2]!.invalidationReason, "session-blocked");
  assert.equal(snapshot.generations[2]!.stages.devices.status, "succeeded");
});

test("all binding/attachment verdicts are safe, stage-specific and deduplicated", () => {
  const diagnostic = createMediaLifecycleDiagnostics(true, () => 1), room = {};
  diagnostic.created(room);
  diagnostic.verdict(room, "subscription", false, "room-not-current");
  diagnostic.installed(room);
  diagnostic.verdict(room, "subscription", true, "current-room");
  diagnostic.verdict(room, "screen-share-binding", false, "binding-not-user");
  diagnostic.verdict(room, "screen-share-binding", false, "binding-media-only");
  diagnostic.verdict(room, "screen-share-binding", false, "no-physical-object");
  diagnostic.verdict(room, "screen-share-binding", true, "matched");
  diagnostic.verdict(room, "remote-browser-binding", false, "identity-kind");
  diagnostic.verdict(room, "remote-browser-binding", true, "matched");
  diagnostic.verdict(room, "screen-share-attach", false, "missing-surface");
  diagnostic.verdict(room, "screen-share-sdk-attach", false, "threw");
  diagnostic.verdict(room, "screen-share-sdk-attach", true, "returned");
  diagnostic.verdict(room, "screen-share-attach", true, "registered");
  for (let i = 0; i < 1_000; i++) diagnostic.verdict(room, "screen-share-attach", true, "registered");
  diagnostic.verdict(room, "screen-share-attach", true, "reused");
  diagnostic.verdict(room, "remote-browser-sdk-attach", true, "returned");
  diagnostic.verdict(room, "remote-browser-attach", true, "registered");
  const snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.events.length, 16);
  assert.equal(snapshot.events.filter(event => event.reason === "registered" && event.stage === "screen-share-attach").length, 1);
  assert.equal(snapshot.events[1]!.relation, "attempt");
  assert.equal(snapshot.events[2]!.relation, "current");
});

test("history, event trail and dedup storage stay bounded while retaining the actual current reference", () => {
  const diagnostic = createMediaLifecycleDiagnostics(true, () => 1), current = {}, evicted = {};
  diagnostic.created(current); diagnostic.installed(current); diagnostic.created(evicted);
  for (let i = 0; i < 100; i++) {
    const room = {};
    diagnostic.created(room); const execution = diagnostic.start(room, "connect"); diagnostic.finish(room, "connect", "failed", execution);
    diagnostic.verdict(room, "subscription", false, "room-not-current"); diagnostic.invalidate(room, "failed");
  }
  const before = diagnostic.snapshot()!;
  diagnostic.start(evicted, "devices"); diagnostic.installed(evicted);
  const snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.generations.length, MEDIA_LIFECYCLE_LIMITS.generations);
  assert.equal(snapshot.events.length, MEDIA_LIFECYCLE_LIMITS.events);
  assert.equal(snapshot.currentGeneration, 1);
  assert.equal(snapshot.latestGeneration, 102);
  assert.equal(snapshot.droppedGenerations, 94);
  assert.ok(snapshot.droppedEvents > 0);
  assert.deepEqual(snapshot.events, before.events);
  assert.ok(JSON.stringify(snapshot).length < 25_000);
});

test("latest execution summary cannot be overwritten by stale, duplicate or mismatched completions", () => {
  let now = 1;
  const diagnostic = createMediaLifecycleDiagnostics(true, () => now), room = {}, other = {};
  diagnostic.created(room); diagnostic.created(other);
  const first = diagnostic.start(room, "reconcile");
  now = 2;
  const second = diagnostic.start(room, "reconcile");
  now = 3;
  diagnostic.finish(room, "reconcile", "failed", first);
  diagnostic.finish(room, "reconcile", "succeeded", first);
  diagnostic.finish(other, "reconcile", "failed", second);
  diagnostic.finish(room, "install", "failed", second);
  diagnostic.finish(room, "reconcile", "failed", {});
  let snapshot = diagnostic.snapshot()!;
  assert.deepEqual(snapshot.generations[0]!.stages.reconcile, { execution: 2, status: "pending", startedAtMs: 2, completedAtMs: null });
  now = 4;
  diagnostic.finish(room, "reconcile", "succeeded", second);
  now = 5;
  const third = diagnostic.start(room, "reconcile");
  now = 6;
  const fourth = diagnostic.start(room, "reconcile");
  now = 7;
  diagnostic.finish(room, "reconcile", "failed", fourth);
  now = 8;
  diagnostic.finish(room, "reconcile", "succeeded", third);
  snapshot = diagnostic.snapshot()!;
  assert.deepEqual(snapshot.generations[0]!.stages.reconcile, { execution: 4, status: "failed", startedAtMs: 6, completedAtMs: 7 });
  assert.deepEqual(snapshot.events.filter(event => event.stage === "reconcile").map(event => [event.execution, event.outcome, event.atMs]),
    [[1, "pending", 1], [2, "pending", 2], [1, "failed", 3], [2, "succeeded", 4],
      [3, "pending", 5], [4, "pending", 6], [4, "failed", 7], [3, "succeeded", 8]]);
});

test("identical verdicts survive relation transitions with their actual observation times", () => {
  let now = 1;
  const diagnostic = createMediaLifecycleDiagnostics(true, () => now), room = {};
  diagnostic.created(room);
  diagnostic.verdict(room, "subscription", false, "room-not-current");
  now = 2; diagnostic.verdict(room, "subscription", false, "room-not-current");
  now = 3; diagnostic.invalidate(room, "disconnected");
  now = 4; diagnostic.verdict(room, "subscription", false, "room-not-current");
  now = 5; diagnostic.verdict(room, "subscription", false, "room-not-current");
  const snapshot = diagnostic.snapshot()!;
  assert.deepEqual(snapshot.events.filter(event => event.stage === "subscription").map(event => [event.relation, event.atMs]),
    [["attempt", 1], ["invalidated", 4]]);
  assert.equal(snapshot.generations[0]!.invalidatedAtMs, 3);
});

test("repeated executions and verdict transitions remain bounded; evicted execution handles cannot revive history", () => {
  let now = 1;
  const diagnostic = createMediaLifecycleDiagnostics(true, () => now), room = {}, evicted = {};
  diagnostic.created(evicted); const stale = diagnostic.start(evicted, "reconcile");
  diagnostic.created(room); diagnostic.installed(room);
  for (let index = 0; index < 1_000; index++) {
    now++;
    const execution = diagnostic.start(room, "reconcile");
    diagnostic.finish(room, "reconcile", index % 2 ? "failed" : "succeeded", execution);
    diagnostic.verdict(room, "subscription", index % 2 === 0, index % 2 ? "room-not-current" : "current-room");
  }
  for (let index = 0; index < 20; index++) diagnostic.created({});
  const before = diagnostic.snapshot()!;
  diagnostic.finish(evicted, "reconcile", "succeeded", stale);
  assert.deepEqual(diagnostic.snapshot(), before);
  assert.equal(before.generations.length, MEDIA_LIFECYCLE_LIMITS.generations);
  assert.equal(before.events.length, MEDIA_LIFECYCLE_LIMITS.events);
  assert.ok(before.droppedEvents > 2_900);
  assert.deepEqual(before.generations.find(item => item.generation === 2)!.stages.reconcile,
    { execution: 1_000, status: "failed", startedAtMs: 1_001, completedAtMs: 1_001 });
});

test("no resource properties or raw strings enter snapshots; callers receive deep copies", () => {
  const room = new Proxy({}, { get() { throw new Error("secret-resource-token"); }, ownKeys() { throw new Error("secret-resource-id"); } });
  const diagnostic = createMediaLifecycleDiagnostics(true, () => 1);
  diagnostic.created(room); diagnostic.created(room); diagnostic.start(room, "connect");
  // Runtime allowlists also reject untyped strings rather than persisting them.
  diagnostic.verdict(room, "screen-share-binding", false, "secret-token" as "matched");
  diagnostic.invalidate(room, "secret-token" as "cleared");
  const copy = diagnostic.snapshot()!;
  copy.generations[0]!.stages.connect.status = "failed";
  copy.generations[0]!.relation = "invalidated";
  copy.events[0]!.reason = "mutated";
  copy.events.push(copy.events[0]!);
  const snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.generations.length, 1);
  assert.equal(snapshot.generations[0]!.stages.connect.status, "pending");
  assert.equal(snapshot.generations[0]!.relation, "attempt");
  assert.equal(snapshot.events.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|token|participant|trackSid|roomId|https:|mutated/);
});

test("invalid or throwing clocks are explicit and never change the observed control flow", () => {
  for (const value of [NaN, Infinity, -1, Number.MAX_VALUE]) {
    const diagnostic = createMediaLifecycleDiagnostics(true, () => value), room = {};
    diagnostic.created(room); const execution = diagnostic.start(room, "connect"); diagnostic.finish(room, "connect", "failed", execution);
    const snapshot = diagnostic.snapshot()!;
    assert.equal(snapshot.clockValid, false);
    assert.equal(snapshot.observedAtMs, null);
    assert.equal(snapshot.generations[0]!.stages.connect.completedAtMs, null);
  }
  const diagnostic = createMediaLifecycleDiagnostics(true, () => { throw new Error("private-error"); });
  diagnostic.created({});
  assert.doesNotMatch(JSON.stringify(diagnostic.snapshot()), /private-error/);
  let now = 1;
  const repeated = createMediaLifecycleDiagnostics(true, () => now), room = {};
  repeated.created(room);
  const first = repeated.start(room, "reconcile"); repeated.finish(room, "reconcile", "succeeded", first);
  now = NaN;
  const second = repeated.start(room, "reconcile");
  let snapshot = repeated.snapshot()!;
  assert.deepEqual(snapshot.generations[0]!.stages.reconcile, { execution: 2, status: "pending", startedAtMs: null, completedAtMs: null });
  repeated.finish(room, "reconcile", "failed", second);
  snapshot = repeated.snapshot()!;
  assert.equal(snapshot.clockValid, false);
  assert.equal(snapshot.generations[0]!.stages.reconcile.status, "failed");
  assert.equal(snapshot.generations[0]!.stages.reconcile.completedAtMs, null);
});

test("debug off retains no traces and does not even call the clock", () => {
  const diagnostic = createMediaLifecycleDiagnostics(false, () => { throw new Error("must not run"); }), room = {};
  diagnostic.created(room); const execution = diagnostic.start(room, "connect"); diagnostic.finish(room, "connect", "succeeded", execution);
  assert.equal(execution, null);
  diagnostic.installed(room); diagnostic.verdict(room, "subscription", false, "room-not-current");
  diagnostic.invalidate(room, "cleared"); diagnostic.invalidateAll();
  assert.equal(diagnostic.snapshot(), null);
});
