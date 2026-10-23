import test from "node:test";
import assert from "node:assert/strict";
import { DOCUMENT_MULTIPART_OVERHEAD_BYTES, getDocumentUploadPolicy } from "./document-upload-policy.js";

test("document policy publishes the same configured file/page limits used by upload validation", () => {
  const defaults = getDocumentUploadPolicy({});
  assert.equal(defaults.maxFileBytes, 10 * 1024 * 1024); assert.equal(defaults.maxPdfPages, 250);
  const configured = getDocumentUploadPolicy({ DOCUMENT_UPLOAD_MAX_BYTES: "1024", PDF_PRESENTATION_MAX_PAGES: "5" });
  assert.equal(configured.maxFileBytes, 1024); assert.equal(configured.maxPdfPages, 5);
  assert.equal(configured.schemaVersion, 1); assert.equal(configured.acceptedContentTypes.length, 7);
  assert.equal(DOCUMENT_MULTIPART_OVERHEAD_BYTES, 65536);
});

test("invalid upload configuration fails closed without disclosing its value", () => {
  for (const name of ["DOCUMENT_UPLOAD_MAX_BYTES", "PDF_PRESENTATION_MAX_PAGES"]) {
    for (const value of ["", "0", "-1", "NaN", "Infinity", "10MB", "1.5", " 1024 ", "9007199254740992", "private-environment-value"]) {
      assert.throws(() => getDocumentUploadPolicy({ [name]: value }), { message: "misconfigured_document_upload_limits" });
    }
  }
});
