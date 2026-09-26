import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentSurfaceActions } from "./document-surface-actions.js";
import { accepted, commandsFor, createHarness, deferred, kinds, makeDocument, makeObject } from "./testing/document-surface-actions-harness.js";
import type { RuntimeDocumentRecord } from "./index.js";
import type { SurfaceCommandResult } from "./room-state-client.js";

test("document actions construction does not read live bindings or perform operations", () => {
  const h = createHarness();
  for (const name of ["roomDocuments", "selectedMediaSurfaceId", "roomStateAccessToken", "presentationActionInFlight"]) {
    Object.defineProperty(h.context, name, { get() { throw new Error(`early read: ${name}`); } });
  }
  const actions = createDocumentSurfaceActions(h.context);
  assert.equal(Object.keys(actions).length, 9);
  assert.deepEqual(h.events, []);
});

test("selection without a document does not check permissions or update the UI", async () => {
  const h = createHarness(); h.state.selected = null;
  await h.actions.selectDocumentForSurface();
  assert.deepEqual(h.events.map((event) => event.name), ["selectedDocument"]);
});

for (const reason of ["permission", "missing-kind", "unsupported-kind"] as const) {
  test(`selection guard preserves ${reason} rejection`, async () => {
    const h = createHarness();
    if (reason === "permission") h.state.canPresent = false;
    else h.state.selected!.metadata = reason === "missing-kind" ? {} : { kind: "text" as "pdf" };
    await h.actions.selectDocumentForSurface();
    assert.deepEqual(h.calls("status"), [["Presentable document and presenter role required", "document_not_presentable"]]);
    assert.equal(h.context.presentationActionInFlight, false);
    assert.deepEqual(h.calls("link"), []);
  });
}

for (const kind of kinds) {
  const [create, patch, stop] = commandsFor[kind];
  test(`${kind}: creates and selects with exact patch fields and call order`, async () => {
    const h = createHarness(kind);
    const other = { ...makeDocument(kind, "other"), linkedSurfaceId: "other-surface" };
    h.context.roomDocuments.push({ ...makeDocument(kind, "previous"), linkedSurfaceId: "selected-surface" }, other);
    await h.actions.selectDocumentForSurface();
    const expected = { documentId: "selected", filename: `selected.${kind}`, checksum: "checksum-selected" };
    const expectedPatch = kind === "pdf"
      ? { type: "select-document", ...expected, pageCount: 7, inputEventId: "pdf:select-document" }
      : kind === "image"
        ? { type: "select-image", ...expected, contentType: "image/png", widthPx: 640, heightPx: 480, inputEventId: "media:select-image" }
        : { type: "select-video", ...expected, contentType: "video/mp4", widthPx: 640, heightPx: 480, durationMs: 9000, inputEventId: "media:select-video" };
    assert.deepEqual(h.calls(create), [["selected-surface"]]);
    assert.deepEqual(h.calls(patch), [["created", "selected-surface", 3, expectedPatch]]);
    assert.deepEqual(h.events.filter((e) => [create, patch, "link"].includes(e.name)).map((e) => e.name), [create, "link", patch]);
    assert.equal(h.context.roomDocuments[0]!.linkedSurfaceId, "selected-surface");
    assert.equal(h.context.roomDocuments[1]!.linkedSurfaceId, null);
    assert.equal(h.context.roomDocuments[2], other);
    assert.deepEqual(h.calls(stop), []);
    assert.deepEqual(h.calls("renderDocuments"), [[`Document selected for surface: selected.${kind}`, true], ["Selecting document for surface...", false]]);
  });

  test(`${kind}: reuses the existing object and its surface/revision`, async () => {
    const h = createHarness(kind); h.setObject(kind);
    h.state.occupied = h.state[kind];
    await h.actions.selectDocumentForSurface();
    assert.deepEqual(h.calls(create), []);
    assert.deepEqual(h.calls(patch)[0]!.slice(0, 3), [`${kind}-object`, "object-surface", 12]);
    assert.equal(h.calls("link")[0]![3], "selected-surface");
  });

  test(`${kind}: patch rejection stops a newly created object and unlinks metadata`, async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const h = createHarness(kind);
    h.hooks.commands[patch] = async () => accepted({ accepted: false, blockedReason: "patch:denied" });
    await h.actions.selectDocumentForSurface();
    assert.deepEqual(h.calls(stop), [["created", "selected-surface"]]);
    assert.deepEqual(h.calls("link").map((args) => [args[2], args[3]]), [["selected", "selected-surface"], ["selected", null]]);
    assert.equal(h.context.roomDocuments[0]!.linkedSurfaceId, null);
    assert.equal(h.context.presentationActionInFlight, false);
    assert.deepEqual(h.calls("status").at(-1), ["Document surface selection failed: patch:denied", "patch:denied"]);
  });

  test(`${kind}: failed metadata linking stops creation without unlinking`, async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const h = createHarness(kind); const before = h.context.roomDocuments;
    h.hooks.link = async () => { throw new Error("link_failed"); };
    await h.actions.selectDocumentForSurface();
    assert.deepEqual(h.calls(stop), [["created", "selected-surface"]]);
    assert.equal(h.calls("link").length, 1);
    assert.deepEqual(h.calls(patch), []);
    assert.equal(h.context.roomDocuments, before);
  });

  test(`${kind}: failed replacement restores the previous document without stopping the reused object`, async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const h = createHarness(kind); h.setObject(kind);
    h.context.roomDocuments.push({ ...makeDocument(kind, "previous"), linkedSurfaceId: "selected-surface" });
    h.hooks.commands[patch] = async () => { throw new Error("patch_failed"); };
    await h.actions.selectDocumentForSurface();
    assert.deepEqual(h.calls(stop), []);
    assert.deepEqual(h.calls("link").map((a) => [a[2], a[3]]), [["selected", "selected-surface"], ["selected", null], ["previous", "selected-surface"]]);
    assert.equal(h.context.roomDocuments[1]!.linkedSurfaceId, "selected-surface");
  });
}

test("an occupied surface rejects selection before creation or metadata changes", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const h = createHarness(); h.state.occupied = makeObject("image");
  await h.actions.selectDocumentForSurface();
  assert.deepEqual(h.calls("link"), []);
  assert.deepEqual(h.calls("createPdfPresentationObjectOnSurface"), []);
  assert.equal(h.context.documentStatusEl.textContent, "Document surface selection failed: surface-occupied");
});

for (const response of [accepted({ accepted: false }), accepted({ objectId: "" }), accepted({ accepted: false, blockedReason: "create_denied" })]) {
  test(`selection handles rejected/missing creation: ${JSON.stringify(response)}`, async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const h = createHarness(); h.hooks.commands.createPdfPresentationObjectOnSurface = async () => response;
    await h.actions.selectDocumentForSurface();
    assert.equal(h.calls("link").length, 0);
    assert.equal(h.calls("stopPdfPresentationObject").length, 0);
    assert.equal(h.context.documentStatusEl.textContent, `Document surface selection failed: ${response.blockedReason ?? "document_media_create_rejected"}`);
  });
}

test("selection continues observing surface/token/documents after each await", async () => {
  const h = createHarness(); const create = deferred<SurfaceCommandResult>(); const link = deferred<RuntimeDocumentRecord>();
  h.hooks.commands.createPdfPresentationObjectOnSurface = () => create.promise;
  h.hooks.link = () => link.promise;
  const pending = h.actions.selectDocumentForSurface();
  assert.equal(h.context.presentationActionInFlight, true);
  h.context.selectedMediaSurfaceId = "after-create"; h.context.roomStateAccessToken = "token-2";
  create.resolve(accepted({ objectId: "new", revision: null }));
  await Promise.resolve();
  assert.deepEqual(h.calls("link"), [["https://example.invalid", "room", "selected", "after-create", "token-2"]]);
  const replacement = { ...makeDocument("pdf", "replacement"), linkedSurfaceId: "after-link" };
  h.context.roomDocuments = [makeDocument("pdf"), replacement]; h.context.selectedMediaSurfaceId = "after-link";
  link.resolve({ ...makeDocument("pdf"), metadata: {}, linkedSurfaceId: "after-create" });
  await pending;
  assert.deepEqual(h.calls("patchPdfPresentationObject")[0]!.slice(0, 3), ["new", "after-create", 0]);
  assert.equal((h.calls("patchPdfPresentationObject")[0]![3] as { pageCount: number }).pageCount, 7);
  assert.equal(h.context.roomDocuments[1]!.linkedSurfaceId, null);
});

test("rollback suppresses asynchronous cleanup failures but retains the original error", async (t) => {
  const warnings: unknown[][] = []; t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const h = createHarness(); const original = new Error("original:failure:detail:extra");
  h.hooks.commands.patchPdfPresentationObject = async () => { throw original; };
  h.hooks.commands.stopPdfPresentationObject = async () => { throw new Error("stop_failed"); };
  h.hooks.link = async (id, surface) => { if (surface === null) throw new Error("unlink_failed"); return makeDocument("pdf", id); };
  await h.actions.selectDocumentForSurface();
  assert.equal(warnings[0]![1], original);
  assert.equal(h.context.documentStatusEl.textContent, "Document surface selection failed: original:failure:detail");
  assert.equal(h.context.presentationActionInFlight, false);
});

test("synchronous cleanup exceptions still escape through finally", async () => {
  const h = createHarness(); const failure = new Error("sync_cleanup");
  h.hooks.commands.patchPdfPresentationObject = async () => { throw new Error("patch"); };
  h.hooks.commands.stopPdfPresentationObject = () => { throw failure; };
  await assert.rejects(h.actions.selectDocumentForSurface(), (error: unknown) => error === failure);
  assert.equal(h.context.presentationActionInFlight, false);
  assert.equal(h.calls("renderDocuments").length, 1);
});

for (const kind of kinds) {
  test(`${kind}: missing metadata retains zero/default patch values`, async () => {
    const h = createHarness(kind); h.state.selected!.metadata = { kind };
    h.hooks.link = async () => ({ ...makeDocument(kind), metadata: { kind } });
    await h.actions.selectDocumentForSurface();
    const patch = h.calls(commandsFor[kind][1])[0]![3] as Record<string, unknown>;
    if (kind === "pdf") assert.equal(patch.pageCount, 0);
    else { assert.equal(patch.widthPx, 0); assert.equal(patch.heightPx, 0); }
    if (kind === "video") assert.equal(patch.durationMs, 0);
  });
}

for (const previous of [null, "", "selected"]) {
  test(`rollback does not restore an absent or identical previous document: ${String(previous)}`, async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const h = createHarness(); h.setObject("pdf", previous);
    h.hooks.commands.patchPdfPresentationObject = async () => accepted({ accepted: false });
    await h.actions.selectDocumentForSurface();
    assert.equal(h.calls("link").length, 2);
    assert.equal(h.context.documentStatusEl.textContent, "Document surface selection failed: presentation_select_rejected");
  });
}

test("failed restoration leaves the latest list intact and reports the selection failure", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const h = createHarness(); h.setObject("pdf");
  h.context.roomDocuments.push({ ...makeDocument("pdf", "previous"), linkedSurfaceId: "selected-surface" });
  h.hooks.commands.patchPdfPresentationObject = async () => { throw new Error("patch_failed"); };
  h.hooks.link = async (id, surface) => {
    if (id === "previous") throw new Error("restore_failed");
    return { ...makeDocument("pdf", id), linkedSurfaceId: surface };
  };
  await h.actions.selectDocumentForSurface();
  assert.equal(h.calls("link").length, 3);
  assert.equal(h.context.roomDocuments[1]!.linkedSurfaceId, null);
  assert.equal(h.context.documentStatusEl.textContent, "Document surface selection failed: patch_failed");
});

test("selection deliberately retains the pre-existing absence of a busy guard", async () => {
  const h = createHarness(); h.context.presentationActionInFlight = true;
  await h.actions.selectDocumentForSurface();
  assert.equal(h.calls("createPdfPresentationObjectOnSurface").length, 1);
  assert.equal(h.context.presentationActionInFlight, false);
});
