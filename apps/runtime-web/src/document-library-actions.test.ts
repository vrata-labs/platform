import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentLibraryActions, type DocumentLibraryContext } from "./document-library-actions.js";
import { createDocumentFeedback, DocumentUploadError, documentUploadFailure } from "./document-feedback.js";
import { deferred, makeDocument } from "./testing/document-surface-actions-harness.js";
import { uploadRoomDocument } from "./index.js";

function harness(timeoutMs = 60_000) {
  const feedback = createDocumentFeedback();
  let allowed = true;
  let fileCleared = false;
  const context: DocumentLibraryContext = {
    apiBaseUrl: "https://room.test", roomId: "room", roomStateAccessToken: "test-session",
    roomDocuments: [], selectedDocumentId: "", documentsLoading: false, documentUploadInFlight: false,
    canViewDocuments: () => allowed, canUploadDocuments: () => allowed,
    selectedFile: () => new File(["%PDF"], "slides.pdf", { type: "application/pdf" }),
    clearFile: () => { fileCleared = true; },
    setDocumentStatus: (message, code) => feedback.set(message, code), renderDocumentsUi: () => {},
    listRoomDocuments: async () => [], uploadRoomDocument: async () => makeDocument("pdf", "new"),
    probeDocumentMedia: async () => null
  };
  const status = () => feedback.read({ visible: allowed, enabled: true, uploading: context.documentUploadInFlight,
    loading: context.documentsLoading, count: context.roomDocuments.length });
  return { context, feedback, status, actions: createDocumentLibraryActions(context, timeoutMs),
    revoke: () => { allowed = false; }, fileCleared: () => fileCleared };
}

test("upload failure survives permission polling and finally renders without losing its code", async () => {
  const h = harness();
  h.context.uploadRoomDocument = async () => { throw new DocumentUploadError(400, "unsupported_document_mime"); };
  await h.actions.uploadSelectedDocument();
  for (let i = 0; i < 5; i++) {
    h.context.renderDocumentsUi();
    h.feedback.keepOrSet(h.status().message);
    assert.match(h.status().message, /Unsupported file format/);
    assert.equal(h.status().errorCode, "unsupported_document_mime");
  }
  assert.equal(h.context.documentUploadInFlight, false);
  assert.equal(h.fileCleared(), false);
  h.context.uploadRoomDocument = async () => makeDocument("pdf", "new");
  await h.actions.uploadSelectedDocument();
  assert.deepEqual(h.status(), { message: "Document uploaded: new.pdf", errorCode: null });
  assert.equal(h.context.selectedDocumentId, "new");
  assert.equal(h.fileCleared(), true);
});

test("progress is derived, and a stale list cannot erase the completed upload or selection", async () => {
  const h = harness();
  const list = deferred<ReturnType<typeof makeDocument>[]>();
  const upload = deferred<ReturnType<typeof makeDocument>>();
  h.context.listRoomDocuments = () => list.promise;
  h.context.uploadRoomDocument = () => upload.promise;
  const loading = h.actions.loadRoomDocuments();
  assert.equal(h.status().message, "Documents loading...");
  h.feedback.keepOrSet(h.status().message);
  const uploading = h.actions.uploadSelectedDocument();
  assert.equal(h.status().message, "Uploading document...");
  h.feedback.keepOrSet(h.status().message);
  upload.resolve(makeDocument("pdf", "new"));
  await uploading;
  list.resolve([]);
  await loading;
  assert.equal(h.context.roomDocuments[0]?.documentId, "new");
  assert.equal(h.context.selectedDocumentId, "new");
  assert.deepEqual(h.status(), { message: "Document uploaded: new.pdf", errorCode: null });
  assert.equal(h.context.documentsLoading, false);
});

test("surface finally cannot retain a computed progress message after loading finishes", () => {
  const h = harness();
  h.context.documentsLoading = true;
  h.feedback.keepOrSet(h.status().message);
  h.context.documentsLoading = false;
  assert.equal(h.status().message, "No room documents yet");
});

test("a hanging upload is aborted, releases busy state, and ignores its eventual success", async () => {
  const h = harness(10);
  const response = deferred<ReturnType<typeof makeDocument>>();
  let signal: AbortSignal | undefined;
  h.context.uploadRoomDocument = async (_base, _room, _token, _file, _metadata, inputSignal) => {
    signal = inputSignal;
    return response.promise;
  };
  await h.actions.uploadSelectedDocument();
  assert.equal(signal?.aborted, true);
  assert.equal(h.context.documentUploadInFlight, false);
  assert.equal(h.status().errorCode, "document_upload_timeout");
  response.resolve(makeDocument("pdf", "late"));
  await Promise.resolve();
  assert.deepEqual(h.context.roomDocuments, []);
  assert.equal(h.status().errorCode, "document_upload_timeout");
});

test("invalidation ignores old upload success and finally while a new attempt is pending", async () => {
  const h = harness();
  const old = deferred<ReturnType<typeof makeDocument>>();
  const next = deferred<ReturnType<typeof makeDocument>>();
  h.context.uploadRoomDocument = () => old.promise;
  const first = h.actions.uploadSelectedDocument();
  await Promise.resolve();
  h.actions.invalidate();
  h.context.uploadRoomDocument = () => next.promise;
  const second = h.actions.uploadSelectedDocument();
  old.resolve(makeDocument("pdf", "old"));
  await first;
  assert.equal(h.context.documentUploadInFlight, true);
  assert.deepEqual(h.context.roomDocuments, []);
  next.resolve(makeDocument("pdf", "new"));
  await second;
  assert.equal(h.context.selectedDocumentId, "new");
});

test("permission loss while probing prevents the request and stale list results cannot publish after invalidation", async () => {
  const h = harness();
  const probe = deferred<null>();
  const list = deferred<ReturnType<typeof makeDocument>[]>();
  let requests = 0;
  h.context.probeDocumentMedia = () => probe.promise;
  h.context.listRoomDocuments = () => list.promise;
  h.context.uploadRoomDocument = async () => { requests++; return makeDocument("pdf"); };
  const loading = h.actions.loadRoomDocuments();
  const upload = h.actions.uploadSelectedDocument();
  h.revoke();
  h.actions.invalidate();
  probe.resolve(null);
  list.resolve([makeDocument("pdf")]);
  await Promise.all([loading, upload]);
  assert.equal(requests, 0);
  assert.equal(h.context.documentsLoading, false);
  assert.equal(h.context.documentUploadInFlight, false);
  assert.deepEqual(h.context.roomDocuments, []);
  assert.equal(h.status().message, "Documents permission required");
});

test("retrying a failed list clears unavailable without leaving a loading notification", async () => {
  const h = harness();
  h.context.listRoomDocuments = async () => { throw new Error("private storage detail"); };
  await h.actions.loadRoomDocuments();
  assert.equal(h.status().errorCode, "documents_unavailable");
  h.context.listRoomDocuments = async () => [];
  await h.actions.loadRoomDocuments();
  assert.deepEqual(h.status(), { message: "No room documents yet", errorCode: null });
});

test("upload API strips arbitrary server text and preserves abort and typed status codes", async t => {
  const controller = new AbortController();
  const file = new File(["%PDF"], "slides.pdf");
  for (const [status, code, expected] of [[400, "storage path and credential", "document_upload_failed"],
    [400, "__proto__", "document_upload_failed"], [413, "request body too large", "document_too_large"],
    [403, "secret reason", "document_permission_denied"], [503, "storage credential", "document_storage_unavailable"],
    [422, "corrupt_pdf", "corrupt_pdf"], [422, "invalid_image_signature", "invalid_image_signature"],
    [422, "invalid_video_container", "invalid_video_container"], [422, "video_metadata_missing", "video_metadata_missing"],
    [422, "invalid_media_dimensions", "invalid_media_dimensions"]] as const) {
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      assert.equal(init?.signal, controller.signal);
      return new Response(JSON.stringify({ error: code }), { status });
    });
    await assert.rejects(uploadRoomDocument("https://room.test", "room", "test-session", file, undefined, controller.signal), error => {
      assert.ok(error instanceof DocumentUploadError);
      assert.equal(error.message, expected);
      assert.equal(documentUploadFailure(error).errorCode, expected);
      assert.ok(!documentUploadFailure(error).message.includes("credential"));
      return true;
    });
    t.mock.restoreAll();
  }
});
