import test from "node:test";
import assert from "node:assert/strict";
import { DocumentUploadError } from "./document-feedback.js";
import { documentUploadPolicyView, validateDocumentUpload } from "./document-upload-policy.js";
import type { DocumentUploadPolicy } from "@vrata/shared-types";

const policy: DocumentUploadPolicy = { schemaVersion: 1, maxFileBytes: 1024, maxPdfPages: 3, acceptedContentTypes: ["application/pdf", "image/png"] };
test("upload UI shows exact server bytes and pages without inventing legacy limits", () => {
  const view = documentUploadPolicyView(policy);
  assert.match(view.description, /1,024 bytes/); assert.match(view.description, /3 pages/); assert.match(view.description, /PDF, PNG/);
  assert.equal(view.accept, "application/pdf,.pdf,image/png,.png");
  const legacy = documentUploadPolicyView(null); assert.match(legacy.description, /limits are unavailable/);
  assert.doesNotMatch(legacy.description, /10 MiB|10,485,760|250/);
});
test("preflight permits exactly MAX and extension-only MIME parity, but refuses oversize and mismatched formats", () => {
  assert.doesNotThrow(() => validateDocumentUpload({ size: 1024, name: "meeting.pdf", type: "application/pdf" }, policy));
  assert.doesNotThrow(() => validateDocumentUpload({ size: 10, name: "meeting.PNG ", type: "" }, policy));
  for (const [file, code] of [[{ size: 1025, name: "meeting.pdf", type: "application/pdf" }, "document_too_large"],
    [{ size: 1, name: "meeting.pdf", type: "image/png" }, "unsupported_document_mime"],
    [{ size: 1, name: "meeting.html", type: "text/html" }, "unsupported_document_mime"],
    [{ size: 1, name: "meeting.mp4", type: "video/mp4" }, "unsupported_document_mime"]] as const) {
    assert.throws(() => validateDocumentUpload(file, policy), (error: unknown) => error instanceof DocumentUploadError && error.code === code);
  }
  assert.doesNotThrow(() => validateDocumentUpload({ size: 100000000, name: "meeting.pdf", type: "application/pdf" }, null), "a legacy server remains the authority for an undisclosed size limit");
});
