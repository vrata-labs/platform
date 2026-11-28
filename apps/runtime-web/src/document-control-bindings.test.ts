import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import type { MediaObjectInstance, PdfPresentationState } from "@vrata/shared-types";
import { bindDocumentControls, type DocumentControlBindingsContext } from "./document-control-bindings.js";
import { DocumentTestElement } from "./testing/document-ui-dom.js";
import { makeObject } from "./testing/document-surface-actions-harness.js";
import { createDocumentSurfaceViewHarness } from "./testing/document-surface-view-harness.js";

function harness(t: TestContext) {
  const { dom, view, state: viewState, context: ui } = createDocumentSurfaceViewHarness(t);
  const state = { pdf: null as MediaObjectInstance<PdfPresentationState> | null };
  const events: Array<{ name: string; args: unknown[] }> = [];
  const action = (name: string) => async function (this: unknown, ...args: unknown[]) {
    assert.equal(this, undefined); events.push({ name, args });
  };
  const context = {
    ...view,
    roomId: "room", selectedDocumentId: "initial",
    documentSelect: new DocumentTestElement(), documentUploadButton: new DocumentTestElement(),
    documentDownloadButton: new DocumentTestElement(), documentSurfaceButton: new DocumentTestElement(),
    documentDeleteButton: new DocumentTestElement(), presentationPrevButton: new DocumentTestElement(),
    documentRefreshButton: new DocumentTestElement(), loadRoomDocuments: action("refresh"),
    presentationNextButton: new DocumentTestElement(), presentationLargeButton: new DocumentTestElement(),
    presentationStopButton: new DocumentTestElement(), documentMediaPlayButton: new DocumentTestElement(),
    documentMediaFitButton: new DocumentTestElement(), documentMediaLoopInput: new DocumentTestElement(),
    documentMediaSeekInput: ui.documentMediaSeekInput, documentMediaStopButton: new DocumentTestElement(),
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
  return { dom, state, context, events, view, viewState, ui };
}

function dispatchPointer(target: EventTarget, type: string, pointer = { pointerId: 1, isPrimary: true }) {
  target.dispatchEvent(Object.assign(new Event(type), { ...pointer, button: 0 }));
}

test("binding is lazy and routes each document/media button exactly once", (t) => {
  const h = harness(t); assert.deepEqual(h.events, []); assert.deepEqual(h.dom.storage.writes, []);
  for (const button of [h.context.documentUploadButton, h.context.documentDownloadButton, h.context.documentSurfaceButton,
    h.context.documentDeleteButton, h.context.documentRefreshButton, h.context.presentationLargeButton, h.context.presentationStopButton,
    h.context.documentMediaPlayButton, h.context.documentMediaFitButton, h.context.documentMediaStopButton]) button.click();
  assert.deepEqual(h.events, ["upload", "download", "selectSurface", "delete", "refresh", "display", "stopPdf", "play", "fit", "stopMedia"]
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
  h.viewState.video = makeObject("video");
  h.context.documentMediaSeekInput.value = "1250.5"; h.context.documentMediaSeekInput.change();
  h.context.documentMediaSeekInput.value = ""; h.context.documentMediaSeekInput.change();
  assert.deepEqual(h.events, [
    { name: "patch", args: [{ type: "set-loop", loop: true, inputEventId: "event:loop" }] },
    { name: "patch", args: [{ type: "set-loop", loop: false, inputEventId: "event:loop" }] },
    { name: "patch", args: [{ type: "seek", positionMs: 1250.5, inputEventId: "event:seek" }] },
    { name: "patch", args: [{ type: "seek", positionMs: 0, inputEventId: "event:seek" }] }
  ]);
});

test("playback renders during a seek drag without moving the thumb before change", (t) => {
  const h = harness(t);
  let nowMs = 10000;
  t.mock.method(Date, "now", () => nowMs);
  const video = makeObject("video");
  Object.assign(video.state, { playbackState: "playing", anchorServerTimeMs: nowMs, positionMs: 1000 });
  h.viewState.video = video;
  h.view.renderDocumentMediaControls();

  const input = h.context.documentMediaSeekInput;
  dispatchPointer(input, "pointerdown");
  input.value = "2500";
  input.dispatchEvent(new Event("input"));
  nowMs += 500;
  h.viewState.video = { ...video, revision: video.revision + 1 };
  h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaTimeEl.textContent, "00:02 / 00:06");
  assert.equal(input.value, "2500");
  assert.deepEqual(h.events, []);

  // Moving focus off the native range can emit change before the pointer is released.
  input.change();
  assert.deepEqual(h.events, []);
  h.view.renderDocumentMediaControls();
  assert.equal(input.value, "2500");

  dispatchPointer(h.dom.window, "pointerup");
  dispatchPointer(input, "lostpointercapture");
  input.change();
  input.change();
  for (const timer of h.dom.timers) timer.callback();
  assert.deepEqual(h.events, [
    { name: "patch", args: [{ type: "seek", positionMs: 2500, inputEventId: "event:seek" }] }
  ]);
});

test("releasing a changed range commits even when the browser already emitted change", (t) => {
  const h = harness(t);
  h.viewState.video = makeObject("video");
  h.view.renderDocumentMediaControls();
  const input = h.context.documentMediaSeekInput;
  dispatchPointer(input, "pointerdown");
  input.value = "2500";
  input.change();
  assert.deepEqual(h.events, []);

  dispatchPointer(h.dom.window, "pointerup");
  for (const timer of h.dom.timers) timer.callback();
  assert.deepEqual(h.events, [
    { name: "patch", args: [{ type: "seek", positionMs: 2500, inputEventId: "event:seek" }] }
  ]);
});

test("a touch can drag the range while another finger is down elsewhere", (t) => {
  const h = harness(t);
  h.viewState.video = makeObject("video");
  h.view.renderDocumentMediaControls();
  const input = h.context.documentMediaSeekInput;
  const touch = { pointerId: 2, isPrimary: false };
  dispatchPointer(input, "pointerdown", touch);
  input.value = "2500";

  dispatchPointer(h.dom.window, "pointerup");
  h.view.renderDocumentMediaControls();
  assert.equal(input.value, "2500");
  assert.deepEqual(h.events, []);

  dispatchPointer(h.dom.window, "pointerup", touch);
  dispatchPointer(input, "lostpointercapture", touch);
  input.change();
  for (const timer of h.dom.timers) timer.callback();
  assert.deepEqual(h.events, [
    { name: "patch", args: [{ type: "seek", positionMs: 2500, inputEventId: "event:seek" }] }
  ]);
});

for (const end of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
  test(`${end} without a committed seek resumes displaying the shared video position`, (t) => {
    const h = harness(t);
    const video = makeObject("video");
    h.viewState.video = video;
    h.view.renderDocumentMediaControls();
    const input = h.context.documentMediaSeekInput;
    dispatchPointer(input, "pointerdown");
    if (end !== "pointerup") input.value = "2500";
    dispatchPointer(end === "lostpointercapture" ? input : h.dom.window, end);
    input.change();
    h.dom.timers.shift()!.callback();
    video.state.positionMs = 4000;
    h.view.renderDocumentMediaControls();
    assert.equal(input.value, "4000");
    assert.deepEqual(h.events, []);

    input.value = "4001";
    input.change(); // Keyboard changes do not start a pointer gesture.
    assert.deepEqual(h.events, [
      { name: "patch", args: [{ type: "seek", positionMs: 4001, inputEventId: "event:seek" }] }
    ]);
  });
}

for (const interruption of ["permissions", "object", "document", "inactive"] as const) {
  test(`a seek drag is invalidated by a change in ${interruption}`, (t) => {
    const h = harness(t);
    const video = makeObject("video");
    h.viewState.video = video;
    h.view.renderDocumentMediaControls();
    const input = h.context.documentMediaSeekInput;
    dispatchPointer(input, "pointerdown");
    input.value = "2500";

    if (interruption === "permissions") h.viewState.canPresent = false;
    if (interruption === "object") h.viewState.video = { ...video, objectId: "other-video" };
    if (interruption === "document") h.viewState.video = makeObject("video", "other-document");
    if (interruption === "inactive") h.viewState.video = null;
    h.view.renderDocumentMediaControls();
    if (interruption === "inactive") {
      assert.equal(h.ui.documentMediaControlsEl.hidden, true);
      h.viewState.video = video;
    }
    if (interruption === "permissions") {
      assert.equal(input.disabled, true);
      h.viewState.canPresent = true;
    }
    h.viewState.video!.state.positionMs = 3500;
    h.view.renderDocumentMediaControls();
    assert.equal(input.value, "3500");

    input.value = "2500";
    dispatchPointer(h.dom.window, "pointerup");
    input.change();
    for (const timer of h.dom.timers) timer.callback();
    assert.deepEqual(h.events, []);
  });
}

test("release outside a disabled range ends the gesture and restores keyboard seeking", (t) => {
  const h = harness(t);
  h.viewState.video = makeObject("video");
  h.view.renderDocumentMediaControls();
  const input = h.context.documentMediaSeekInput;
  dispatchPointer(input, "pointerdown");

  h.viewState.canPresent = false;
  h.view.renderDocumentMediaControls();
  assert.equal(input.disabled, true);
  // The browser can redirect pointerup before the range receives pointer capture.
  dispatchPointer(h.dom.window, "pointerup");
  for (const timer of h.dom.timers) timer.callback();
  assert.deepEqual(h.events, []);

  h.viewState.canPresent = true;
  h.view.renderDocumentMediaControls();
  input.value = "4001";
  input.change();
  assert.deepEqual(h.events, [
    { name: "patch", args: [{ type: "seek", positionMs: 4001, inputEventId: "event:seek" }] }
  ]);
});

for (const releaseDelivered of [true, false]) {
  test(`window blur cancels a seek drag when release is ${releaseDelivered ? "delivered late" : "missed"}`, (t) => {
    const h = harness(t);
    const video = makeObject("video");
    h.viewState.video = video;
    h.view.renderDocumentMediaControls();
    const input = h.context.documentMediaSeekInput;
    dispatchPointer(input, "pointerdown");
    input.value = "2500";
    h.dom.window.dispatchEvent(new Event("blur"));
    video.state.positionMs = 3500;
    h.view.renderDocumentMediaControls();
    assert.equal(input.value, "3500");
    if (releaseDelivered) {
      input.value = "0";
      dispatchPointer(h.dom.window, "pointerup");
      input.change();
      for (const timer of h.dom.timers) timer.callback();
    }
    assert.deepEqual(h.events, []);

    input.dispatchEvent(Object.assign(new Event("keydown"), { key: "ArrowRight" }));
    input.value = "3501";
    input.change();
    assert.deepEqual(h.events, [
      { name: "patch", args: [{ type: "seek", positionMs: 3501, inputEventId: "event:seek" }] }
    ]);
  });
}
