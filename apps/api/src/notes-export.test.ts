import test from "node:test";
import assert from "node:assert/strict";

import { noteExportFilename, noteExportJson, formatNoteMarkdown, formatRoomNotesMarkdown } from "./notes-export.js";
import type { RoomNoteRecord, RoomNoteVersionRecord } from "./storage.js";

const exportedAt = "2026-01-02T03:04:05.000Z";
const now = Date.parse(exportedAt);

function note(overrides: Partial<RoomNoteRecord> = {}): RoomNoteRecord {
  return { noteId: "note-1", roomId: "room-1", scope: "shared", content: "Hello", updatedAt: "2025-12-01T10:00:00Z", ...overrides };
}

function version(overrides: Partial<RoomNoteVersionRecord> = {}): RoomNoteVersionRecord {
  return { versionId: "v1", noteId: "note-1", roomId: "room-1", scope: "shared", content: "Hello", action: "save", createdAt: "2025-12-01T10:00:00Z", createdBy: "author-1", ...overrides };
}

test("export filenames retain supported characters and the existing suffix", () => {
  assert.equal(noteExportFilename("Room_1.v2-A", "shared", "md"), "vrata-Room_1.v2-A-shared-notes.md");
  assert.equal(noteExportFilename("room-1", "room", "zip"), "vrata-room-1-room-notes.zip");
});

test("filename replacement applies to all arguments and collapses invalid runs", () => {
  assert.equal(noteExportFilename("a  b/c", "private user", "m?d"), "vrata-a-b-c-private-user-notes.m-d");
  assert.equal(noteExportFilename("a\r\n\"/b", "shared", "json"), "vrata-a-b-shared-notes.json");
  assert.equal(noteExportFilename("a🌍жb", "shared", "md"), "vrata-a-b-shared-notes.md");
});

test("filename formatting does not validate, trim or truncate its arguments", () => {
  assert.equal(noteExportFilename("", "", ""), "vrata---notes.");
  assert.equal(noteExportFilename("..", " private ", "md"), "vrata-..--private--notes.md");
  const roomId = "x".repeat(10000);
  assert.equal(noteExportFilename(roomId, "shared", "md"), `vrata-${roomId}-shared-notes.md`);
});

test("JSON export preserves schema, key order and references to note and versions", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const current = note();
  const versions = [version()];
  const result = noteExportJson(current, versions);
  assert.deepEqual(result, { schemaVersion: 1, exportedAt, note: current, versions });
  assert.deepEqual(Object.keys(result), ["schemaVersion", "exportedAt", "note", "versions"]);
  assert.equal(result.note, current);
  assert.equal(result.versions, versions);
});

test("JSON export retains deleted content, optional fields and history order", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const current = note({ scope: "private", ownerParticipantId: "p1", deletedAt: "deleted", deletedBy: "p1", content: "retained" });
  const versions = [version({ versionId: "v2", action: "delete" }), version()];
  const result = JSON.parse(JSON.stringify(noteExportJson(current, versions)));
  assert.deepEqual(result.note, current);
  assert.deepEqual(result.versions, versions);
});

test("JSON export reads the clock on each call and returns a fresh wrapper", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const current = note();
  const first = noteExportJson(current, []);
  t.mock.timers.setTime(now + 1000);
  const second = noteExportJson(current, []);
  assert.equal(first.exportedAt, exportedAt);
  assert.equal(second.exportedAt, "2026-01-02T03:04:06.000Z");
  assert.notEqual(first, second);
});

test("shared-note Markdown matches the complete existing format", () => {
  assert.equal(formatNoteMarkdown(note(), [version()]), [
    "# Vrata notes export", "", "Room: room-1", "Scope: shared", "Updated: 2025-12-01T10:00:00Z", "",
    "## Current content", "", "Hello", "", "## History", "",
    "- 2025-12-01T10:00:00Z save by author-1", ""
  ].join("\n"));
});

test("deleted private-note Markdown retains metadata but hides current content", () => {
  const current = note({ scope: "private", ownerParticipantId: "p1", deletedAt: "deleted-at", content: "hidden" });
  const history = [version({ action: "restore", restoredFromVersionId: "old-v", createdBy: null })];
  assert.equal(formatNoteMarkdown(current, history), [
    "# Vrata notes export", "", "Room: room-1", "Scope: private", "Owner participant: p1",
    "Updated: 2025-12-01T10:00:00Z", "Deleted: deleted-at", "", "## Current content", "",
    "_This note is currently deleted._", "", "## History", "",
    "- 2025-12-01T10:00:00Z restore from old-v by unknown", ""
  ].join("\n"));
});

test("updated timestamp uses a nullish fallback rather than a truthy fallback", () => {
  assert.ok(formatNoteMarkdown(note({ updatedAt: null }), []).includes("\nUpdated: never\n"));
  assert.ok(formatNoteMarkdown(note({ updatedAt: "" }), []).includes("\nUpdated: \n"));
});

test("owner metadata is included only for a truthy owner without trimming", () => {
  for (const ownerParticipantId of [undefined, null, ""]) {
    assert.ok(!formatNoteMarkdown(note({ ownerParticipantId }), []).includes("Owner participant:"));
  }
  assert.ok(formatNoteMarkdown(note({ ownerParticipantId: " " }), []).includes("Owner participant:  \n"));
});

test("empty content gets a placeholder while whitespace and Markdown remain verbatim", () => {
  for (const content of ["", " \t", "# Заголовок\r\n<script>raw</script>\n🌍\0"]) {
    assert.ok(formatNoteMarkdown(note({ content }), []).includes(`\n\n${content || "_Empty note._"}\n\n## History\n`));
  }
});

test("deletion is determined by the existing truthiness check", () => {
  for (const deletedAt of [undefined, null, ""]) {
    const text = formatNoteMarkdown(note({ deletedAt }), []);
    assert.ok(text.includes("\n\nHello\n\n"));
    assert.ok(!text.includes("Deleted:"));
  }
  assert.ok(formatNoteMarkdown(note({ deletedAt: " " }), []).includes("_This note is currently deleted._"));
});

test("history preserves input order, action text and distinct empty-field semantics", () => {
  const history = [
    version({ createdAt: "later", action: "delete", createdBy: "", restoredFromVersionId: "" }),
    version({ createdAt: "earlier", action: "save", createdBy: undefined, restoredFromVersionId: " " }),
    version({ createdAt: "middle", action: "restore", createdBy: " p ", restoredFromVersionId: null })
  ];
  assert.ok(formatNoteMarkdown(note(), history).endsWith([
    "## History", "", "- later delete by ", "- earlier save from   by unknown", "- middle restore by  p ", ""
  ].join("\n")));
});

test("empty history retains its heading and exact trailing newlines", () => {
  assert.ok(formatNoteMarkdown(note(), []).endsWith("\n\n## History\n\n"));
});

test("empty room export retains its complete header and trailing newline", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  assert.equal(formatRoomNotesMarkdown("room-1", []), "# Vrata room notes export\n\nRoom: room-1\nExported: 2026-01-02T03:04:05.000Z\n\n");
});

test("room Markdown preserves item order, owner headings and version counts", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const items = [
    { note: note({ scope: "private", ownerParticipantId: "p1", content: "Private" }), versions: [version(), version()] },
    { note: note({ content: "Shared" }), versions: [] }
  ];
  assert.equal(formatRoomNotesMarkdown("room-1", items), [
    "# Vrata room notes export", "", "Room: room-1", `Exported: ${exportedAt}`, "",
    "## private / p1", "", "Private", "", "Versions: 2", "",
    "## shared", "", "Shared", "", "Versions: 0", "", ""
  ].join("\n"));
});

test("room export retains empty and deleted placeholders and verbatim content", () => {
  for (const [content, deletedAt, expected] of [
    ["", null, "_Empty note._"], ["retained", "deleted", "_This note is currently deleted._"],
    [" \t", "", " \t"], ["# Заметки\r\n🌍", null, "# Заметки\r\n🌍"]
  ] as const) {
    const text = formatRoomNotesMarkdown("r", [{ note: note({ content, deletedAt }), versions: [] }]);
    assert.ok(text.includes(`\n## shared\n\n${expected}\n\nVersions: 0\n\n`));
  }
});

test("room owner headings follow truthiness without validation or filtering", () => {
  for (const ownerParticipantId of [undefined, null, "", " "]) {
    const text = formatRoomNotesMarkdown("r", [{ note: note({ scope: "private", ownerParticipantId }), versions: [] }]);
    assert.ok(text.includes(ownerParticipantId ? "\n## private /  \n" : "\n## private\n"));
  }
});

test("room export reads the clock at call time rather than module import time", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  assert.ok(formatRoomNotesMarkdown("r", []).includes(`Exported: ${exportedAt}\n`));
  t.mock.timers.setTime(now + 2000);
  assert.ok(formatRoomNotesMarkdown("r", []).includes("Exported: 2026-01-02T03:04:07.000Z\n"));
});

test("formatting does not mutate note records, histories or the item array", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const items = [{ note: note({ ownerParticipantId: "p1" }), versions: [version({ action: "restore" }), version()] }];
  const before = structuredClone(items);
  Object.freeze(items[0].note);
  items[0].versions.forEach(Object.freeze);
  Object.freeze(items[0].versions);
  Object.freeze(items[0]);
  Object.freeze(items);
  noteExportJson(items[0].note, items[0].versions);
  formatNoteMarkdown(items[0].note, items[0].versions);
  formatRoomNotesMarkdown("r", items);
  assert.deepEqual(items, before);
});
