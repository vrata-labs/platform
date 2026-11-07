import assert from "node:assert/strict";
import test from "node:test";
import { createMediaLifecycleDiagnostics, MEDIA_LIFECYCLE_LIMITS } from "./media-lifecycle-diagnostics.js";

test("stages distinguish pending, completion before/after a browser deadline, and failure", () => {
  let now = 10;
  const diagnostic = createMediaLifecycleDiagnostics(true, () => now);
  const room = {};
  diagnostic.created(room);
  diagnostic.start(room, "connect");
  let snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.currentGeneration, null);
  assert.deepEqual(snapshot.generations[0]!.stages.connect, { status: "pending", startedAtMs: 10, completedAtMs: null });
  assert.equal(snapshot.generations[0]!.stages.devices.status, "not-started");
  now = 19;
  diagnostic.finish(room, "connect", "succeeded");
  diagnostic.start(room, "devices");
  const deadline = 20;
  now = 21;
  diagnostic.finish(room, "devices", "failed");
  snapshot = diagnostic.snapshot()!;
  assert.ok(snapshot.generations[0]!.stages.connect.completedAtMs! < deadline);
  assert.ok(snapshot.generations[0]!.stages.devices.completedAtMs! > deadline);
  assert.equal(snapshot.generations[0]!.stages.devices.status, "failed");
  assert.equal(snapshot.clock, "performance.now");
  assert.equal(snapshot.observedAtMs, now);
});

test("stage outcomes are observed once, in source order, without inventing missing starts", () => {
  let now = 0;
  const diagnostic = createMediaLifecycleDiagnostics(true, () => ++now);
  const room = {};
  diagnostic.created(room);
  diagnostic.finish(room, "devices", "succeeded");
  for (const stage of ["connect", "devices", "install", "reconcile"] as const) {
    diagnostic.start(room, stage);
    diagnostic.start(room, stage);
    if (stage === "install") diagnostic.installed(room);
    diagnostic.finish(room, stage, "succeeded");
    diagnostic.finish(room, stage, "failed");
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
  diagnostic.created(old); diagnostic.start(old, "connect"); diagnostic.installed(old);
  diagnostic.created(next); diagnostic.start(next, "connect"); diagnostic.installed(next);
  diagnostic.finish(old, "connect", "succeeded"); diagnostic.installed(old);
  diagnostic.invalidate(old, "disconnected");
  let snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.currentGeneration, 2);
  assert.equal(snapshot.generations[0]!.relation, "invalidated");
  assert.equal(snapshot.generations[0]!.invalidationReason, "replaced");
  assert.equal(snapshot.events.filter(event => event.stage === "connect" && event.generation === 1).at(-1)!.relation, "invalidated");
  diagnostic.invalidate(next, "cleared"); diagnostic.installed(next);
  assert.equal(diagnostic.snapshot()!.currentGeneration, null);
  const third = {}; diagnostic.created(third); diagnostic.start(third, "devices");
  diagnostic.invalidateAll(); diagnostic.finish(third, "devices", "succeeded"); diagnostic.installed(third);
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
    diagnostic.created(room); diagnostic.start(room, "connect"); diagnostic.finish(room, "connect", "failed");
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
    diagnostic.created(room); diagnostic.start(room, "connect"); diagnostic.finish(room, "connect", "failed");
    const snapshot = diagnostic.snapshot()!;
    assert.equal(snapshot.clockValid, false);
    assert.equal(snapshot.observedAtMs, null);
    assert.equal(snapshot.generations[0]!.stages.connect.completedAtMs, null);
  }
  const diagnostic = createMediaLifecycleDiagnostics(true, () => { throw new Error("private-error"); });
  diagnostic.created({});
  assert.doesNotMatch(JSON.stringify(diagnostic.snapshot()), /private-error/);
});

test("debug off retains no traces and does not even call the clock", () => {
  const diagnostic = createMediaLifecycleDiagnostics(false, () => { throw new Error("must not run"); }), room = {};
  diagnostic.created(room); diagnostic.start(room, "connect"); diagnostic.finish(room, "connect", "succeeded");
  diagnostic.installed(room); diagnostic.verdict(room, "subscription", false, "room-not-current");
  diagnostic.invalidate(room, "cleared"); diagnostic.invalidateAll();
  assert.equal(diagnostic.snapshot(), null);
});
