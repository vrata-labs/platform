import test from "node:test";
import assert from "node:assert/strict";
import { DOCUMENT_UPLOAD_FORMATS, parseDocumentUploadPolicy, resolveDocumentContentType } from "./document-upload-policy.js";

test("document MIME resolution preserves extension fallback, canonical headers and mismatches", () => {
  for (const format of DOCUMENT_UPLOAD_FORMATS) {
    for (const extension of format.extensions) {
      assert.equal(resolveDocumentContentType("", `meeting${extension.toUpperCase()}`), format.contentType);
      assert.equal(resolveDocumentContentType("application/octet-stream", `meeting${extension}`), format.contentType);
      assert.equal(resolveDocumentContentType(`${format.contentType.toUpperCase()}; charset=utf-8`, "meeting.unknown"), format.contentType);
    }
  }
  assert.equal(resolveDocumentContentType("image/png", "meeting.pdf"), null);
  assert.equal(resolveDocumentContentType("application/x-pdf", "meeting.pdf"), null);
  assert.equal(resolveDocumentContentType("", ".pdf"), null);
  assert.equal(resolveDocumentContentType("", "meeting.docx"), null);
  assert.equal(resolveDocumentContentType("application/pdf", "meeting"), "application/pdf");
});

test("policy validation admits bounded typed fields, copies arrays and rejects unknown limits or formats", () => {
  const source = { schemaVersion: 1, maxFileBytes: 1280, maxPdfPages: 250, acceptedContentTypes: ["application/pdf"] };
  const valid = parseDocumentUploadPolicy(source)!;
  assert.ok(valid); assert.deepEqual(valid, source); assert.notEqual(valid.acceptedContentTypes, source.acceptedContentTypes);
  for (const value of [null, undefined, [], { ...source, schemaVersion: 2 }, { ...source, maxFileBytes: 0 },
    { ...source, maxFileBytes: NaN }, { ...source, maxFileBytes: Infinity }, { ...source, maxFileBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...source, maxPdfPages: "250" }, { ...source, maxPdfPages: -1 }, { ...source, acceptedContentTypes: [] },
    { ...source, acceptedContentTypes: ["application/pdf", "application/pdf"] }, { ...source, acceptedContentTypes: ["text/html"] },
    { ...source, acceptedContentTypes: ["__proto__"] }]) assert.equal(parseDocumentUploadPolicy(value), null);
});
