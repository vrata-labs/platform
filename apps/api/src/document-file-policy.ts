import { basename } from "node:path";
import { resolveDocumentContentType } from "@vrata/shared-types";

import type { MultipartPart } from "./multipart-form-data.js";

export function normalizeDocumentContentType(part: MultipartPart, filename: string): string | null {
  return resolveDocumentContentType(part.contentType, filename);
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
