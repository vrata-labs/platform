import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeDocumentLibrary, RuntimeDocumentRecord } from "./index.js";
import { createDocumentLibraryHarness } from "./testing/document-library-harness.js";
import { deferred, makeDocument } from "./testing/document-surface-actions-harness.js";
import { DOCUMENT_UPLOAD_FORMATS } from "@vrata/shared-types";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const library = (items: RuntimeDocumentRecord[]): RuntimeDocumentLibrary => ({ items, uploadPolicy: null });

for (const operation of ["download", "delete"] as const) {
  test(`${operation}: revocation and regrant retire the old response and its browser effects`, async t => {
    const h = createDocumentLibraryHarness(t), old = makeDocument("pdf", "old"), latest = makeDocument("pdf", "latest");
    h.context.roomDocuments = [old]; h.runtime.renderDocumentsUi();
    const response = deferred<any>();
    if (operation === "download") h.hooks.downloadRoomDocument = () => response.promise;
    else h.hooks.deleteRoomDocument = () => response.promise;
    h.hooks.listRoomDocuments = async () => library([latest]);
    const pending = operation === "download" ? h.runtime.downloadSelectedDocument() : h.runtime.deleteSelectedDocument();
    const signal = h.calls(operation)[0]![operation === "download" ? 3 : 4] as AbortSignal;
    const permissions = [...h.context.debugState.access.permissions];
    h.context.debugState.access.permissions = permissions.filter(permission => permission !== `document.${operation}`);
    h.runtime.renderDocumentsUi(); assert.equal(signal.aborted, true);
    h.context.debugState.access.permissions = permissions; h.runtime.renderDocumentsUi();
    await tick();
    response.resolve(operation === "download" ? { blob: new Blob(["old"]), filename: "old.pdf" } : old);
    await pending; await tick();
    assert.deepEqual(h.context.roomDocuments, operation === "delete" ? [latest] : [old]);
    assert.equal(h.context.selectedDocumentId, operation === "delete" ? "latest" : "old");
    assert.equal(h.dom.blobs.length, 0); assert.equal(h.dom.created.filter(element => element.tagName === "a").length, 0);
    assert.doesNotMatch(h.context.documentStatusEl.textContent, /downloaded|deleted/);
    assert.equal(h.calls("list").length, operation === "delete" ? 1 : 0, "only an interrupted mutation needs an authoritative refresh");
  });

  test(`${operation}: terminal invalidation ignores late success and creates no stale storage writes`, async t => {
    const h = createDocumentLibraryHarness(t); h.context.roomDocuments = [makeDocument("pdf", "old")]; h.runtime.renderDocumentsUi();
    const delayed = deferred<any>();
    if (operation === "download") h.hooks.downloadRoomDocument = () => delayed.promise; else h.hooks.deleteRoomDocument = () => delayed.promise;
    const pending = operation === "download" ? h.runtime.downloadSelectedDocument() : h.runtime.deleteSelectedDocument();
    h.context.sessionControlBlocked = true; h.runtime.invalidate(); h.runtime.renderDocumentsUi();
    const writes = h.dom.storage.writes.length;
    delayed.resolve(operation === "download" ? { blob: new Blob(["old"]), filename: "old.pdf" } : makeDocument("pdf", "old"));
    await pending; await tick();
    assert.equal(h.dom.storage.writes.length, writes); assert.equal(h.dom.blobs.length, 0);
    assert.equal(h.context.documentsPanelEl.hidden, true); assert.equal(h.context.documentOperationProgressEl.hidden, true);
  });
}

test("download uses an independent controller and remains available during a pending upload", async t => {
  const h = createDocumentLibraryHarness(t), original = makeDocument("pdf", "original");
  h.context.roomDocuments = [original]; h.context.documentUploadInput.files = [new File(["pdf"], "new.pdf")];
  const uploading = deferred<RuntimeDocumentRecord>(); h.hooks.uploadRoomDocument = () => uploading.promise;
  const pending = h.runtime.uploadSelectedDocument(); await tick();
  assert.equal(h.context.documentUploadButton.disabled, true); assert.equal(h.context.documentDownloadButton.disabled, false);
  await h.runtime.downloadSelectedDocument();
  assert.equal(h.calls("download").length, 1); assert.equal(h.dom.blobs.length, 1);
  assert.notEqual(h.calls("upload")[0]![5], h.calls("download")[0]![3]);
  assert.equal(h.context.documentOperationProgressEl.hidden, false);
  uploading.resolve(makeDocument("pdf", "new")); await pending;
  assert.equal(h.context.documentOperationProgressEl.hidden, true);
});

test("permission promotion does not cancel an authorized pending upload", async t => {
  const h = createDocumentLibraryHarness(t);
  h.context.debugState.access.permissions = ["document.view", "document.upload", "document.download", "document.present"];
  h.runtime.renderDocumentsUi(); await tick();
  h.context.documentUploadInput.files = [new File(["pdf"], "new.pdf")];
  const delayed = deferred<RuntimeDocumentRecord>(); h.hooks.uploadRoomDocument = () => delayed.promise;
  const pending = h.runtime.uploadSelectedDocument(); await tick();
  const signal = h.calls("upload")[0]![5] as AbortSignal;
  h.context.debugState.access.permissions.push("document.delete"); h.runtime.renderDocumentsUi();
  assert.equal(signal.aborted, false);
  delayed.resolve(makeDocument("pdf", "promoted")); await pending;
  assert.equal(h.context.selectedDocumentId, "promoted");
});

test("deletion ACK preserves an explicit newer selection and an older list cannot resurrect the document", async t => {
  const h = createDocumentLibraryHarness(t), first = makeDocument("pdf", "first"), second = makeDocument("pdf", "second"), third = makeDocument("pdf", "third");
  h.context.roomDocuments = [first, second, third]; h.context.selectedDocumentId = "first";
  const deleting = deferred<RuntimeDocumentRecord>(), listing = deferred<RuntimeDocumentLibrary>();
  h.hooks.deleteRoomDocument = () => deleting.promise; h.hooks.listRoomDocuments = () => listing.promise;
  const remove = h.runtime.deleteSelectedDocument(), load = h.runtime.loadRoomDocuments();
  h.context.selectedDocumentId = "third";
  deleting.resolve(first); await remove;
  listing.resolve({ items: [first, second, third], uploadPolicy: { schemaVersion: 1, maxFileBytes: 128, maxPdfPages: 2, acceptedContentTypes: ["application/pdf"] } });
  await load;
  assert.deepEqual(h.context.roomDocuments, [second, third]); assert.equal(h.context.selectedDocumentId, "third");
  assert.match(h.context.documentUploadPolicyEl.textContent, /128 bytes/, "policy is not discarded with stale list items");
});

test("an unconfirmed deletion refreshes once, retains safe uncertainty feedback and never repeats DELETE", async t => {
  const h = createDocumentLibraryHarness(t); h.context.roomDocuments = [makeDocument("pdf", "old")];
  h.hooks.deleteRoomDocument = async () => { throw new Error("private-storage-endpoint-and-credential"); };
  h.hooks.listRoomDocuments = async () => library([]);
  await h.runtime.deleteSelectedDocument(); await tick();
  assert.equal(h.calls("delete").length, 1); assert.equal(h.calls("list").length, 1);
  assert.deepEqual(h.context.roomDocuments, []);
  assert.match(h.context.documentStatusEl.textContent, /could not be confirmed/);
  assert.doesNotMatch(h.context.documentStatusEl.textContent, /private|credential|not deleted/);
});

test("upload metadata preflight runs before media decoding or the network request", async t => {
  const h = createDocumentLibraryHarness(t);
  h.hooks.listRoomDocuments = async () => ({ items: [], uploadPolicy: { schemaVersion: 1, maxFileBytes: 4, maxPdfPages: 3,
    acceptedContentTypes: DOCUMENT_UPLOAD_FORMATS.map(format => format.contentType) } });
  await h.runtime.loadRoomDocuments();
  for (const file of [new File(["12345"], "large.png", { type: "image/png" }), new File(["x"], "unsupported.html", { type: "text/html" })]) {
    h.context.documentUploadInput.files = [file]; await h.runtime.uploadSelectedDocument();
    assert.equal(h.calls("probe").length, 0); assert.equal(h.calls("upload").length, 0);
    assert.equal(h.context.documentOperationProgressEl.hidden, true);
    assert.ok(["document_too_large", "unsupported_document_mime"].includes(h.context.debugState.documents.errorCode!));
  }
});

test("an older download finally cannot clear a replacement operation's busy state", async t => {
  const h = createDocumentLibraryHarness(t); h.context.roomDocuments = [makeDocument("pdf", "current")];
  const old = deferred<{ blob: Blob; filename: string }>(), latest = deferred<{ blob: Blob; filename: string }>();
  h.hooks.downloadRoomDocument = () => old.promise; const first = h.runtime.downloadSelectedDocument();
  h.runtime.invalidate(); h.hooks.downloadRoomDocument = () => latest.promise;
  const second = h.runtime.downloadSelectedDocument(); await first;
  assert.equal(h.context.documentDownloadButton.disabled, true);
  old.resolve({ blob: new Blob(["old"]), filename: "old.pdf" }); await tick();
  assert.equal(h.context.documentDownloadButton.disabled, true); assert.equal(h.dom.blobs.length, 0);
  latest.resolve({ blob: new Blob(["current"]), filename: "current.pdf" }); await second;
  assert.equal(h.context.documentDownloadButton.disabled, false); assert.equal(h.dom.blobs.length, 1);
});

test("loss of delete permission leaves authorized pending upload and download untouched", async t => {
  const h = createDocumentLibraryHarness(t), original = makeDocument("pdf", "original");
  h.context.roomDocuments = [original]; h.context.documentUploadInput.files = [new File(["pdf"], "new.pdf")];
  const uploading = deferred<RuntimeDocumentRecord>(), downloading = deferred<{ blob: Blob; filename: string }>();
  h.hooks.uploadRoomDocument = () => uploading.promise; h.hooks.downloadRoomDocument = () => downloading.promise;
  const upload = h.runtime.uploadSelectedDocument(); await tick(); const download = h.runtime.downloadSelectedDocument();
  h.context.debugState.access.permissions = h.context.debugState.access.permissions.filter(permission => permission !== "document.delete");
  h.runtime.renderDocumentsUi();
  assert.equal((h.calls("upload")[0]![5] as AbortSignal).aborted, false);
  assert.equal((h.calls("download")[0]![3] as AbortSignal).aborted, false);
  uploading.resolve(makeDocument("pdf", "new")); await upload;
  downloading.resolve({ blob: new Blob(["original"]), filename: "original.pdf" }); await download;
  assert.equal(h.context.roomDocuments.length, 2); assert.equal(h.dom.blobs.length, 1); assert.equal(h.calls("list").length, 0);
});

test("unconfirmed upload refreshes once and never claims a possibly committed upload failed", async t => {
  const h = createDocumentLibraryHarness(t), committed = makeDocument("pdf", "committed");
  h.context.documentUploadInput.files = [new File(["pdf"], "committed.pdf")];
  h.hooks.uploadRoomDocument = async () => { throw new TypeError("private-transport-details"); };
  h.hooks.listRoomDocuments = async () => library([committed]);
  await h.runtime.uploadSelectedDocument(); await tick();
  assert.equal(h.calls("upload").length, 1); assert.equal(h.calls("list").length, 1);
  assert.deepEqual(h.context.roomDocuments, [committed]); assert.equal(h.context.selectedDocumentId, "committed");
  assert.equal(h.context.debugState.documents.errorCode, "document_upload_unconfirmed");
  assert.doesNotMatch(h.context.documentStatusEl.textContent, /upload failed|private|transport/i);
});

test("required uncertainty refresh retries once when a concurrent upload ACK supersedes its snapshot", async t => {
  const h = createDocumentLibraryHarness(t), old = makeDocument("pdf", "old"), added = makeDocument("pdf", "added");
  h.context.roomDocuments = [old]; h.context.documentUploadInput.files = [new File(["pdf"], "added.pdf")];
  const uploading = deferred<RuntimeDocumentRecord>(), stale = deferred<RuntimeDocumentLibrary>();
  h.hooks.uploadRoomDocument = () => uploading.promise;
  h.hooks.deleteRoomDocument = async () => { throw new Error("ACK lost"); };
  let lists = 0; h.hooks.listRoomDocuments = () => ++lists === 1 ? stale.promise : Promise.resolve(library([added]));
  const upload = h.runtime.uploadSelectedDocument(); await tick();
  await h.runtime.deleteSelectedDocument(); await tick();
  uploading.resolve(added); await upload;
  stale.resolve(library([old])); await tick(); await tick();
  assert.equal(lists, 2); assert.deepEqual(h.context.roomDocuments, [added]);
  assert.equal(h.calls("delete").length, 1, "refresh must never repeat an uncertain mutation");
});

test("a retired document's pending download reports not found instead of leaving a stale downloading message", async t => {
  const h = createDocumentLibraryHarness(t); h.context.roomDocuments = [makeDocument("pdf", "removed")];
  const delayed = deferred<{ blob: Blob; filename: string }>(); h.hooks.downloadRoomDocument = () => delayed.promise;
  const pending = h.runtime.downloadSelectedDocument(); h.context.roomDocuments = [];
  delayed.resolve({ blob: new Blob(["old"]), filename: "removed.pdf" }); await pending;
  assert.equal(h.dom.blobs.length, 0); assert.equal(h.context.debugState.documents.errorCode, "document_not_found");
  assert.doesNotMatch(h.context.documentStatusEl.textContent, /Downloading/);
});

test("pagehide clears busy UI and persisted pageshow reloads the authoritative library", async t => {
  const h = createDocumentLibraryHarness(t); h.context.roomDocuments = [makeDocument("pdf", "old")];
  const delayed = deferred<{ blob: Blob; filename: string }>(); h.hooks.downloadRoomDocument = () => delayed.promise;
  const pending = h.runtime.downloadSelectedDocument(); assert.equal(h.context.documentOperationProgressEl.hidden, false);
  h.runtime.onPageHide(); await pending;
  assert.equal(h.context.documentOperationProgressEl.hidden, true);
  assert.equal(h.context.documentsPanelEl.getAttribute("aria-busy"), "false");
  assert.doesNotMatch(h.context.documentStatusEl.textContent, /Downloading/);
  const latest = makeDocument("pdf", "after-cache"); h.hooks.listRoomDocuments = async () => library([latest]);
  await h.runtime.onPageShow({ persisted: true }); assert.deepEqual(h.context.roomDocuments, [latest]);
  delayed.resolve({ blob: new Blob(["old"]), filename: "old.pdf" }); await tick(); assert.equal(h.dom.blobs.length, 0);
});

test("revoking upload during probe sends neither POST nor a needless library refresh", async t => {
  const h = createDocumentLibraryHarness(t), probe = deferred<null>();
  h.context.documentUploadInput.files = [new File(["video"], "clip.mp4", { type: "video/mp4" })];
  h.hooks.probeDocumentMedia = () => probe.promise;
  const pending = h.runtime.uploadSelectedDocument();
  h.context.debugState.access.permissions = h.context.debugState.access.permissions.filter(permission => permission !== "document.upload");
  h.runtime.renderDocumentsUi(); probe.resolve(null); await pending; await tick();
  assert.equal(h.calls("upload").length, 0); assert.equal(h.calls("list").length, 0);
  assert.equal(h.context.debugState.documents.errorCode, "document_permission_denied");
});

test("revoking a sent upload retains uncertainty and refreshes once without repeating POST", async t => {
  const h = createDocumentLibraryHarness(t), committed = makeDocument("pdf", "committed"), pendingResponse = deferred<RuntimeDocumentRecord>();
  h.context.documentUploadInput.files = [new File(["pdf"], "committed.pdf")];
  h.hooks.uploadRoomDocument = () => pendingResponse.promise; h.hooks.listRoomDocuments = async () => library([committed]);
  const pending = h.runtime.uploadSelectedDocument(); await tick();
  h.context.debugState.access.permissions = h.context.debugState.access.permissions.filter(permission => permission !== "document.upload");
  h.runtime.renderDocumentsUi(); await pending; await tick();
  assert.equal((h.calls("upload")[0]![5] as AbortSignal).aborted, true);
  assert.equal(h.calls("upload").length, 1); assert.equal(h.calls("list").length, 1);
  assert.equal(h.context.debugState.documents.errorCode, "document_upload_unconfirmed");
  pendingResponse.resolve(committed); await tick(); assert.deepEqual(h.context.roomDocuments, [committed]);
});
