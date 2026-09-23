import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeNoteRecord, RuntimeNoteVersionRecord } from "./index.js";
import { deferred, note, notesHarness, settle, version } from "./testing/notes-runtime-harness.js";

for (const deniedBy of ["flag", "permission"] as const) {
  test(`load/save/export do not call the API when denied by ${deniedBy}`, async (t) => {
    const h = notesHarness(t);
    if (deniedBy === "flag") h.controls.flags = { notesEnabled: false };
    else h.setPermissions();
    await h.runtime.loadActiveNote();
    await h.runtime.saveActiveNote();
    await h.runtime.exportActiveNote("json");
    await h.runtime.exportRoomNotesJson();
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.notesLoadSeq, 0);
    assert.equal(h.state.notesSaveSeq, 0);
    assert.equal(h.state.notesExportInFlight, false);
  });
}

test("load exposes loading state before awaiting, then reads current scope/token for history", async (t) => {
  const h = notesHarness(t);
  const pending = deferred<RuntimeNoteRecord>();
  h.handlers.fetchRoomNote = () => pending.promise;
  const run = h.runtime.loadActiveNote();
  assert.equal(h.state.notesSaveState, "loading");
  assert.equal(h.elements.notesEditor.disabled, true);
  assert.deepEqual(h.calls[0].args, ["https://example.test", "room", "shared", "token-1"]);
  h.state.activeNotesScope = "private";
  h.controls.token = "token-2";
  const versions = [version()];
  h.handlers.listRoomNoteVersions = async () => versions;
  pending.resolve(note("loaded"));
  await run;
  assert.equal(h.elements.notesEditor.value, "loaded");
  assert.equal(h.state.notesLastSavedContent, "loaded");
  assert.equal(h.state.notesLastUpdatedAt, note().updatedAt);
  assert.equal(h.state.notesSaveState, "ready");
  assert.equal(h.state.notesVersions, versions);
  assert.equal(h.elements.notesStatusEl.textContent, "Notes saved");
  assert.deepEqual(h.calls[1].args, ["https://example.test", "room", "private", "token-2"]);
  assert.ok(h.calls.every((call) => call.receiver === undefined));
});

test("a note without update time reports ready rather than saved", async (t) => {
  const h = notesHarness(t);
  h.handlers.fetchRoomNote = async () => note("new", null);
  await h.runtime.loadActiveNote();
  assert.equal(h.elements.notesStatusEl.textContent, "Notes ready");
});

for (const outcome of ["success", "failure"] as const) {
  test(`superseded load ${outcome} cannot overwrite the newer result`, async (t) => {
    const h = notesHarness(t);
    const older = deferred<RuntimeNoteRecord>();
    h.handlers.fetchRoomNote = () => older.promise;
    const oldRun = h.runtime.loadActiveNote();
    h.handlers.fetchRoomNote = async () => note("latest");
    await h.runtime.loadActiveNote();
    if (outcome === "success") older.resolve(note("old"));
    else older.reject(new Error("stale:error"));
    await oldRun;
    assert.equal(h.elements.notesEditor.value, "latest");
    assert.equal(h.state.notesLastSavedContent, "latest");
    assert.equal(h.state.notesSaveState, "ready");
    assert.equal(h.calls.filter((call) => call.name === "listRoomNoteVersions").length, 1);
    assert.deepEqual(h.warnings, []);
  });
}

test("current load failure preserves editor and enables retry", async (t) => {
  const h = notesHarness(t);
  const error = new Error("notes:load:denied:detail");
  h.elements.notesEditor.value = "keep";
  h.handlers.fetchRoomNote = async () => { throw error; };
  await h.runtime.loadActiveNote();
  assert.equal(h.elements.notesEditor.value, "keep");
  assert.equal(h.state.notesSaveState, "failed");
  assert.equal(h.elements.notesRetrySaveButton.hidden, false);
  assert.equal(h.context.debugState.notes.errorCode, "notes:load:denied");
  assert.deepEqual(h.warnings, [["notes_load_failed", error]]);
});

test("history failure clears versions without failing the successfully loaded note", async (t) => {
  const h = notesHarness(t);
  h.state.notesVersions = [version()];
  const error = new Error("history");
  h.handlers.listRoomNoteVersions = async () => { throw error; };
  await h.runtime.loadActiveNote();
  assert.ok(Array.isArray(h.state.notesVersions));
  assert.equal(h.state.notesVersions.length, 0);
  assert.equal(h.state.notesHistoryLoading, false);
  assert.equal(h.state.notesSaveState, "ready");
  assert.equal(h.context.debugState.notes.errorCode, null);
  assert.deepEqual(h.warnings, [["notes_versions_load_failed", error]]);
});

test("revoked permission between loading note and history prevents the history request", async (t) => {
  const h = notesHarness(t);
  h.state.notesVersions = [version()];
  h.handlers.fetchRoomNote = async () => { h.setPermissions(); return note(); };
  await h.runtime.loadActiveNote();
  assert.deepEqual(h.calls.map((call) => call.name), ["fetchRoomNote"]);
  assert.ok(Array.isArray(h.state.notesVersions));
  assert.equal(h.state.notesVersions.length, 0);
  assert.equal(h.elements.notesPanelEl.hidden, true);
});

for (const updatedAt of [null, "previous-time"]) {
  test(`unchanged content avoids a save request (updatedAt=${updatedAt})`, async (t) => {
    const h = notesHarness(t);
    h.state.notesLastSavedContent = "same";
    h.state.notesLastUpdatedAt = updatedAt;
    h.elements.notesEditor.value = "same";
    await h.runtime.saveActiveNote();
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.notesSaveState, "saved");
    assert.equal(h.elements.notesStatusEl.textContent, updatedAt ? "Notes saved" : "Notes ready");
  });
}

test("private notes may save with view permission while shared notes require edit", async (t) => {
  const h = notesHarness(t);
  h.setPermissions("notes.view");
  h.elements.notesEditor.value = "private edit";
  await h.runtime.saveActiveNote();
  assert.equal(h.calls.length, 0);
  h.state.activeNotesScope = "private";
  await h.runtime.saveActiveNote();
  await settle();
  assert.equal(h.calls[0].name, "saveRoomNote");
  assert.equal(h.calls[0].args[2], "private");
});

test("save preserves submitted content, refreshes history without waiting, and reschedules newer edits", async (t) => {
  const h = notesHarness(t);
  const pending = deferred<RuntimeNoteRecord>();
  const history = deferred<RuntimeNoteVersionRecord[]>();
  h.handlers.saveRoomNote = () => pending.promise;
  h.handlers.listRoomNoteVersions = () => history.promise;
  h.elements.notesEditor.value = "submitted";
  const run = h.runtime.saveActiveNote();
  assert.equal(h.state.notesSaveState, "saving");
  assert.deepEqual(h.calls[0].args, ["https://example.test", "room", "shared", "token-1", "submitted"]);
  h.elements.notesEditor.value = "new edit";
  pending.resolve(note("server normalized", "saved-time"));
  await run;
  assert.equal(h.state.notesLastSavedContent, "submitted");
  assert.equal(h.state.notesLastUpdatedAt, "saved-time");
  assert.equal(h.elements.notesEditor.value, "new edit");
  assert.equal(h.state.notesSaveState, "pending");
  assert.equal(h.state.notesHistoryLoading, true);
  assert.equal(h.timers.get(h.state.notesAutosaveTimer!)?.delay, 650);
  history.resolve([]);
  await settle();
  assert.equal(h.state.notesHistoryLoading, false);
});

for (const outcome of ["success", "failure"] as const) {
  test(`superseded save ${outcome} is ignored`, async (t) => {
    const h = notesHarness(t);
    const older = deferred<RuntimeNoteRecord>();
    h.elements.notesEditor.value = "old";
    h.handlers.saveRoomNote = () => older.promise;
    const oldRun = h.runtime.saveActiveNote();
    h.elements.notesEditor.value = "latest";
    h.handlers.saveRoomNote = async () => note("latest");
    await h.runtime.saveActiveNote();
    if (outcome === "success") older.resolve(note("old"));
    else older.reject(new Error("stale save"));
    await oldRun;
    await settle();
    assert.equal(h.state.notesLastSavedContent, "latest");
    assert.equal(h.state.notesSaveState, "saved");
    assert.equal(h.calls.filter((call) => call.name === "listRoomNoteVersions").length, 1);
    assert.deepEqual(h.warnings, []);
  });
}

for (const [error, expected] of [[new Error("save:a:b:c"), "save:a:b"], ["", "notes_error"], [0, "0"], [null, "null"]] as const) {
  test(`save failure retains original error normalization (${expected})`, async (t) => {
    const h = notesHarness(t);
    h.elements.notesEditor.value = "unsaved";
    h.handlers.saveRoomNote = async () => { throw error; };
    await h.runtime.saveActiveNote();
    assert.equal(h.state.notesLastSavedContent, "");
    assert.equal(h.state.notesSaveState, "failed");
    assert.equal(h.context.debugState.notes.errorCode, expected);
    assert.deepEqual(h.warnings, [["notes_save_failed", error]]);
  });
}

for (const blockedBy of ["empty", "unknown", "permission", "cancel"] as const) {
  test(`restore does not issue a request when blocked by ${blockedBy}`, async (t) => {
    const h = notesHarness(t);
    h.state.notesVersions = [version()];
    h.elements.notesVersionSelect.value = blockedBy === "empty" ? "" : blockedBy === "unknown" ? "missing" : "v1";
    if (blockedBy === "permission") h.setPermissions("notes.view");
    h.controls.confirm = blockedBy !== "cancel";
    await h.runtime.restoreSelectedNoteVersion();
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.notesSaveState, "idle");
  });
}

test("restore applies server content, save state and history after confirmation", async (t) => {
  const h = notesHarness(t);
  h.state.notesVersions = [version()];
  h.elements.notesVersionSelect.value = "v1";
  await h.runtime.restoreSelectedNoteVersion();
  assert.deepEqual(h.calls[0].args, ["https://example.test", "room", "shared", "token-1", "v1"]);
  assert.equal(h.elements.notesEditor.value, "restored");
  assert.equal(h.state.notesLastSavedContent, "restored");
  assert.equal(h.state.notesSaveState, "saved");
  assert.equal(h.elements.notesStatusEl.textContent, "Notes version restored");
  assert.deepEqual(h.confirmations, [`Restore notes version from ${new Date(version().createdAt).toLocaleString()}?`]);
});

test("restore request failure leaves unsaved text in the editor", async (t) => {
  const h = notesHarness(t);
  h.state.notesVersions = [version()];
  h.elements.notesVersionSelect.value = "v1";
  h.elements.notesEditor.value = "unsaved";
  h.handlers.restoreRoomNoteVersion = async () => { throw new Error("restore:denied"); };
  await h.runtime.restoreSelectedNoteVersion();
  assert.equal(h.elements.notesEditor.value, "unsaved");
  assert.equal(h.context.debugState.notes.errorCode, "restore:denied");
  assert.equal(h.elements.notesStatusEl.textContent, "Notes restore failed");
});

test("confirmation errors propagate without being converted to restore failures", async (t) => {
  const h = notesHarness(t);
  h.state.notesVersions = [version()];
  h.elements.notesVersionSelect.value = "v1";
  const error = new Error("confirmation unavailable");
  t.mock.method(window, "confirm", () => { throw error; });
  await assert.rejects(h.runtime.restoreSelectedNoteVersion(), (caught) => caught === error);
  assert.equal(h.state.notesSaveState, "idle");
  assert.deepEqual(h.warnings, []);
});

for (const format of ["markdown", "json", "room-json"] as const) {
  test(`export ${format} preserves blob, filename, request arguments and busy state`, async (t) => {
    const h = notesHarness(t);
    const pending = deferred<{ blob: Blob; filename: string }>();
    h.handlers.exportRoomNote = () => pending.promise;
    h.handlers.exportRoomNotesArchive = () => pending.promise;
    h.state.activeNotesScope = "private";
    h.controls.token = "fresh-token";
    const run = format === "room-json" ? h.runtime.exportRoomNotesJson() : h.runtime.exportActiveNote(format);
    assert.equal(h.state.notesExportInFlight, true);
    assert.equal(h.elements.notesExportJsonButton.disabled, true);
    assert.deepEqual(h.calls[0].args, format === "room-json"
      ? ["https://example.test", "room", "fresh-token", "json"]
      : ["https://example.test", "room", "private", "fresh-token", format]);
    const download = { blob: new Blob(["exported"]), filename: "original filename.json" };
    pending.resolve(download);
    await run;
    assert.equal(h.downloads[0].blob, download.blob);
    assert.equal(h.downloads[0].filename, download.filename);
    assert.equal(h.state.notesExportInFlight, false);
    assert.equal(h.elements.notesExportJsonButton.disabled, false);
    assert.equal(h.context.debugState.notes.exportInFlight, false);
    assert.equal(h.elements.notesStatusEl.textContent, `${format === "room-json" ? "Room notes" : "Notes"} exported: ${download.filename}`);
  });
}

for (const source of ["note-request", "archive-request", "download"] as const) {
  test(`export failure from ${source} retains diagnostics and clears busy state`, async (t) => {
    const h = notesHarness(t);
    const error = new Error("export:failed:detail:extra");
    if (source === "download") h.failDownload(error);
    else if (source === "note-request") h.handlers.exportRoomNote = async () => { throw error; };
    else h.handlers.exportRoomNotesArchive = async () => { throw error; };
    if (source === "archive-request") await h.runtime.exportRoomNotesJson();
    else await h.runtime.exportActiveNote("json");
    assert.equal(h.state.notesExportInFlight, false);
    assert.equal(h.state.notesSaveState, "failed");
    assert.equal(h.context.debugState.notes.errorCode, "export:failed:detail");
    assert.equal(h.warnings[0][1], error);
    assert.equal(h.elements.notesRetrySaveButton.hidden, false);
  });
}
