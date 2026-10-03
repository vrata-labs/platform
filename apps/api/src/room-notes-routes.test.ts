import assert from "node:assert/strict";
import test from "node:test";
import type { RoomNoteRecord, RoomNoteVersionRecord, Storage } from "./storage.js";
import { createRoomNotesHarness, makeNotesExchange } from "./testing/room-notes-harness.js";

const root = "/api/rooms/demo-room/notes";
const endpoints = [["GET", "/export"], ["GET", "/shared/versions"], ["POST", "/private/restore"],
  ["GET", "/private/export"], ["GET", "/shared"], ["PUT", "/private"], ["DELETE", "/shared"]] as const;

test("unmatched methods and paths fall through synchronously without touching storage or identity", (t) => {
  const h = createRoomNotesHarness(t);
  const storage = new Proxy({} as Storage, { get() { throw new Error("Unexpected storage access"); } });
  for (const [method, suffix] of [["POST", "/shared"], ["PATCH", "/private"], ["HEAD", "/shared"], ["OPTIONS", "/shared"],
    ["PUT", "/export"], ["DELETE", "/shared/versions"], ["GET", "/shared/restore"], ["POST", "/shared/export"],
    ["GET", "/shared/"], ["GET", "/unknown"], ["GET", "/private/export/extra"]]) {
    const e = makeNotesExchange(method!, root + suffix);
    assert.equal(h.route(e.request, e.response, method!, e.url, storage), null);
    assert.equal(e.output.writes, 0);
  }
  const e = makeNotesExchange("GET", "/api/rooms/demo-room");
  assert.equal(h.route(e.request, e.response, "GET", e.url, storage), null);
  assert.deepEqual(h.authRequests, []);
});

for (const [method, suffix] of endpoints) {
  test(`${method} ${suffix}: feature gate precedes decoding, storage and authentication`, async (t) => {
    const h = createRoomNotesHarness(t); process.env.FEATURE_NOTES = "false";
    const lookup = t.mock.method(h.storage, "getRoom", async () => { throw new Error("Unexpected lookup"); });
    const r = await h.send(method, `/api/rooms/%/notes${suffix}`);
    assert.equal(r.status, 404); assert.deepEqual(r.json(), { error: "notes_disabled" });
    assert.equal(lookup.mock.callCount(), 0); assert.equal(h.authRequests.length, 0);
  });
  test(`${method} ${suffix}: missing room precedes authentication`, async (t) => {
    const h = createRoomNotesHarness(t);
    const r = await h.send(method, `/api/rooms/missing/notes${suffix}`);
    assert.equal(r.status, 404); assert.deepEqual(r.json(), { error: "room_not_found" });
    assert.equal(h.authRequests.length, 0);
  });
}

test("save/read/delete retains exact records, creation status, history and soft deletion", async (t) => {
  const h = createRoomNotesHarness(t);
  const empty = await h.send("GET", `${root}/shared`);
  assert.deepEqual(empty.json(), { note: h.access.emptyRoomNote("demo-room", "shared") });
  for (const [content, status] of [["first", 201], ["", 200]] as const) {
    const r = await h.send("PUT", `${root}/shared`, { content });
    assert.equal(r.status, status);
    const { note } = r.json() as { note: RoomNoteRecord };
    assert.equal(note.content, content); assert.equal(note.updatedBy, "member-1");
    assert.deepEqual((await h.send("GET", `${root}/shared`)).json(), { note });
  }
  assert.equal(h.metrics.notesCreatedTotal.get("shared"), 1);
  assert.equal(h.metrics.notesSavedTotal.get("shared:saved"), 2);
  assert.equal((await h.send("DELETE", `${root}/shared`)).status, 200);
  assert.equal(h.metrics.notesVersionsCreatedTotal, 3);
  assert.deepEqual((await h.send("GET", `${root}/shared`)).json(), empty.json());
  const versions = (await h.send("GET", `${root}/shared/versions`)).json() as { items: RoomNoteVersionRecord[] };
  assert.deepEqual(versions.items.map(v => v.action), ["delete", "save", "save"]);
  assert.equal((await h.send("DELETE", `${root}/private`)).status, 404);
});

test("private writes and deletes require view permission, shared writes require edit", async (t) => {
  const h = createRoomNotesHarness(t); h.actor.permissions = ["notes.view"];
  assert.equal((await h.send("PUT", `${root}/private`, { content: "mine" })).status, 201);
  const note = (await h.send("GET", `${root}/private`)).json() as { note: RoomNoteRecord };
  assert.equal(note.note.ownerParticipantId, "member-1");
  assert.equal((await h.send("PUT", `${root}/shared`, { content: "no" })).status, 403);
  assert.equal((await h.send("DELETE", `${root}/private`)).status, 200);
});

for (const payload of [undefined, null, {}, [], { content: 1 }, { content: null }]) {
  test(`invalid save body retains status and both failure counters: ${JSON.stringify(payload)}`, async (t) => {
    const h = createRoomNotesHarness(t); const r = await h.send("PUT", `${root}/shared`, payload);
    assert.equal(r.status, 400); assert.deepEqual(r.json(), { error: "invalid_note_content" });
    assert.equal(h.metrics.notesSaveFailuresTotal.get("invalid_note_content"), 1);
    assert.equal(h.metrics.notesSavedTotal.get("shared:failed"), 1);
  });
}

test("content limit remains 20000 UTF-16 code units rather than bytes", async (t) => {
  const h = createRoomNotesHarness(t); const content = "🙂".repeat(10_000);
  assert.equal((await h.send("PUT", `${root}/private`, { content })).status, 201);
  const r = await h.send("PUT", `${root}/private`, { content: content + "a" });
  assert.equal(r.status, 413); assert.deepEqual(r.json(), { error: "note_too_large" });
  assert.equal(h.metrics.notesSaveFailuresTotal.get("note_too_large"), 1);
  assert.equal((await h.storage.getRoomNote("demo-room", "private", "member-1"))?.content, content);
});

for (const [query, expected] of [["", 20], ["?limit=", 20], ["?limit=x", 20], ["?limit=3tail", 3], ["?limit=0", 0], ["?limit=-2", -2]] as const) {
  test(`version limit preserves original parseInt behavior: ${query}`, async (t) => {
    const h = createRoomNotesHarness(t); const lookup = t.mock.method(h.storage, "listRoomNoteVersions", async () => []);
    assert.deepEqual((await h.send("GET", `${root}/private/versions${query}`)).json(), { items: [] });
    assert.deepEqual(lookup.mock.calls[0]?.arguments, ["demo-room", "private", "member-1", expected]);
  });
}

test("restoring trims version ID, preserves response and counts a new version", async (t) => {
  const h = createRoomNotesHarness(t); h.actor.permissions = ["notes.view"];
  await h.send("PUT", `${root}/private`, { content: "saved" });
  const [version] = await h.storage.listRoomNoteVersions("demo-room", "private", "member-1"); assert.ok(version);
  await h.send("DELETE", `${root}/private`);
  const r = await h.send("POST", `${root}/private/restore`, { versionId: ` ${version.versionId} ` });
  assert.equal(r.status, 200);
  const result = r.json() as { note: RoomNoteRecord; version: RoomNoteVersionRecord };
  assert.equal(result.note.content, "saved"); assert.equal(result.note.deletedAt, null);
  assert.equal(result.version.restoredFromVersionId, version.versionId);
  assert.equal(result.version.createdBy, "member-1"); assert.equal(h.metrics.notesVersionsCreatedTotal, 3);
  assert.equal(h.metrics.notesRestoresTotal.get("private:saved"), 1);
});

for (const [payload, status, error] of [[{}, 400, "invalid_note_version"], [{ versionId: " " }, 400, "invalid_note_version"], [{ versionId: 1 }, 400, "invalid_note_version"], [{ versionId: "missing" }, 404, "note_version_not_found"]] as const) {
  test(`restoring rejects ${JSON.stringify(payload)} without creating a version`, async (t) => {
    const h = createRoomNotesHarness(t); const r = await h.send("POST", `${root}/shared/restore`, payload);
    assert.equal(r.status, status); assert.deepEqual(r.json(), { error });
    assert.equal(h.metrics.notesRestoresTotal.get("shared:failed"), 1);
    assert.equal(h.metrics.notesVersionsCreatedTotal, 0);
  });
}

test("restore counts both authorization and owner denials without reading its payload", async (t) => {
  const h = createRoomNotesHarness(t); h.actor.permissions = [];
  assert.equal((await h.send("POST", `${root}/private/restore`, {})).status, 403);
  h.actor.permissions = ["notes.view"];
  assert.equal((await h.send("POST", `${root}/private/restore?participantId=other`, {})).status, 403);
  assert.equal(h.metrics.notesRestoresTotal.get("private:denied"), 2);
  assert.equal(h.metrics.notesRestoresTotal.get("private:failed"), undefined);
});
