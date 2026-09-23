import assert from "node:assert/strict";
import test from "node:test";
import { createNotesRuntimeState } from "./notes-runtime.js";
import { note, notesHarness, settle, version } from "./testing/notes-runtime-harness.js";

test("notes state preserves defaults and allocates independent version arrays", () => {
  const state = createNotesRuntimeState("private");
  assert.deepEqual(state, {
    activeNotesScope: "private", notesSaveState: "idle", notesLastSavedContent: "", notesLastUpdatedAt: null,
    notesLoadSeq: 0, notesSaveSeq: 0, notesAutosaveTimer: null, notesVersions: [], notesHistoryLoading: false, notesExportInFlight: false
  });
  state.notesVersions.push(version());
  assert.deepEqual(createNotesRuntimeState("shared").notesVersions, []);
});

test("construction does not read flags or token, issue requests, render or schedule work", (t) => {
  const h = notesHarness(t);
  assert.equal(h.controls.flagReads, 0);
  assert.equal(h.controls.tokenReads, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.elements.notesPreviewEl.children, []);
});

test("previously captured callbacks observe replacement flags and access objects", (t) => {
  const h = notesHarness(t);
  const { canViewNotes } = h.runtime;
  assert.equal(canViewNotes(), true);
  h.controls.flags = { notesEnabled: false };
  assert.equal(canViewNotes(), false);
  h.controls.flags = { notesEnabled: true };
  h.setPermissions();
  assert.equal(canViewNotes(), false);
  h.setPermissions("notes.view");
  assert.equal(canViewNotes(), true);
});

for (const [enabled, view, scope, edit, visible, editable, status] of [
  [false, true, "shared", true, false, false, "Notes disabled"],
  [true, false, "private", true, false, false, "Notes permission required"],
  [true, true, "shared", false, true, false, "Notes read-only"],
  [true, true, "shared", true, true, true, "unchanged"],
  [true, true, "private", false, true, true, "unchanged"]
] as const) {
  test(`notes access enabled=${enabled} view=${view} scope=${scope} edit=${edit}`, (t) => {
    const h = notesHarness(t);
    h.controls.flags = { notesEnabled: enabled };
    h.setPermissions(...(view ? ["notes.view" as const] : []), ...(edit ? ["notes.edit" as const] : []));
    h.state.activeNotesScope = scope;
    h.elements.notesStatusEl.textContent = "unchanged";
    h.runtime.syncNotesAccessUi();
    assert.equal(h.elements.notesPanelEl.hidden, !visible);
    assert.equal(h.elements.notesEditor.disabled, !editable);
    assert.equal(h.elements.notesScopeSelect.disabled, !visible);
    assert.equal(h.elements.notesStatusEl.textContent, status);
    assert.equal(h.context.debugState.notes.canEdit, editable);
    assert.equal(h.context.debugState.notes.enabled, enabled);
  });
}

test("loading locks editor and scope but does not disable version controls by itself", (t) => {
  const h = notesHarness(t);
  h.state.notesSaveState = "loading";
  h.state.notesVersions = [version()];
  h.runtime.syncNotesAccessUi();
  assert.equal(h.elements.notesEditor.disabled, true);
  assert.equal(h.elements.notesScopeSelect.disabled, true);
  assert.equal(h.elements.notesVersionSelect.disabled, false);
  assert.equal(h.elements.notesRestoreVersionButton.disabled, false);
});

test("history retains enumeration order and selected version and formats labels", (t) => {
  const h = notesHarness(t);
  h.state.notesVersions = [version("new", "restore"), version("old")];
  h.elements.notesVersionSelect.value = "old";
  h.runtime.syncNotesAccessUi();
  assert.equal(h.elements.notesVersionSelect.value, "old");
  assert.deepEqual(h.elements.notesVersionSelect.children.map((el) => el.value), ["new", "old"]);
  const when = new Date(version().createdAt).toLocaleString();
  assert.deepEqual(h.elements.notesVersionSelect.children.map((el) => el.textContent), [`Current - restore - ${when}`, `Version 1 - save - ${when}`]);
  assert.equal(h.context.debugState.notes.versionCount, 2);
});

test("empty history renders its placeholder and disables restoration", (t) => {
  const h = notesHarness(t);
  h.runtime.syncNotesAccessUi();
  assert.equal(h.elements.notesVersionSelect.children[0].textContent, "No versions");
  assert.equal(h.elements.notesVersionSelect.disabled, true);
  assert.equal(h.elements.notesRestoreVersionButton.disabled, true);
  assert.equal(h.elements.notesExportMarkdownButton.disabled, false);
});

test("history-loading and export flags independently control their buttons", (t) => {
  const h = notesHarness(t);
  h.state.notesVersions = [version()];
  h.state.notesHistoryLoading = true;
  h.state.notesExportInFlight = true;
  h.runtime.syncNotesAccessUi();
  for (const key of ["notesVersionSelect", "notesRestoreVersionButton", "notesExportMarkdownButton", "notesExportJsonButton", "notesExportRoomJsonButton"] as const) {
    assert.equal(h.elements[key].disabled, true);
  }
  assert.equal(h.context.debugState.notes.exportInFlight, true);
});

test("preview preserves heading/list/code ordering and inserts untrusted markup as text", async (t) => {
  const h = notesHarness(t);
  const text = "# Title\n\n- one\n- two\n\n<script>alert(1)</script>\n\n```\n<b>code</b>\n```\n\n- end";
  h.handlers.fetchRoomNote = async () => note(text);
  await h.runtime.loadActiveNote();
  const children = h.elements.notesPreviewEl.children;
  assert.deepEqual(children.map((el) => el.tagName), ["h1", "ul", "p", "pre", "ul"]);
  assert.deepEqual(children[1].children.map((el) => el.textContent), ["one", "two"]);
  assert.equal(children[2].textContent, "<script>alert(1)</script>");
  assert.equal(children[3].textContent, "<b>code</b>");
  assert.equal(children[4].children[0].textContent, "end");
  assert.equal(h.context.debugState.notes.contentLength, text.length);
});

test("empty note renders the original placeholder", async (t) => {
  const h = notesHarness(t);
  h.handlers.fetchRoomNote = async () => note("");
  await h.runtime.loadActiveNote();
  assert.equal(h.elements.notesPreviewEl.children[0].textContent, "No notes yet.");
});

test("autosave replaces the old timer, preserves default delay, and clears ID before saving", async (t) => {
  const h = notesHarness(t);
  h.elements.notesEditor.value = "first";
  h.runtime.scheduleNotesAutosave();
  const first = h.state.notesAutosaveTimer!;
  assert.equal(h.timers.get(first)?.delay, 650);
  assert.equal(h.state.notesSaveState, "pending");
  h.elements.notesEditor.value = "second";
  h.runtime.scheduleNotesAutosave(12);
  const second = h.state.notesAutosaveTimer!;
  assert.deepEqual(h.timerEvents, [["set", first], ["clear", first], ["set", second]]);
  assert.equal(h.timers.get(second)?.delay, 12);
  h.handlers.saveRoomNote = async (...args) => {
    assert.equal(h.state.notesAutosaveTimer, null);
    return note(args[4]);
  };
  h.fireTimer();
  await settle();
  assert.equal(h.state.notesLastSavedContent, "second");
});

test("denied autosave leaves an existing timer untouched", (t) => {
  const h = notesHarness(t);
  h.runtime.scheduleNotesAutosave();
  const timer = h.state.notesAutosaveTimer;
  h.setPermissions("notes.view");
  h.runtime.scheduleNotesAutosave();
  assert.equal(h.state.notesAutosaveTimer, timer);
  assert.deepEqual(h.timerEvents, [["set", timer]]);
});

test("editing during loading leaves save state loading while scheduling the timer", (t) => {
  const h = notesHarness(t);
  h.state.notesSaveState = "loading";
  h.runtime.scheduleNotesAutosave(0);
  assert.equal(h.state.notesSaveState, "loading");
  assert.equal(h.timers.get(h.state.notesAutosaveTimer!)?.delay, 0);
});

test("state updates replace the notes diagnostic object and clear prior error", (t) => {
  const h = notesHarness(t);
  const previous = h.context.debugState.notes;
  previous.errorCode = "old";
  h.state.notesLastUpdatedAt = "timestamp";
  h.state.notesVersions = [version()];
  h.elements.notesEditor.value = "abc";
  h.runtime.scheduleNotesAutosave();
  assert.notEqual(h.context.debugState.notes, previous);
  assert.equal(previous.errorCode, "old");
  assert.equal(h.context.debugState.notes.errorCode, null);
  assert.equal(h.context.debugState.notes.updatedAt, "timestamp");
  assert.equal(h.context.debugState.notes.versionCount, 1);
  assert.equal(h.elements.notesRetrySaveButton.hidden, true);
});
