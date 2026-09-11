import test from "node:test";
import assert from "node:assert/strict";

import { inspectImageDocument, inspectVideoDocument } from "./document-media-metadata.js";
import type { MultipartPart } from "./multipart-form-data.js";

// Minimal headers characterize the existing inspector; they are not complete,
// decodable media files and do not imply validation of the entire file format.
function png(width = 640, height = 480): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpeg(width = 640, height = 480, marker = 0xc0): Buffer {
  const data = Buffer.alloc(11);
  data[0] = 0xff; data[1] = 0xd8; data[2] = 0xff; data[3] = marker;
  data.writeUInt16BE(7, 4);
  data[6] = 8;
  data.writeUInt16BE(height, 7);
  data.writeUInt16BE(width, 9);
  return data;
}

function webp(chunk = "VP8X", width = 640, height = 480): Buffer {
  const data = Buffer.alloc(30);
  data.write("RIFF", 0, "ascii"); data.write("WEBP", 8, "ascii"); data.write(chunk, 12, "ascii");
  if (chunk === "VP8X") {
    data.writeUIntLE(width - 1, 24, 3); data.writeUIntLE(height - 1, 27, 3);
  } else if (chunk === "VP8L") {
    data[20] = 0x2f;
    data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else if (chunk === "VP8 ") {
    data[23] = 0x9d; data[24] = 0x01; data[25] = 0x2a;
    data.writeUInt16LE(width, 26); data.writeUInt16LE(height, 28);
  }
  return data;
}

function video(contentType = "video/mp4"): Buffer {
  const data = Buffer.alloc(contentType === "video/mp4" ? 16 : 8);
  if (contentType === "video/mp4") data.write("ftyp", 4, "ascii");
  else data.writeUInt32BE(0x1a45dfa3, 0);
  return data;
}

function part(name: string, value: string): MultipartPart {
  return { name, data: Buffer.from(value) };
}

function videoParts(width = "640", height = "480", duration = "1500"): MultipartPart[] {
  return [part("mediaWidthPx", width), part("mediaHeightPx", height), part("mediaDurationMs", duration)];
}

const imageMetadata = (widthPx = 640, heightPx = 480) => ({ kind: "image", widthPx, heightPx, metadataSource: "server" });

test("PNG dimensions and metadata source are read from the header", () => {
  assert.deepEqual(inspectImageDocument(png(), "image/png"), imageMetadata());
});

test("PNG rejects truncated headers, wrong signature and wrong chunk", () => {
  const badSignature = png(); badSignature[0] = 0;
  const badChunk = png(); badChunk.write("IDAT", 12, "ascii");
  for (const data of [Buffer.alloc(0), png().subarray(0, 23), badSignature, badChunk]) {
    assert.throws(() => inspectImageDocument(data, "image/png"), { message: "invalid_image_signature" });
  }
});

test("all currently accepted JPEG SOF markers return dimensions", () => {
  for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
    assert.deepEqual(inspectImageDocument(jpeg(640, 480, marker), "image/jpeg"), imageMetadata());
  }
});

test("JPEG scans past non-marker bytes and unrelated segments", () => {
  const data = Buffer.concat([jpeg().subarray(0, 2), Buffer.from([0x12, 0x34, 0xff, 0xe0, 0x00, 0x04, 0xab, 0xcd]), jpeg().subarray(2)]);
  assert.deepEqual(inspectImageDocument(data, "image/jpeg"), imageMetadata());
});

test("JPEG stops at scan or end markers rather than reading later frames", () => {
  for (const marker of [0xd9, 0xda]) {
    const data = Buffer.concat([jpeg(640, 480, marker), jpeg().subarray(2)]);
    assert.throws(() => inspectImageDocument(data, "image/jpeg"), { message: "invalid_image_signature" });
  }
});

test("JPEG rejects invalid signatures and truncated or invalid segments", () => {
  const badSignature = jpeg(); badSignature[1] = 0;
  const tooShort = jpeg(); tooShort.writeUInt16BE(1, 4);
  const tooLong = jpeg(); tooLong.writeUInt16BE(20, 4);
  for (const data of [Buffer.alloc(3), badSignature, jpeg().subarray(0, 10), tooShort, tooLong, jpeg(640, 480, 0xc4)]) {
    assert.throws(() => inspectImageDocument(data, "image/jpeg"), { message: "invalid_image_signature" });
  }
});

test("WebP extended, lossless and lossy headers retain their dimension rules", () => {
  for (const chunk of ["VP8X", "VP8L", "VP8 "]) {
    assert.deepEqual(inspectImageDocument(webp(chunk), "image/webp"), imageMetadata());
  }
  const scaled = webp("VP8 ");
  scaled.writeUInt16LE(640 | 0xc000, 26); scaled.writeUInt16LE(480 | 0x8000, 28);
  assert.deepEqual(inspectImageDocument(scaled, "image/webp"), imageMetadata());
});

test("WebP extended and lossless fields store dimensions minus one", () => {
  for (const chunk of ["VP8X", "VP8L"]) {
    assert.deepEqual(inspectImageDocument(webp(chunk, 1, 1), "image/webp"), imageMetadata(1, 1));
  }
});

test("WebP rejects short buffers, invalid containers and unknown chunks", () => {
  const riff = webp(); riff.write("RIFX", 0, "ascii");
  const format = webp(); format.write("WAVE", 8, "ascii");
  const lossless = webp("VP8L"); lossless[20] = 0;
  const lossy = webp("VP8 "); lossy[24] = 0;
  for (const data of [webp().subarray(0, 29), riff, format, webp("JUNK"), lossless, lossy]) {
    assert.throws(() => inspectImageDocument(data, "image/webp"), { message: "invalid_image_signature" });
  }
});

test("image content type matching stays exact and rejects unsupported types", () => {
  for (const contentType of ["", "image/gif", "IMAGE/PNG", "image/png; charset=utf-8", "video/mp4"]) {
    assert.throws(() => inspectImageDocument(png(), contentType), { message: "unsupported_document_mime" });
  }
});

test("image dimension boundaries are inclusive on axes and total pixels", () => {
  for (const [width, height] of [[1, 1], [16_384, 1], [1, 16_384], [10_000, 6700]]) {
    assert.deepEqual(inspectImageDocument(png(width, height), "image/png"), imageMetadata(width, height));
  }
  for (const [width, height] of [[0, 480], [640, 0], [16_385, 1], [1, 16_385], [10_000, 6701]]) {
    assert.throws(() => inspectImageDocument(png(width, height), "image/png"), { message: "invalid_media_dimensions" });
  }
});

test("JPEG and WebP use the same dimension validation as PNG", () => {
  for (const [data, contentType] of [
    [jpeg(0, 480), "image/jpeg"], [jpeg(16_385, 1), "image/jpeg"],
    [webp("VP8X", 16_385, 1), "image/webp"], [webp("VP8L", 10_000, 6701), "image/webp"],
    [webp("VP8 ", 0, 480), "image/webp"]
  ] as const) {
    assert.throws(() => inspectImageDocument(data, contentType), { message: "invalid_media_dimensions" });
  }
});

test("MP4 and WebM return browser metadata with the matching container", () => {
  for (const [contentType, container] of [["video/mp4", "mp4"], ["video/webm", "webm"]]) {
    assert.deepEqual(inspectVideoDocument(video(contentType), contentType, videoParts()), {
      kind: "video", widthPx: 640, heightPx: 480, durationMs: 1500, container, metadataSource: "browser"
    });
  }
});

test("video rejects short or mismatched container signatures", () => {
  for (const contentType of ["video/mp4", "video/webm"]) {
    const data = video(contentType);
    for (const bad of [data.subarray(0, data.length - 1), Buffer.alloc(data.length)]) {
      assert.throws(() => inspectVideoDocument(bad, contentType, videoParts()), { message: "invalid_video_container" });
    }
  }
});

test("unsupported video MIME takes precedence over missing metadata", () => {
  for (const contentType of ["", "video/avi", "VIDEO/MP4", "video/mp4; codecs=avc1", "image/png"]) {
    assert.throws(() => inspectVideoDocument(Buffer.alloc(0), contentType, []), { message: "unsupported_document_mime" });
  }
});

test("video container validation precedes metadata and dimension checks", () => {
  assert.throws(() => inspectVideoDocument(Buffer.alloc(0), "video/mp4", []), { message: "invalid_video_container" });
  assert.throws(() => inspectVideoDocument(Buffer.alloc(16), "video/mp4", videoParts("0")), { message: "invalid_video_container" });
});

test("each missing video metadata field is rejected", () => {
  for (let index = 0; index < 3; index += 1) {
    assert.throws(() => inspectVideoDocument(video(), "video/mp4", videoParts().filter((_, i) => i !== index)), { message: "video_metadata_missing" });
  }
});

test("empty and non-finite video fields keep the metadata-missing error", () => {
  for (const value of ["", "  ", "NaN", "Infinity", "-Infinity", "1e309", "not-a-number"]) {
    for (let index = 0; index < 3; index += 1) {
      const parts = videoParts(); parts[index].data = Buffer.from(value);
      assert.throws(() => inspectVideoDocument(video(), "video/mp4", parts), { message: "video_metadata_missing" });
    }
  }
});

test("video number conversion still accepts whitespace, exponent and hex notation", () => {
  assert.deepEqual(inspectVideoDocument(video(), "video/mp4", videoParts(" 6.4e2 ", "0x1e0", "+1500")), {
    kind: "video", widthPx: 640, heightPx: 480, durationMs: 1500, container: "mp4", metadataSource: "browser"
  });
});

test("the first duplicate video field wins, including an invalid first value", () => {
  const later = [...videoParts(), part("mediaWidthPx", "1000")];
  assert.equal(inspectVideoDocument(video(), "video/mp4", later).widthPx, 640);
  assert.throws(() => inspectVideoDocument(video(), "video/mp4", [part("mediaWidthPx", ""), ...videoParts()]), { message: "video_metadata_missing" });
});

test("video fields match names exactly and retain file-part handling", () => {
  const wrongCase = videoParts(); wrongCase[0].name = "MediaWidthPx";
  assert.throws(() => inspectVideoDocument(video(), "video/mp4", wrongCase), { message: "video_metadata_missing" });
  const withFilename = videoParts(); withFilename[0].filename = "width.txt";
  assert.equal(inspectVideoDocument(video(), "video/mp4", withFilename).widthPx, 640);
});

test("video dimension validation and error precedence are unchanged", () => {
  for (const [width, height] of [["0", "480"], ["640", "-1"], ["1.5", "480"], ["16385", "1"], ["1", "16385"], ["10000", "6701"]]) {
    assert.throws(() => inspectVideoDocument(video(), "video/mp4", videoParts(width, height, "0")), { message: "invalid_media_dimensions" });
  }
  assert.throws(() => inspectVideoDocument(video(), "video/mp4", videoParts("0", "480", "")), { message: "video_metadata_missing" });
});

test("video duration accepts one millisecond through four hours inclusively", () => {
  for (const duration of ["1", String(4 * 60 * 60 * 1000)]) {
    assert.equal(inspectVideoDocument(video(), "video/mp4", videoParts("640", "480", duration)).durationMs, Number(duration));
  }
  for (const duration of ["0", "-1", "1.5", String(4 * 60 * 60 * 1000 + 1)]) {
    assert.throws(() => inspectVideoDocument(video(), "video/mp4", videoParts("640", "480", duration)), { message: "video_duration_invalid" });
  }
});

test("inspection does not mutate buffers or form parts and returns fresh metadata", () => {
  const image = png(); const imageBefore = Buffer.from(image);
  const data = video(); const dataBefore = Buffer.from(data);
  const parts = videoParts(); const partsBefore = parts.map(p => ({ ...p, data: Buffer.from(p.data) }));
  const first = inspectImageDocument(image, "image/png"); first.widthPx = 1;
  assert.deepEqual(inspectImageDocument(image, "image/png"), imageMetadata());
  inspectVideoDocument(data, "video/mp4", parts);
  assert.deepEqual(image, imageBefore); assert.deepEqual(data, dataBefore); assert.deepEqual(parts, partsBefore);
});
