import { DOCUMENT_UPLOAD_FORMATS, resolveDocumentContentType, type DocumentUploadPolicy } from "@vrata/shared-types";
import { DocumentUploadError } from "./document-feedback.js";

export function documentUploadPolicyView(policy: DocumentUploadPolicy | null): { accept: string; description: string } {
  const formats = DOCUMENT_UPLOAD_FORMATS.filter(format => !policy || policy.acceptedContentTypes.includes(format.contentType));
  const accept = formats.flatMap(format => [format.contentType, ...format.extensions]).join(",");
  const description = `Accepted: ${formats.map(format => format.label).join(", ")}. `;
  if (!policy) return { accept, description: description + "Upload limits are unavailable from this server; files are validated on upload." };
  const bytes = policy.maxFileBytes.toLocaleString("en-US");
  const mib = policy.maxFileBytes / (1024 * 1024);
  return { accept, description: description + `Maximum file size: ${bytes} bytes${Number.isInteger(mib) ? ` (${mib} MiB)` : ""}. PDF: up to ${policy.maxPdfPages} pages.` };
}

/** Metadata preflight only. The API still validates bytes, authority and storage. */
export function validateDocumentUpload(file: Pick<File, "name" | "type" | "size">, policy: DocumentUploadPolicy | null): void {
  if (policy && file.size > policy.maxFileBytes) throw new DocumentUploadError(413);
  const type = resolveDocumentContentType(file.type, file.name.trim());
  if (!type || (policy && !policy.acceptedContentTypes.includes(type))) throw new DocumentUploadError(400, "unsupported_document_mime");
}
