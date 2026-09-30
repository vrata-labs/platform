import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentMediaProbe } from "./document-media-probe.js";
import type { RuntimeDocumentRecord } from "./index.js";
import { createDocumentLibraryHarness } from "./testing/document-library-harness.js";
import { deferred, makeDocument } from "./testing/document-surface-actions-harness.js";

test("loading reads the latest selection after awaiting the list and restores controls", async (t) => {
  const h = createDocumentLibraryHarness(t); const result = deferred<RuntimeDocumentRecord[]>();
  h.hooks.listRoomDocuments = () => result.promise;
  const pending = h.runtime.loadRoomDocuments();
  assert.deepEqual(h.calls("list"), [["https://example.invalid", "room", "token-1"]]);
  assert.equal(h.context.documentUploadButton.disabled, true); assert.equal(h.context.documentStatusEl.textContent, "Documents loading...");
  h.context.selectedDocumentId = "second";
  result.resolve([makeDocument("pdf", "first"), makeDocument("pdf", "second")]); await pending;
  assert.equal(h.context.selectedDocumentId, "second"); assert.equal(h.context.documentUploadButton.disabled, false);
  assert.equal(h.context.documentStatusEl.textContent, "Documents ready: 2"); assert.deepEqual(h.dom.storage.writes, []);
});

test("loading clears a disappeared selection before choosing the new first document", async (t) => {
  const h = createDocumentLibraryHarness(t); h.context.selectedDocumentId = "removed";
  h.hooks.listRoomDocuments = async () => [makeDocument("pdf", "first")];
  await h.runtime.loadRoomDocuments();
  assert.deepEqual(h.dom.storage.writes, [["vrata.documents.selected.room", null], ["vrata.documents.selected.room", "first"]]);
});

test("load failure retains its message and the existing final-render diagnostics behavior", async (t) => {
  const h = createDocumentLibraryHarness(t); const warn = t.mock.method(console, "warn", () => {});
  h.hooks.listRoomDocuments = async () => { throw new Error("network:detail:third:fourth"); };
  await h.runtime.loadRoomDocuments();
  assert.equal(warn.mock.calls[0]?.arguments[0], "documents_load_failed");
  assert.equal(h.context.documentStatusEl.textContent, "Documents unavailable");
  // The original finally render clears errorCode while preserving status text.
  assert.equal(h.context.debugState.documents.errorCode, null);
  assert.equal(h.context.documentUploadButton.disabled, false);
});

test("upload observes refreshed tokens after probing and the latest list after uploading", async (t) => {
  const h = createDocumentLibraryHarness(t);
  const probe = deferred<DocumentMediaProbe | null>(); const upload = deferred<RuntimeDocumentRecord>();
  const file = new File(["video"], "test.mp4"); h.context.documentUploadInput.files = [file];
  h.hooks.probeDocumentMedia = () => probe.promise; h.hooks.uploadRoomDocument = () => upload.promise;
  const pending = h.runtime.uploadSelectedDocument();
  assert.equal(h.context.documentUploadButton.disabled, true); assert.deepEqual(h.calls("upload"), []);
  h.context.roomStateAccessToken = "token-2";
  probe.resolve({ kind: "video", widthPx: 640, heightPx: 480, durationMs: 9000 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls("upload"), [["https://example.invalid", "room", "token-2", file,
    { widthPx: 640, heightPx: 480, durationMs: 9000 }]]);
  const untouched = makeDocument("pdf", "untouched");
  h.context.roomDocuments = [makeDocument("video", "uploaded"), untouched];
  const uploaded = makeDocument("video", "uploaded"); upload.resolve(uploaded); await pending;
  assert.deepEqual(h.context.roomDocuments, [uploaded, untouched]);
  assert.equal(h.context.selectedDocumentId, "uploaded"); assert.equal(h.context.documentUploadInput.value, "");
  assert.equal(h.context.documentUploadButton.disabled, false);
  assert.equal(h.context.documentStatusEl.textContent, "Document uploaded: uploaded.video");
  assert.equal(h.dom.storage.getItem("vrata.documents.selected.room"), "uploaded");
});

test("a non-media upload passes undefined probe options", async (t) => {
  const h = createDocumentLibraryHarness(t); h.context.documentUploadInput.files = [new File(["pdf"], "test.pdf")];
  await h.runtime.uploadSelectedDocument(); assert.equal(h.calls("upload")[0]?.[4], undefined);
});

for (const phase of ["probe", "upload"] as const) {
  test(`${phase} failure preserves the status and releases upload busy state`, async (t) => {
    const h = createDocumentLibraryHarness(t); t.mock.method(console, "warn", () => {});
    h.context.documentUploadInput.files = [new File(["pdf"], "test.pdf")]; h.context.documentUploadInput.value = "keep";
    const fail = async () => { throw new Error("failed:reason:detail:discarded"); };
    if (phase === "probe") h.hooks.probeDocumentMedia = fail; else h.hooks.uploadRoomDocument = fail;
    await h.runtime.uploadSelectedDocument();
    assert.equal(h.context.documentUploadButton.disabled, false); assert.equal(h.context.documentUploadInput.value, "keep");
    assert.equal(h.context.documentStatusEl.textContent, "Document upload failed: failed:reason:detail");
    assert.equal(h.context.debugState.documents.errorCode, null);
    if (phase === "probe") assert.deepEqual(h.calls("upload"), []);
  });
}

test("download captures the selection, clicks once and revokes the URL after 1000 ms", async (t) => {
  const h = createDocumentLibraryHarness(t); const selected = makeDocument("pdf"); h.context.roomDocuments = [selected];
  const result = deferred<{ blob: Blob; filename: string }>(); h.hooks.downloadRoomDocument = () => result.promise;
  const pending = h.runtime.downloadSelectedDocument();
  h.context.selectedDocumentId = "different"; h.context.roomStateAccessToken = "token-2";
  const blob = new Blob(["pdf"]); result.resolve({ blob, filename: "download.pdf" }); await pending;
  assert.deepEqual(h.calls("download"), [["https://example.invalid", selected, "token-1"]]);
  assert.deepEqual(h.dom.blobs, [blob]); assert.deepEqual(h.dom.revoked, []);
  const link = h.dom.body.elements()[0]; assert.ok(link);
  assert.equal(link.href, "blob:document-test"); assert.equal(link.download, "download.pdf");
  assert.equal(link.clickCount, 1); assert.equal(link.removed, true);
  assert.equal(h.dom.timers.length, 1); assert.equal(h.dom.timers[0]?.delay, 1000);
  h.dom.timers[0]!.callback(); assert.deepEqual(h.dom.revoked, ["blob:document-test"]);
  assert.equal(h.context.documentStatusEl.textContent, "Document downloaded: download.pdf");
});

test("delete filters the current list after await and persists its new first entry", async (t) => {
  const h = createDocumentLibraryHarness(t); const selected = makeDocument("pdf", "selected");
  h.context.roomDocuments = [selected]; const result = deferred<RuntimeDocumentRecord>(); h.hooks.deleteRoomDocument = () => result.promise;
  const pending = h.runtime.deleteSelectedDocument(); const latest = makeDocument("pdf", "latest");
  h.context.roomDocuments = [selected, latest]; result.resolve(selected); await pending;
  assert.deepEqual(h.calls("delete"), [["https://example.invalid", "room", "selected", "token-1"]]);
  assert.deepEqual(h.context.roomDocuments, [latest]); assert.equal(h.context.selectedDocumentId, "latest");
  assert.equal(h.dom.storage.getItem("vrata.documents.selected.room"), "latest");
  await h.runtime.deleteSelectedDocument();
  assert.equal(h.context.selectedDocumentId, ""); assert.equal(h.dom.storage.getItem("vrata.documents.selected.room"), null);
});

for (const operation of ["download", "delete"] as const) {
  test(`${operation} is idle without a selection and retains errors without clearing the list`, async (t) => {
    const h = createDocumentLibraryHarness(t); t.mock.method(console, "warn", () => {});
    const action = operation === "download" ? h.runtime.downloadSelectedDocument : h.runtime.deleteSelectedDocument;
    await action(); assert.deepEqual(h.events, []);
    h.context.roomDocuments = [makeDocument("pdf")];
    const fail = async () => { throw new Error("denied:detail:third:fourth"); };
    if (operation === "download") h.hooks.downloadRoomDocument = fail; else h.hooks.deleteRoomDocument = fail;
    await action(); assert.equal(h.context.roomDocuments.length, 1);
    assert.equal(h.context.documentStatusEl.textContent, `Document ${operation} failed: denied:detail:third`);
    assert.equal(h.context.debugState.documents.errorCode, "denied:detail:third");
  });
}
