import { basename, extname } from "node:path";

import type { MultipartPart } from "./multipart-form-data.js";

const allowedDocumentContentTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/webm",
  "text/plain"
]);

function inferDocumentContentType(filename: string): string | null {
  switch (extname(filename).toLowerCase()) {
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".txt": return "text/plain";
    default: return null;
  }
}

export function normalizeDocumentContentType(part: MultipartPart, filename: string): string | null {
  const raw = part.contentType?.split(";")[0]?.trim().toLowerCase() || "";
  const inferred = inferDocumentContentType(filename);
  if (raw && raw !== "application/octet-stream" && inferred && raw !== inferred) {
    return null;
  }
  const contentType = raw && raw !== "application/octet-stream" ? raw : inferred;
  return contentType && allowedDocumentContentTypes.has(contentType) ? contentType : null;
}

export function normalizeDocumentFilename(input: string | undefined): string | null {
  const raw = input?.trim() ?? "";
  if (!raw || raw.length > 160 || /[\\/\0]/.test(raw)) return null;
  const safe = basename(raw).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  if (!safe || safe === "." || safe === "..") return null;
  return safe;
}

export function safeHeaderFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}
