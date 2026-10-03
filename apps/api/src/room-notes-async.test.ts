import assert from "node:assert/strict";
import test from "node:test";
import type { RoomNoteRecord, RoomRecord } from "./storage.js";
import { createRoomNotesHarness, deferred } from "./testing/room-notes-harness.js";

const root = "/api/rooms/demo-room/notes";

test("identity is resolved after the room lookup, not at router construction or dispatch", async (t) => {
  const h = createRoomNotesHarness(t); const room = await h.storage.getRoom("demo-room");
  const result = deferred<RoomRecord | null>();
  t.mock.method(h.storage, "getRoom", () => result.promise);
  const e = h.dispatch("GET", `${root}/private`); assert.deepEqual(h.authRequests, []);
  h.state.actorResult = { ok: false, statusCode: 401, reason: "expired_token" };
  result.resolve(room); await e.pending;
  assert.equal(e.output.status, 401); assert.equal(h.logs[0]?.reason, "expired_token");
});

test("concurrent requests retain their own actor and owner after later awaits", async (t) => {
  const h = createRoomNotesHarness(t); const first = deferred<RoomNoteRecord | null>();
  const ready = deferred<void>();
  const lookup = t.mock.method(h.storage, "getRoomNote", async (...[_room, _scope, owner]: Parameters<typeof h.storage.getRoomNote>) => {
    if (owner === "member-1") { ready.resolve(); return first.promise; }
    return null;
  });
  const a = h.dispatch("GET", `${root}/private`); await ready.promise;
  h.state.actorResult = { ok: true, actor: { ...h.actor, actorId: "member-2", participantId: "member-2" } };
  const b = await h.send("GET", `${root}/private`);
  first.resolve(null); await a.pending;
  assert.deepEqual(lookup.mock.calls.map(c => c.arguments), [["demo-room", "private", "member-1"], ["demo-room", "private", "member-2"]]);
  assert.deepEqual(a.output.json(), { note: h.access.emptyRoomNote("demo-room", "private", "member-1") });
  assert.deepEqual(b.json(), { note: h.access.emptyRoomNote("demo-room", "private", "member-2") });
});

for (const method of ["getRoom", "getRoomNote", "upsertRoomNote"] as const) {
  test(`storage rejection in ${method} escapes unchanged to the outer request error handler`, async (t) => {
    const h = createRoomNotesHarness(t); const error = new Error(`failure:${method}`);
    t.mock.method(h.storage, method, () => { throw error; });
    const e = h.dispatch("PUT", `${root}/shared`, { content: "text" });
    assert.ok(e.pending); await assert.rejects(e.pending, thrown => thrown === error);
    assert.equal(e.output.writes, 0); assert.equal(h.metrics.notesVersionsCreatedTotal, 0);
    assert.equal(h.metrics.notesSavedTotal.size, 0);
  });
}

for (const rawBody of ["{broken", "x".repeat(65 * 1024)]) {
  test(`body parsing retains rejection rather than introducing a notes-specific error (${rawBody.length} bytes)`, async (t) => {
    const h = createRoomNotesHarness(t); const e = h.dispatch("PUT", `${root}/shared`, undefined, rawBody);
    assert.ok(e.pending);
    await assert.rejects(e.pending, rawBody.length > 65536 ? /payload_too_large/ : SyntaxError);
    assert.equal(e.output.writes, 0); assert.equal(h.metrics.notesSaveFailuresTotal.size, 0);
  });
}

test("malformed encoded room IDs reject asynchronously without auth or storage work", async (t) => {
  const h = createRoomNotesHarness(t); const lookup = t.mock.method(h.storage, "getRoom");
  const e = h.dispatch("GET", "/api/rooms/%/notes/shared");
  assert.ok(e.pending); await assert.rejects(e.pending, URIError);
  assert.equal(lookup.mock.callCount(), 0); assert.equal(h.authRequests.length, 0);
});

test("captured routers observe feature changes and do not share storage or counters", async (t) => {
  const first = createRoomNotesHarness(t), second = createRoomNotesHarness(t);
  process.env.FEATURE_NOTES = "false";
  assert.equal((await first.send("GET", `${root}/shared`)).status, 404);
  process.env.FEATURE_NOTES = "true";
  assert.equal((await first.send("PUT", `${root}/shared`, { content: "first" })).status, 201);
  assert.deepEqual((await second.send("GET", `${root}/shared`)).json(), { note: second.access.emptyRoomNote("demo-room", "shared") });
  assert.equal(first.metrics.notesVersionsCreatedTotal, 1); assert.equal(second.metrics.notesVersionsCreatedTotal, 0);
});
