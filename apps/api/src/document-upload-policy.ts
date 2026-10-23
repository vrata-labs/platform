import { DOCUMENT_UPLOAD_FORMATS, type DocumentUploadPolicy } from "@vrata/shared-types";
import { constants } from "node:buffer";

export const DOCUMENT_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export function getDocumentUploadPolicy(env: NodeJS.ProcessEnv = process.env): DocumentUploadPolicy {
  const positiveInteger = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > constants.MAX_LENGTH - DOCUMENT_MULTIPART_OVERHEAD_BYTES) {
      throw new Error("misconfigured_document_upload_limits");
    }
    return Number(value);
  };
  return { schemaVersion: 1,
    maxFileBytes: positiveInteger(env.DOCUMENT_UPLOAD_MAX_BYTES, 10 * 1024 * 1024),
    maxPdfPages: positiveInteger(env.PDF_PRESENTATION_MAX_PAGES, 250),
    acceptedContentTypes: DOCUMENT_UPLOAD_FORMATS.map(format => format.contentType) };
}
