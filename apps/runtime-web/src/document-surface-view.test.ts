import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentSurfaceViewHarness } from "./testing/document-surface-view-harness.js";
import { makeObject } from "./testing/document-surface-actions-harness.js";

test("document views are lazy and preserve input event ID formats", (t) => {
  const h = createDocumentSurfaceViewHarness(t);
  assert.deepEqual(h.events, []); assert.deepEqual(h.dom.created, []);
  t.mock.method(Date, "now", () => 1234); t.mock.method(Math, "random", () => 0.5);
  assert.equal(h.view.presentationInputEventId("next"), "participant:pdf-presentation:next:1234:8");
  assert.equal(h.view.documentMediaInputEventId("seek"), "participant:document-media:seek:1234:8");
});

test("inactive views reset PDF diagnostics using the current surface without loading a runtime", (t) => {
  const h = createDocumentSurfaceViewHarness(t); h.context.selectedMediaSurfaceId = "latest";
  h.view.renderPresentationControls(); h.view.renderDocumentMediaControls();
  assert.equal(h.context.presentationControlsEl.hidden, true); assert.equal(h.context.documentMediaControlsEl.hidden, true);
  assert.equal(h.context.presentationStatusEl.textContent, "Presentation idle");
  assert.equal(h.context.documentMediaStatusEl.textContent, "Media idle");
  assert.deepEqual(h.calls("runtime"), []);
  assert.deepEqual(h.context.debugState.pdfPresentation, {
    surfaceId: "latest", objectId: null, documentId: null, page: 1, pageCount: 0,
    displayMode: "normal", loadState: "idle", renderState: "idle", lastRenderMs: null,
    renderedThumbnailCount: 0, errorCode: null, errorDetail: null
  });
});

test("video UI retains precedence, live clock offset, looping and duration clamping", (t) => {
  const h = createDocumentSurfaceViewHarness(t); t.mock.method(Date, "now", () => 10000);
  h.state.image = makeObject("image"); h.state.video = makeObject("video");
  const video = h.state.video.state;
  Object.assign(video, { playbackState: "playing", positionMs: 1500, anchorServerTimeMs: 9000 });
  h.context.roomStateServerOffsetMs = 500;
  h.view.renderDocumentMediaControls();
  assert.deepEqual(h.events.slice(0, 2).map((event) => event.name), ["image", "video"]);
  assert.equal(h.context.documentMediaTitleEl.textContent, "Video: previous");
  assert.equal(h.context.documentMediaPlayButton.textContent, "Pause");
  assert.equal(h.context.documentMediaSeekInput.value, "3000");
  assert.equal(h.context.documentMediaSeekInput.max, "6000");
  assert.equal(h.context.documentMediaTimeEl.textContent, "00:03 / 00:06");
  h.context.roomStateServerOffsetMs = 10000;
  h.view.renderDocumentMediaControls(); assert.equal(h.context.documentMediaSeekInput.value, "6000");
  video.loop = true;
  h.view.renderDocumentMediaControls(); assert.equal(h.context.documentMediaSeekInput.value, "500");
  assert.equal(h.context.documentMediaTimeEl.textContent, "00:01 / 00:06");
  video.anchorServerTimeMs = 30000;
  h.view.renderDocumentMediaControls(); assert.equal(h.context.documentMediaSeekInput.value, "1500");
  video.playbackState = "paused"; video.anchorServerTimeMs = 0;
  h.view.renderDocumentMediaControls(); assert.equal(h.context.documentMediaSeekInput.value, "1500");
  assert.equal(h.context.documentMediaPlayButton.textContent, "Play");
  video.durationMs = 0;
  h.view.renderDocumentMediaControls(); assert.equal(h.context.documentMediaSeekInput.value, "0");
});

test("image UI and presenter/busy state remain live", (t) => {
  const h = createDocumentSurfaceViewHarness(t); h.state.image = makeObject("image");
  h.view.renderDocumentMediaControls();
  assert.equal(h.context.documentMediaControlsEl.hidden, false);
  assert.equal(h.context.documentMediaTitleEl.textContent, "Image: previous");
  assert.equal(h.context.documentMediaFitButton.textContent, "Cover");
  assert.equal(h.context.documentMediaFitButton.disabled, false);
  for (const element of [h.context.documentMediaPlayButton, h.context.documentMediaLoopLabel,
    h.context.documentMediaSeekInput, h.context.documentMediaTimeEl]) assert.equal(element.hidden, true);
  h.state.image.state.fitMode = "cover"; h.context.presentationActionInFlight = true;
  h.view.renderDocumentMediaControls(); assert.equal(h.context.documentMediaFitButton.textContent, "Contain");
  assert.equal(h.context.documentMediaFitButton.disabled, true);
  h.context.presentationActionInFlight = false; h.state.canPresent = false;
  h.view.renderDocumentMediaControls(); assert.equal(h.context.documentMediaStopButton.disabled, true);
  h.state.image.state.documentId = null;
  h.view.renderDocumentMediaControls(); assert.equal(h.context.documentMediaControlsEl.hidden, true);
});

test("PDF thumbnails cap at 50, reuse their signature, track permissions and route their own page", (t) => {
  const h = createDocumentSurfaceViewHarness(t); h.state.pdf = makeObject("pdf");
  h.state.pdf.state.pageCount = 55;
  h.view.renderPresentationControls();
  const buttons = h.context.presentationThumbnailsEl.elements();
  assert.equal(buttons.length, 50); assert.equal(h.calls("thumbnail").length, 50);
  assert.deepEqual(h.calls("thumbnail").map(([page]) => page), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(buttons[1]!.getAttribute("aria-current"), "page");
  assert.equal(buttons[0]!.getAttribute("aria-label"), "Show page 1");
  assert.equal(buttons[0]!.elements()[0]!.width, 64); assert.equal(buttons[0]!.elements()[0]!.height, 48);
  buttons[2]!.click(); assert.deepEqual(h.calls("page"), [[3]]);
  h.state.pdf.state.currentPage = 3; h.context.presentationActionInFlight = true;
  h.view.renderPresentationControls();
  assert.equal(h.context.presentationThumbnailsEl.elements()[0], buttons[0]);
  assert.equal(h.calls("thumbnail").length, 50); assert.equal(buttons[1]!.getAttribute("aria-current"), null);
  assert.equal(buttons[2]!.getAttribute("aria-current"), "page");
  assert.ok(buttons.every((button) => button.disabled));
  h.context.presentationActionInFlight = false; h.state.canPresent = false;
  h.view.renderPresentationControls(); assert.ok(buttons.every((button) => button.disabled));
  h.state.canPresent = true; h.state.pdf.state.documentId = "next"; h.state.pdf.state.pageCount = 2;
  h.view.renderPresentationControls();
  assert.equal(h.context.presentationThumbnailsEl.elements().length, 2);
  assert.notEqual(h.context.presentationThumbnailsEl.elements()[0], buttons[0]);
  assert.equal(h.calls("thumbnail").length, 52);
});

test("PDF navigation boundaries, display labels, idle reset and status update timing are preserved", (t) => {
  const h = createDocumentSurfaceViewHarness(t); h.state.pdf = makeObject("pdf");
  h.state.pdf.state.currentPage = 1; h.view.renderPresentationControls();
  assert.equal(h.context.presentationPrevButton.disabled, true); assert.equal(h.context.presentationNextButton.disabled, false);
  assert.equal(h.context.presentationPageLabel.textContent, "Page 1 / 4");
  assert.equal(h.context.presentationLargeButton.textContent, "Large mode");
  assert.equal(h.context.presentationLargeButton.getAttribute("aria-pressed"), "false");
  assert.equal(h.context.presentationStatusEl.textContent, "Presenting previous, page 1 of 4");
  assert.equal(h.context.debugState.pdfPresentation, h.state.snapshot);
  h.state.pdf.state.currentPage = 4; h.state.pdf.state.displayMode = "large";
  h.state.snapshot.renderState = "idle"; h.view.renderPresentationControls();
  assert.equal(h.context.presentationPrevButton.disabled, false); assert.equal(h.context.presentationNextButton.disabled, true);
  assert.equal(h.context.presentationLargeButton.textContent, "Normal mode");
  assert.equal(h.context.presentationLargeButton.getAttribute("aria-pressed"), "true");
  assert.equal(h.context.presentationStatusEl.textContent, "Presenting previous, page 1 of 4");
  const object = h.state.pdf; h.state.pdf = null; h.view.renderPresentationControls();
  assert.equal(h.context.presentationThumbnailsEl.elements().length, 0);
  h.state.pdf = object; h.view.renderPresentationControls(); assert.equal(h.calls("thumbnail").length, 8);
});
