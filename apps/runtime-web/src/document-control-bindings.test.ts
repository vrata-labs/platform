import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { MediaObjectInstance, PdfPresentationState } from "@vrata/shared-types";
import { bindDocumentControls, type DocumentControlBindingsContext } from "./document-control-bindings.js";
import { DocumentTestElement, installDocumentTestDom } from "./testing/document-ui-dom.js";
import { makeObject } from "./testing/document-surface-actions-harness.js";

function harness(t: TestContext) {
  const dom = installDocumentTestDom(t);
  const state = { pdf: null as MediaObjectInstance<PdfPresentationState> | null };
  const events: Array<{ name: string; args: unknown[] }> = [];
  const action = (name: string) => async function (this: unknown, ...args: unknown[]) {
    assert.equal(this, undefined); events.push({ name, args });
  };
  const context = {
    roomId: "room", selectedDocumentId: "initial",
    documentSelect: new DocumentTestElement(), documentUploadButton: new DocumentTestElement(),
    documentDownloadButton: new DocumentTestElement(), documentSurfaceButton: new DocumentTestElement(),
    documentDeleteButton: new DocumentTestElement(), presentationPrevButton: new DocumentTestElement(),
    presentationNextButton: new DocumentTestElement(), presentationLargeButton: new DocumentTestElement(),
    presentationStopButton: new DocumentTestElement(), documentMediaPlayButton: new DocumentTestElement(),
    documentMediaFitButton: new DocumentTestElement(), documentMediaLoopInput: new DocumentTestElement(),
    documentMediaSeekInput: new DocumentTestElement(), documentMediaStopButton: new DocumentTestElement(),
    renderDocumentsUi() { events.push({ name: "render", args: [context.selectedDocumentId] }); },
    uploadSelectedDocument: action("upload"), downloadSelectedDocument: action("download"),
    selectDocumentForSurface: action("selectSurface"), deleteSelectedDocument: action("delete"),
    goToPresentationPage: action("page"), togglePresentationDisplayMode: action("display"),
    stopCurrentPresentation: action("stopPdf"), toggleDocumentMediaPlayback: action("play"),
    toggleDocumentMediaFit: action("fit"), patchCurrentDocumentMedia: action("patch"),
    stopCurrentDocumentMedia: action("stopMedia"),
    currentPdfPresentationObject() { return state.pdf; },
    documentMediaInputEventId(kind: string) { return `event:${kind}`; }
  } satisfies DocumentControlBindingsContext;
  bindDocumentControls(context);
  return { dom, state, context, events };
}

test("binding is lazy and routes each document/media button exactly once", (t) => {
  const h = harness(t); assert.deepEqual(h.events, []); assert.deepEqual(h.dom.storage.writes, []);
  for (const button of [h.context.documentUploadButton, h.context.documentDownloadButton, h.context.documentSurfaceButton,
    h.context.documentDeleteButton, h.context.presentationLargeButton, h.context.presentationStopButton,
    h.context.documentMediaPlayButton, h.context.documentMediaFitButton, h.context.documentMediaStopButton]) button.click();
  assert.deepEqual(h.events, ["upload", "download", "selectSurface", "delete", "display", "stopPdf", "play", "fit", "stopMedia"]
    .map((name) => ({ name, args: [] })));
});

test("document selection updates the live binding and storage before rendering", (t) => {
  const h = harness(t); h.context.documentSelect.value = "new"; h.context.documentSelect.change();
  assert.equal(h.context.selectedDocumentId, "new");
  h.context.documentSelect.value = ""; h.context.documentSelect.change();
  assert.equal(h.context.selectedDocumentId, "");
  assert.deepEqual(h.dom.storage.writes, [["vrata.documents.selected.room", "new"], ["vrata.documents.selected.room", null]]);
  assert.deepEqual(h.events, [{ name: "render", args: ["new"] }, { name: "render", args: [""] }]);
});

test("previous/next page query current state on every click without moving guards into the UI", (t) => {
  const h = harness(t); h.context.presentationPrevButton.click(); h.context.presentationNextButton.click();
  assert.deepEqual(h.events, []);
  h.state.pdf = makeObject("pdf"); h.context.presentationPrevButton.click();
  h.state.pdf.state.currentPage = 4; h.context.presentationNextButton.click();
  assert.deepEqual(h.events, [{ name: "page", args: [1] }, { name: "page", args: [5] }]);
});

test("loop and seek preserve change-event payloads and numeric coercion", (t) => {
  const h = harness(t); h.context.documentMediaLoopInput.checked = true; h.context.documentMediaLoopInput.change();
  h.context.documentMediaLoopInput.checked = false; h.context.documentMediaLoopInput.change();
  h.context.documentMediaSeekInput.value = "1250.5"; h.context.documentMediaSeekInput.change();
  h.context.documentMediaSeekInput.value = ""; h.context.documentMediaSeekInput.change();
  assert.deepEqual(h.events, [
    { name: "patch", args: [{ type: "set-loop", loop: true, inputEventId: "event:loop" }] },
    { name: "patch", args: [{ type: "set-loop", loop: false, inputEventId: "event:loop" }] },
    { name: "patch", args: [{ type: "seek", positionMs: 1250.5, inputEventId: "event:seek" }] },
    { name: "patch", args: [{ type: "seek", positionMs: 0, inputEventId: "event:seek" }] }
  ]);
});
