import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentSurfaceActions } from "./document-surface-actions.js";
import { accepted, commandsFor, createHarness, deferred, kinds, makeDocument, makeObject } from "./testing/document-surface-actions-harness.js";
import type { SurfaceCommandResult } from "./room-state-client.js";

test("presentation patches preserve identity, revision, and busy render ordering", async () => {
  const h = createHarness(); h.state.pdf = makeObject("pdf");
  const patch = { type: "go-to-page" as const, page: 4, inputEventId: "event" };
  const result = deferred<SurfaceCommandResult>();
  h.hooks.commands.patchPdfPresentationObject = () => result.promise;
  const pending = h.actions.patchCurrentPresentation(patch);
  assert.equal(h.context.presentationActionInFlight, true);
  assert.deepEqual(h.calls("renderPresentation"), [[true]]);
  assert.equal(h.calls("patchPdfPresentationObject")[0]![3], patch);
  result.resolve(accepted()); await pending;
  assert.deepEqual(h.calls("renderPresentation"), [[true], [false]]);
  assert.deepEqual(h.calls("patchPdfPresentationObject")[0]!.slice(0, 3), ["pdf-object", "object-surface", 12]);
});

for (const guard of ["missing", "permission", "busy"] as const) {
  test(`presentation and media patch/stop guard: ${guard}`, async () => {
    const h = createHarness();
    if (guard !== "missing") { h.state.pdf = makeObject("pdf"); h.state.video = makeObject("video"); }
    if (guard === "permission") h.state.canPresent = false;
    if (guard === "busy") h.context.presentationActionInFlight = true;
    await h.actions.patchCurrentPresentation({ type: "go-to-page", page: 2, inputEventId: "event" });
    await h.actions.patchCurrentDocumentMedia({ type: "play", inputEventId: "event" });
    await h.actions.stopCurrentPresentation(); await h.actions.stopCurrentDocumentMedia();
    assert.equal(h.events.some((e) => /^(patch|stop|link|render)/.test(e.name)), false);
    assert.equal(h.context.presentationActionInFlight, guard === "busy");
  });
}

for (const failure of ["rejected", "thrown"] as const) {
  test(`presentation ${failure} patch updates both diagnostics and status`, async () => {
    const h = createHarness(); h.state.pdf = makeObject("pdf");
    h.hooks.commands.patchPdfPresentationObject = async () => {
      if (failure === "thrown") throw new Error("specific");
      return accepted({ accepted: false });
    };
    await h.actions.patchCurrentPresentation({ type: "go-to-page", page: 2, inputEventId: "event" });
    const code = failure === "thrown" ? "specific" : "presentation_patch_rejected";
    assert.equal(h.context.presentationStatusEl.textContent, `Presentation control failed: ${code}`);
    assert.equal(h.context.debugState.pdfPresentation.errorCode, code);
    assert.deepEqual(h.calls("renderPresentation"), [[true], [false]]);
  });
}

test("presentation page and display-mode controls preserve event identifiers and toggle values", async () => {
  const h = createHarness(); h.state.pdf = makeObject("pdf");
  await h.actions.goToPresentationPage(-4);
  await h.actions.togglePresentationDisplayMode();
  h.state.pdf.state.displayMode = "large";
  await h.actions.togglePresentationDisplayMode();
  assert.deepEqual(h.calls("patchPdfPresentationObject").map((call) => call[3]), [
    { type: "go-to-page", page: -4, inputEventId: "pdf:page" },
    { type: "set-display-mode", displayMode: "large", inputEventId: "pdf:display-mode" },
    { type: "set-display-mode", displayMode: "normal", inputEventId: "pdf:display-mode" }
  ]);
});

for (const kind of ["image", "video"] as const) {
  test(`${kind}: patch uses the existing object and renders before and after await`, async () => {
    const h = createHarness(kind); h.setObject(kind);
    const patch = { type: "set-fit-mode" as const, fitMode: "cover" as const, inputEventId: "fit" };
    await h.actions.patchCurrentDocumentMedia(patch);
    assert.deepEqual(h.calls(commandsFor[kind][1]), [[`${kind}-object`, "object-surface", 12, patch]]);
    assert.equal(h.calls(commandsFor[kind][1])[0]![3], patch);
    assert.deepEqual(h.calls("renderMedia"), [[true], [false]]);
  });
  test(`${kind}: patch rejection sets the media status and resets busy state`, async () => {
    const h = createHarness(kind); h.setObject(kind);
    h.hooks.commands[commandsFor[kind][1]] = async () => accepted({ accepted: false });
    await h.actions.patchCurrentDocumentMedia({ type: "set-fit-mode", fitMode: "cover", inputEventId: "fit" });
    assert.equal(h.context.documentMediaStatusEl.textContent, "Media control failed: document_media_patch_rejected");
    assert.equal(h.context.presentationActionInFlight, false);
    assert.equal(h.context.debugState.pdfPresentation.errorCode, null);
  });
}

test("video retains precedence over image without invoking the image lookup", async () => {
  const h = createHarness(); h.state.video = makeObject("video"); h.state.image = makeObject("image");
  await h.actions.patchCurrentDocumentMedia({ type: "pause", inputEventId: "pause" });
  assert.equal(h.calls("currentImage").length, 0);
  assert.equal(h.calls("patchImageViewerObject").length, 0);
  assert.equal(h.calls("patchVideoPlayerObject").length, 1);
});

test("playback and fit controls preserve toggles and lookup precedence", async () => {
  const h = createHarness(); h.state.video = makeObject("video");
  await h.actions.toggleDocumentMediaPlayback(); h.state.video.state.playbackState = "playing";
  await h.actions.toggleDocumentMediaPlayback(); await h.actions.toggleDocumentMediaFit();
  h.state.video.state.fitMode = "cover"; await h.actions.toggleDocumentMediaFit();
  assert.deepEqual(h.calls("patchVideoPlayerObject").map((call) => call[3]), [
    { type: "play", inputEventId: "media:playback" }, { type: "pause", inputEventId: "media:playback" },
    { type: "set-fit-mode", fitMode: "cover", inputEventId: "media:fit" },
    { type: "set-fit-mode", fitMode: "contain", inputEventId: "media:fit" }
  ]);
  h.state.video = null; h.state.image = makeObject("image");
  await h.actions.toggleDocumentMediaFit();
  assert.equal(h.calls("patchImageViewerObject").length, 1);
});

test("toggle controls with no object do not render or create identifiers", async () => {
  const h = createHarness();
  await h.actions.togglePresentationDisplayMode(); await h.actions.toggleDocumentMediaPlayback(); await h.actions.toggleDocumentMediaFit();
  assert.equal(h.events.some((event) => /^(render|mediaId|presentationId|patch)/.test(event.name)), false);
});

for (const kind of kinds) {
  test(`${kind}: stopping awaits command, unlinks document, and updates the current list`, async () => {
    const h = createHarness(kind); h.setObject(kind);
    const result = deferred<SurfaceCommandResult>(); h.hooks.commands[commandsFor[kind][2]] = () => result.promise;
    const pending = kind === "pdf" ? h.actions.stopCurrentPresentation() : h.actions.stopCurrentDocumentMedia();
    assert.equal(h.context.presentationActionInFlight, true); assert.deepEqual(h.calls("link"), []);
    h.context.roomStateAccessToken = "token-2"; const untouched = makeDocument(kind, "untouched");
    h.context.roomDocuments = [{ ...makeDocument(kind, "previous"), linkedSurfaceId: "surface" }, untouched];
    result.resolve(accepted()); await pending;
    assert.deepEqual(h.calls(commandsFor[kind][2]), [[`${kind}-object`, "object-surface"]]);
    assert.deepEqual(h.calls("link"), [["https://example.invalid", "room", "previous", null, "token-2"]]);
    assert.equal(h.context.roomDocuments[0]!.linkedSurfaceId, null); assert.equal(h.context.roomDocuments[1], untouched);
    assert.equal(h.context.presentationActionInFlight, false);
    assert.deepEqual(h.calls("renderDocuments"), [[kind === "pdf" ? "Presentation stopped" : "Media stopped", false]]);
  });
  test(`${kind}: stopping an object without a document does not update metadata`, async () => {
    const h = createHarness(kind); h.setObject(kind, null);
    await (kind === "pdf" ? h.actions.stopCurrentPresentation() : h.actions.stopCurrentDocumentMedia());
    assert.deepEqual(h.calls("link"), []); assert.equal(h.calls(commandsFor[kind][2]).length, 1);
  });
  test(`${kind}: rejected stop leaves metadata untouched and reports the original fallback`, async () => {
    const h = createHarness(kind); h.setObject(kind);
    h.hooks.commands[commandsFor[kind][2]] = async () => accepted({ accepted: false });
    await (kind === "pdf" ? h.actions.stopCurrentPresentation() : h.actions.stopCurrentDocumentMedia());
    assert.deepEqual(h.calls("link"), []);
    assert.equal(h.context.documentStatusEl.textContent, kind === "pdf"
      ? "Presentation stop failed: presentation_stop_rejected" : "Media stop failed: document_media_stop_rejected");
    assert.equal(h.context.presentationActionInFlight, false);
  });
}

test("a synchronous pre-try rendering exception retains the original busy flag", async () => {
  const h = createHarness(); h.state.pdf = makeObject("pdf"); const failure = new Error("render");
  h.context.renderPresentationControls = () => { throw failure; };
  const actions = createDocumentSurfaceActions(h.context);
  await assert.rejects(actions.patchCurrentPresentation({ type: "go-to-page", page: 1, inputEventId: "id" }), (e: unknown) => e === failure);
  assert.equal(h.context.presentationActionInFlight, true);
});

test("captured callbacks retain their references while referenced objects remain live", async () => {
  const h = createHarness(); h.state.pdf = makeObject("pdf");
  h.context.canPresentDocuments = () => false;
  h.context.selectedDocument = () => null;
  await h.actions.goToPresentationPage(3);
  assert.equal(h.calls("patchPdfPresentationObject").length, 1);
});

for (const kind of kinds) {
  test(`${kind}: failed unlink after stopping reports failure and preserves the list`, async () => {
    const h = createHarness(kind); h.setObject(kind); const before = h.context.roomDocuments;
    h.hooks.link = async () => { throw new Error("unlink_denied"); };
    await (kind === "pdf" ? h.actions.stopCurrentPresentation() : h.actions.stopCurrentDocumentMedia());
    assert.equal(h.context.roomDocuments, before);
    assert.equal(h.context.documentStatusEl.textContent, `${kind === "pdf" ? "Presentation" : "Media"} stop failed: unlink_denied`);
    assert.equal(h.context.presentationActionInFlight, false);
  });
}
