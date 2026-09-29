import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentLibraryHarness } from "./testing/document-library-harness.js";
import { makeDocument } from "./testing/document-surface-actions-harness.js";

for (const disabled of ["feature", "permission"] as const) {
  test(`document library remains lazy and hides controls without ${disabled}`, async (t) => {
    const h = createDocumentLibraryHarness(t);
    assert.deepEqual(h.events, []); assert.deepEqual(h.dom.created, []); assert.deepEqual(h.dom.storage.writes, []);
    if (disabled === "feature") h.context.runtimeFlags = { documentsEnabled: false };
    else h.context.debugState.access.permissions = [];
    await h.runtime.loadRoomDocuments();
    assert.equal(h.context.documentsPanelEl.hidden, true);
    for (const element of [h.context.documentUploadInput, h.context.documentUploadButton, h.context.documentSelect,
      h.context.documentDownloadButton, h.context.documentSurfaceButton, h.context.documentDeleteButton]) assert.equal(element.disabled, true);
    assert.equal(h.context.documentStatusEl.textContent, disabled === "feature" ? "Documents disabled" : "Documents permission required");
    assert.equal(h.runtime.canPresentDocuments(), false);
    assert.deepEqual(h.events, []);
  });
}

test("document permissions and connection status are read live", (t) => {
  const h = createDocumentLibraryHarness(t); h.context.roomDocuments = [makeDocument("pdf")];
  h.runtime.renderDocumentsUi(); assert.equal(h.runtime.canPresentDocuments(), true);
  h.context.roomStateConnected = false;
  h.runtime.renderDocumentsUi(); assert.equal(h.runtime.canPresentDocuments(), false);
  assert.equal(h.context.documentSurfaceButton.disabled, true); assert.equal(h.context.documentDownloadButton.disabled, false);
  h.context.roomStateConnected = true;
  h.context.debugState.access.permissions = ["document.view"];
  h.runtime.renderDocumentsUi();
  assert.equal(h.context.documentUploadButton.disabled, true); assert.equal(h.context.documentDownloadButton.disabled, true);
  assert.equal(h.context.documentDeleteButton.disabled, true); assert.equal(h.runtime.canPresentDocuments(), false);
  h.context.runtimeFlags = { documentsEnabled: false };
  h.runtime.renderDocumentsUi(); assert.equal(h.context.documentsPanelEl.hidden, true);
});

test("library preserves selection fallback, metadata labels, size rounding and render order", (t) => {
  const h = createDocumentLibraryHarness(t);
  const pdf = { ...makeDocument("pdf", "first"), sizeBytes: 1025 };
  const image = { ...makeDocument("image", "second"), metadata: { kind: "image" as const, widthPx: 640, heightPx: 480 } };
  const plain = { ...makeDocument("pdf", "plain"), metadata: undefined };
  h.context.roomDocuments = [pdf, image, plain]; h.context.selectedDocumentId = "stale";
  assert.equal(h.runtime.selectedDocument(), pdf);
  h.runtime.renderDocumentsUi();
  assert.equal(h.context.selectedDocumentId, "first");
  assert.deepEqual(h.dom.storage.writes, [["vrata.documents.selected.room", "first"]]);
  assert.deepEqual(h.context.documentSelect.elements().map((option) => [option.value, option.textContent, option.selected]), [
    ["first", "first.pdf · 7 pages (2 KB)", true], ["second", "second.image · 640×480 (1 KB)", false], ["plain", "plain.pdf (1 KB)", false]
  ]);
  assert.deepEqual(h.events.map((event) => event.name), ["presentation", "media"]);
  assert.equal(h.context.documentStatusEl.textContent, "Documents ready: 3");
  h.context.selectedDocumentId = "second"; h.runtime.renderDocumentsUi("Selected image");
  assert.equal(h.runtime.selectedDocument(), image); assert.equal(h.context.debugState.documents.selectedFilename, "second.image");
  assert.equal(h.context.debugState.documents.lastStatus, "Selected image");
  h.context.presentationActionInFlight = true; h.runtime.renderDocumentsUi();
  assert.equal(h.context.documentSurfaceButton.disabled, true); assert.equal(h.context.documentDownloadButton.disabled, false);
});

test("an empty library keeps the placeholder and does not clear selection except during loading", (t) => {
  const h = createDocumentLibraryHarness(t); h.context.selectedDocumentId = "stale";
  h.runtime.renderDocumentsUi();
  assert.equal(h.runtime.selectedDocument(), null); assert.equal(h.context.selectedDocumentId, "stale");
  assert.deepEqual(h.dom.storage.writes, []);
  assert.equal(h.context.documentSelect.elements()[0]?.textContent, "No documents");
  assert.equal(h.context.documentSelect.disabled, true); assert.equal(h.context.documentSurfaceButton.disabled, true);
  assert.equal(h.context.documentStatusEl.textContent, "No room documents yet");
});

for (const failure of ["missing-file", "permission"] as const) {
  test(`upload keeps its original ${failure} guard`, async (t) => {
    const h = createDocumentLibraryHarness(t);
    if (failure === "permission") {
      h.context.documentUploadInput.files = [new File(["pdf"], "test.pdf")];
      h.context.debugState.access.permissions = ["document.view"];
    }
    await h.runtime.uploadSelectedDocument();
    assert.equal(h.context.documentStatusEl.textContent, failure === "missing-file" ? "Choose a document first" : "Document upload permission required");
    assert.deepEqual(h.calls("probe"), []); assert.deepEqual(h.calls("upload"), []);
  });
}

test("document diagnostics and error-code truncation retain the existing values", (t) => {
  const h = createDocumentLibraryHarness(t);
  h.context.roomDocuments = [{ ...makeDocument("pdf"), linkedSurfaceId: "surface" }];
  assert.equal(h.runtime.documentErrorCode(new Error("a:b:c:d")), "a:b:c");
  assert.equal(h.runtime.documentErrorCode(""), "document_error");
  assert.equal(h.runtime.documentErrorCode(null), "null");
  h.runtime.setDocumentStatus("message", "code");
  assert.deepEqual(h.context.debugState.documents, { enabled: true, count: 1, selectedDocumentId: "selected",
    selectedFilename: "selected.pdf", selectedSurfaceId: "surface", lastStatus: "message", errorCode: "code" });
});
