export const DOCUMENT_UPLOAD_FORMATS = [
  { contentType: "application/pdf", extensions: [".pdf"], label: "PDF" },
  { contentType: "image/png", extensions: [".png"], label: "PNG" },
  { contentType: "image/jpeg", extensions: [".jpg", ".jpeg"], label: "JPEG" },
  { contentType: "image/webp", extensions: [".webp"], label: "WebP" },
  { contentType: "video/mp4", extensions: [".mp4"], label: "MP4" },
  { contentType: "video/webm", extensions: [".webm"], label: "WebM" },
  { contentType: "text/plain", extensions: [".txt"], label: "TXT" }
] as const;

export type DocumentContentType = typeof DOCUMENT_UPLOAD_FORMATS[number]["contentType"];
export interface DocumentUploadPolicy {
  schemaVersion: 1;
  maxFileBytes: number;
  maxPdfPages: number;
  acceptedContentTypes: DocumentContentType[];
}

export function resolveDocumentContentType(contentType: string | undefined, filename: string): DocumentContentType | null {
  const raw = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const basename = filename.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  const extension = dot > 0 ? basename.slice(dot).toLowerCase() : undefined;
  const inferred = DOCUMENT_UPLOAD_FORMATS.find(format => (format.extensions as readonly string[]).includes(extension ?? ""))?.contentType;
  if (raw && raw !== "application/octet-stream" && inferred && raw !== inferred) return null;
  const resolved = raw && raw !== "application/octet-stream" ? raw : inferred;
  return DOCUMENT_UPLOAD_FORMATS.find(format => format.contentType === resolved)?.contentType ?? null;
}

/** Missing/unknown policy is a legacy server, not an invented default limit. */
export function parseDocumentUploadPolicy(value: unknown): DocumentUploadPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.maxFileBytes) || (policy.maxFileBytes as number) < 1
    || !Number.isSafeInteger(policy.maxPdfPages) || (policy.maxPdfPages as number) < 1
    || !Array.isArray(policy.acceptedContentTypes) || policy.acceptedContentTypes.length < 1
    || policy.acceptedContentTypes.length > DOCUMENT_UPLOAD_FORMATS.length) return null;
  const types = policy.acceptedContentTypes;
  if (new Set(types).size !== types.length || types.some(type => !DOCUMENT_UPLOAD_FORMATS.some(format => format.contentType === type))) return null;
  return { schemaVersion: 1, maxFileBytes: policy.maxFileBytes as number, maxPdfPages: policy.maxPdfPages as number,
    acceptedContentTypes: [...types] as DocumentContentType[] };
}
