import type { RoomDocumentMetadata } from "./storage.js";
import type { MultipartPart } from "./multipart-form-data.js";

function validateMediaDimensions(widthPx: number, heightPx: number): void {
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < 1 || heightPx < 1
    || widthPx > 16_384 || heightPx > 16_384 || widthPx * heightPx > 67_000_000) {
    throw new Error("invalid_media_dimensions");
  }
}

function inspectJpegDimensions(data: Buffer): { widthPx: number; heightPx: number } {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error("invalid_image_signature");
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const segmentLength = data.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > data.length) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { heightPx: data.readUInt16BE(offset + 5), widthPx: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  throw new Error("invalid_image_signature");
}

function inspectWebpDimensions(data: Buffer): { widthPx: number; heightPx: number } {
  if (data.length < 30 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") throw new Error("invalid_image_signature");
  const chunk = data.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return { widthPx: 1 + data.readUIntLE(24, 3), heightPx: 1 + data.readUIntLE(27, 3) };
  }
  if (chunk === "VP8L" && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return { widthPx: data.readUInt16LE(26) & 0x3fff, heightPx: data.readUInt16LE(28) & 0x3fff };
  }
  throw new Error("invalid_image_signature");
}

export function inspectImageDocument(data: Buffer, contentType: string): RoomDocumentMetadata {
  let dimensions: { widthPx: number; heightPx: number };
  if (contentType === "image/png") {
    if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || data.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("invalid_image_signature");
    }
    dimensions = { widthPx: data.readUInt32BE(16), heightPx: data.readUInt32BE(20) };
  } else if (contentType === "image/jpeg") {
    dimensions = inspectJpegDimensions(data);
  } else if (contentType === "image/webp") {
    dimensions = inspectWebpDimensions(data);
  } else {
    throw new Error("unsupported_document_mime");
  }
  validateMediaDimensions(dimensions.widthPx, dimensions.heightPx);
  return { kind: "image", ...dimensions, metadataSource: "server" };
}

function multipartNumber(parts: MultipartPart[], name: string): number | null {
  const raw = parts.find((part) => part.name === name)?.data.toString("utf8").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function inspectVideoDocument(data: Buffer, contentType: string, parts: MultipartPart[]): RoomDocumentMetadata {
  let container: "mp4" | "webm";
  if (contentType === "video/mp4") {
    if (data.length < 16 || data.toString("ascii", 4, 8) !== "ftyp") throw new Error("invalid_video_container");
    container = "mp4";
  } else if (contentType === "video/webm") {
    if (data.length < 8 || data.readUInt32BE(0) !== 0x1a45dfa3) throw new Error("invalid_video_container");
    container = "webm";
  } else {
    throw new Error("unsupported_document_mime");
  }
  const widthPx = multipartNumber(parts, "mediaWidthPx");
  const heightPx = multipartNumber(parts, "mediaHeightPx");
  const durationMs = multipartNumber(parts, "mediaDurationMs");
  if (widthPx === null || heightPx === null || durationMs === null) throw new Error("video_metadata_missing");
  validateMediaDimensions(widthPx, heightPx);
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 4 * 60 * 60 * 1000) throw new Error("video_duration_invalid");
  return { kind: "video", widthPx, heightPx, durationMs, container, metadataSource: "browser" };
}
