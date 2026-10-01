import assert from "node:assert/strict";
import test from "node:test";
import { formatNoteMarkdown } from "./notes-export.js";
import type { RoomNoteRecord, RoomNoteVersionRecord } from "./storage.js";
import { createRoomNotesHarness, deferred } from "./testing/room-notes-harness.js";

const root = "/api/rooms/demo-room/notes";

test("single-note exports retain Markdown default, JSON schema, history and attachment headers", async (t) => {
  const h = createRoomNotesHarness(t);
  const note = await h.storage.upsertRoomNote({ roomId: "demo-room", scope: "private", ownerParticipantId: "member-1", content: "# Привет\n<script>text</script>", updatedBy: "writer" });
  const versions = await h.storage.listRoomNoteVersions("demo-room", "private", "member-1");
  const md = await h.send("GET", `${root}/private/export`);
  assert.equal(md.body.toString(), formatNoteMarkdown(note, versions));
  assert.equal(md.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(md.headers["content-disposition"], 'attachment; filename="vrata-demo-room-private-notes.md"');
  assert.equal(md.headers["cache-control"], "no-store");
  const json = await h.send("GET", `${root}/private/export?format=%20JSON%20`);
  const value = json.json() as { schemaVersion: number; exportedAt: string; note: RoomNoteRecord; versions: RoomNoteVersionRecord[] };
  assert.equal(value.schemaVersion, 1); assert.ok(Number.isFinite(Date.parse(value.exportedAt)));
  assert.deepEqual(value.note, note); assert.deepEqual(value.versions, versions);
  assert.equal(json.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(h.metrics.notesExportsTotal.get("markdown:saved"), 1);
  assert.equal(h.metrics.notesExportsTotal.get("json:saved"), 1);
});

test("single exports retain deleted content while an ordinary read returns an empty note", async (t) => {
  const h = createRoomNotesHarness(t);
  await h.storage.upsertRoomNote({ roomId: "demo-room", scope: "shared", content: "old" });
  const deleted = await h.storage.deleteRoomNote("demo-room", "shared", null, "member-1");
  const exported = (await h.send("GET", `${root}/shared/export?format=json`)).json() as { note: RoomNoteRecord };
  assert.deepEqual(exported.note, deleted);
  assert.deepEqual((await h.send("GET", `${root}/shared`)).json(), { note: h.access.emptyRoomNote("demo-room", "shared") });
  assert.match((await h.send("GET", `${root}/private/export`)).body.toString(), /_Empty note\._/);
});

for (const path of [`${root}/export?format=xml`, `${root}/shared/export?format=zip`]) {
  test(`unsupported export format retains the original failure metric: ${path}`, async (t) => {
    const h = createRoomNotesHarness(t); const r = await h.send("GET", path);
    assert.equal(r.status, 400); assert.deepEqual(r.json(), { error: "unsupported_notes_export_format" });
    assert.equal(h.metrics.notesExportsTotal.get(path.endsWith("xml") ? "xml:failed" : "zip:failed"), 1);
  });
}

for (const identity of ["room-session", "admin-token"] as const) {
  test(`room archive filters private notes for ${identity}, including deleted entries`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_750_000_000_000 });
    const h = createRoomNotesHarness(t); h.actor.actorType = identity;
    await h.storage.upsertRoomNote({ roomId: "demo-room", scope: "shared", content: "shared" });
    await h.storage.upsertRoomNote({ roomId: "demo-room", scope: "private", ownerParticipantId: "member-1", content: "own" });
    await h.storage.upsertRoomNote({ roomId: "demo-room", scope: "private", ownerParticipantId: "other", content: "secret" });
    await h.storage.deleteRoomNote("demo-room", "private", "member-1", "member-1");
    const archive = (await h.send("GET", `${root}/export`)).json() as { schemaVersion: number; roomId: string; notes: Array<{ note: RoomNoteRecord; versions: RoomNoteVersionRecord[] }> };
    assert.equal(archive.schemaVersion, 1); assert.equal(archive.roomId, "demo-room");
    assert.deepEqual(archive.notes.map(i => i.note.ownerParticipantId), identity === "admin-token" ? [null, "member-1", "other"] : [null, "member-1"]);
    assert.equal(archive.notes[1]?.versions[0]?.action, "delete");
    assert.deepEqual(h.logs.map(e => e.action), ["notes.export", "notes.export"]);
    const zip = await h.send("GET", `${root}/export?format=zip`);
    assert.equal(zip.headers["content-type"], "application/zip");
    assert.equal(zip.headers["content-disposition"], 'attachment; filename="vrata-demo-room-room-notes.zip"');
    const entries = new Map<string, string>();
    for (let offset = 0; zip.body.readUInt32LE(offset) === 0x04034b50;) {
      const bytes = zip.body.readUInt32LE(offset + 18), nameBytes = zip.body.readUInt16LE(offset + 26);
      assert.equal(zip.body.readUInt16LE(offset + 8), 0);
      const start = offset + 30 + nameBytes + zip.body.readUInt16LE(offset + 28);
      entries.set(zip.body.subarray(offset + 30, offset + 30 + nameBytes).toString(), zip.body.subarray(start, start + bytes).toString());
      offset = start + bytes;
    }
    assert.deepEqual([...entries.keys()], ["room-notes.json", "room-notes.md", "board.json", "notes/shared.md", "notes/private-member-1.md", ...(identity === "admin-token" ? ["notes/private-other.md"] : [])]);
    assert.deepEqual(JSON.parse(entries.get("board.json")!), { status: "not_included", reason: "board_state_is_realtime_only", followUp: "VRATA-FEAT-023-board-history" });
    assert.match(entries.get("notes/private-member-1.md")!, /currently deleted/);
    if (identity === "room-session") assert.doesNotMatch([...entries.values()].join("\n"), /secret/);
    assert.match((await h.send("GET", `${root}/export?format=%20MARKDOWN%20`)).body.toString(), /# Vrata room notes export/);
  });
}

test("archive requests histories concurrently but preserves note ordering after reversed completion", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_750_000_000_000 });
  const h = createRoomNotesHarness(t);
  await h.storage.upsertRoomNote({ roomId: "demo-room", scope: "shared", content: "one" });
  await h.storage.upsertRoomNote({ roomId: "demo-room", scope: "private", ownerParticipantId: "member-1", content: "two" });
  const histories = [deferred<RoomNoteVersionRecord[]>(), deferred<RoomNoteVersionRecord[]>()];
  const ready = deferred<void>(); let calls = 0;
  const lookup = t.mock.method(h.storage, "listRoomNoteVersions", () => { const pending = histories[calls++]!; if (calls === 2) ready.resolve(); return pending.promise; });
  const e = h.dispatch("GET", `${root}/export`); await ready.promise;
  assert.equal(e.output.writes, 0);
  assert.deepEqual(lookup.mock.calls.map(c => c.arguments), [["demo-room", "shared", null, 100], ["demo-room", "private", "member-1", 100]]);
  histories[1]!.resolve([]); histories[0]!.resolve([]); await e.pending;
  assert.deepEqual((e.output.json() as { notes: Array<{ note: RoomNoteRecord }> }).notes.map(i => i.note.content), ["one", "two"]);
});

test("denied archives and single-note exports count denial exactly once", async (t) => {
  const h = createRoomNotesHarness(t); h.actor.permissions = [];
  for (const path of [`${root}/export`, `${root}/shared/export`]) assert.equal((await h.send("GET", path)).status, 403);
  h.actor.permissions = ["notes.view"];
  assert.equal((await h.send("GET", `${root}/private/export?participantId=other`)).status, 403);
  assert.equal(h.metrics.notesExportDeniedTotal, 3); assert.equal(h.metrics.notesPermissionDeniedTotal, 3);
  assert.equal(h.metrics.notesExportsTotal.size, 0);
});
