import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDocumentContentType, normalizeDocumentFilename, safeHeaderFilename } from "./document-file-policy.js";
import type { MultipartPart } from "./multipart-form-data.js";

const formats = [
  ["pdf", "application/pdf"], ["png", "image/png"], ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"], ["webp", "image/webp"], ["mp4", "video/mp4"],
  ["webm", "video/webm"], ["txt", "text/plain"]
] as const;

function part(contentType?: string): MultipartPart {
  return { name: "file", filename: "ignored.bin", contentType, data: Buffer.from("not inspected here") };
}

test("missing MIME is inferred for every supported extension, case-insensitively", () => {
  for (const [extension, mime] of formats) {
    for (const name of [`file.${extension}`, `file.${extension.toUpperCase()}`]) {
      assert.equal(normalizeDocumentContentType(part(), name), mime);
    }
  }
});

test("declared MIME is trimmed, lowercased and stripped of parameters", () => {
  for (const [extension, mime] of formats) {
    assert.equal(normalizeDocumentContentType(part(`  ${mime.toUpperCase()} ; charset=UTF-8; ignored=value`), `file.${extension}`), mime);
  }
});

test("empty and generic MIME use extension inference", () => {
  for (const raw of [undefined, "", " \t ", "; charset=utf-8", "application/octet-stream", " APPLICATION/OCTET-STREAM ; x=1"]) {
    for (const [extension, mime] of formats) {
      assert.equal(normalizeDocumentContentType(part(raw), `file.${extension}`), mime);
    }
  }
});

test("a declared MIME conflicting with a recognized extension is rejected", () => {
  for (const [extension, inferred] of formats) {
    for (const [, declared] of formats) {
      assert.equal(normalizeDocumentContentType(part(declared), `file.${extension}`), declared === inferred ? inferred : null);
    }
  }
});

test("supported declared MIME still permits unrecognized or missing extensions", () => {
  // This is existing behavior, not an extension-based allowlist or content decoder.
  for (const [, mime] of formats) {
    for (const filename of ["file", "file.bin", ".pdf", "file.", "file.svg"]) {
      assert.equal(normalizeDocumentContentType(part(mime), filename), mime);
    }
  }
});

test("an absent or generic MIME cannot identify unknown extensions", () => {
  for (const raw of [undefined, "", "application/octet-stream"]) {
    for (const filename of ["", "file", "file.bin", ".pdf", "file.", "file.svg"]) {
      assert.equal(normalizeDocumentContentType(part(raw), filename), null);
    }
  }
});

test("unsupported explicit MIME is not replaced by a recognized extension", () => {
  for (const raw of ["application/zip", "text/html", "image/svg+xml", "image/jpg", "image/*", "invalid", "image/png, image/jpeg"]) {
    assert.equal(normalizeDocumentContentType(part(raw), "file.png"), null);
    assert.equal(normalizeDocumentContentType(part(raw), "file.unknown"), null);
  }
});

test("only the first MIME segment is considered", () => {
  assert.equal(normalizeDocumentContentType(part(";image/jpeg"), "file.png"), "image/png");
  assert.equal(normalizeDocumentContentType(part("image/png;image/jpeg"), "file.png"), "image/png");
  assert.equal(normalizeDocumentContentType(part("text/html;image/png"), "file.png"), null);
});

test("inference uses the last extension without decoding or trimming the filename", () => {
  assert.equal(normalizeDocumentContentType(part(), "file.tar.PDF"), "application/pdf");
  for (const filename of ["file.pdf.exe", "file.pdf ", "file%2epdf", "file.pdf?download=1", ".pdf"]) {
    assert.equal(normalizeDocumentContentType(part(), filename), null);
  }
});

test("MIME policy does not read file bytes or the part filename", () => {
  const input = part("image/png");
  Object.defineProperty(input, "data", { get() { throw new Error("unexpected byte inspection"); } });
  Object.defineProperty(input, "filename", { get() { throw new Error("unexpected filename access"); } });
  assert.equal(normalizeDocumentContentType(input, "file.png"), "image/png");
});

test("filenames preserve allowed characters and trim surrounding whitespace", () => {
  assert.equal(normalizeDocumentFilename(" \t Report 2026-09_11.v1.PDF\r\n"), "Report 2026-09_11.v1.PDF");
  assert.equal(normalizeDocumentFilename(".hidden-file.txt"), ".hidden-file.txt");
  assert.equal(normalizeDocumentFilename("a  b.txt"), "a  b.txt");
});

test("missing, blank and dot-only filenames are rejected", () => {
  for (const filename of [undefined, "", " \t\r\n", ".", "..", " . ", " .. "]) {
    assert.equal(normalizeDocumentFilename(filename), null);
  }
  assert.equal(normalizeDocumentFilename("..."), "...");
});

test("path separators and NUL are rejected rather than reduced to a basename", () => {
  for (const filename of ["../file.pdf", "/file.pdf", "dir/file.pdf", "dir\\file.pdf", "file/", "C:\\file.pdf", "file\0.pdf"]) {
    assert.equal(normalizeDocumentFilename(filename), null);
  }
});

test("filename length is limited to 160 characters after trimming", () => {
  const limit = "x".repeat(156) + ".pdf";
  assert.equal(normalizeDocumentFilename(limit), limit);
  assert.equal(normalizeDocumentFilename(`  ${limit}\n`), limit);
  assert.equal(normalizeDocumentFilename("x" + limit), null);
});

test("filename length and replacement retain UTF-16 code-unit semantics", () => {
  assert.equal(normalizeDocumentFilename("😀".repeat(80)), "_".repeat(160));
  assert.equal(normalizeDocumentFilename("😀".repeat(80) + "x"), null);
  assert.equal(normalizeDocumentFilename("Отчёт.pdf"), "_____.pdf");
  assert.equal(normalizeDocumentFilename("e\u0301-中-😀.txt"), "e_-_-__.txt");
});

test("ASCII filename sanitization preserves the existing character allowlist", () => {
  for (let code = 0; code < 128; code += 1) {
    const char = String.fromCharCode(code);
    const expected = [0, 47, 92].includes(code) ? null : `a${/[A-Za-z0-9._ -]/.test(char) ? char : "_"}b.txt`;
    assert.equal(normalizeDocumentFilename(`a${char}b.txt`), expected, `ASCII ${code}`);
  }
});

test("filenames are not URL-decoded and reserved-looking names are unchanged", () => {
  assert.equal(normalizeDocumentFilename("a%2Fb.txt"), "a_2Fb.txt");
  assert.equal(normalizeDocumentFilename("CON.txt"), "CON.txt");
  assert.equal(normalizeDocumentFilename("..file.pdf"), "..file.pdf");
  assert.equal(normalizeDocumentFilename("file:stream.txt"), "file_stream.txt");
});

test("normalized filenames still drive MIME conflict detection", () => {
  const filename = normalizeDocumentFilename("  Отчёт.PDF  ");
  assert.equal(filename, "_____.PDF");
  assert.equal(normalizeDocumentContentType(part(), filename!), "application/pdf");
  assert.equal(normalizeDocumentContentType(part("image/png"), filename!), null);
});

test("header filenames retain printable ASCII except quotes and backslashes", () => {
  for (let code = 32; code <= 126; code += 1) {
    const char = String.fromCharCode(code);
    assert.equal(safeHeaderFilename(`a${char}b`), `a${code === 34 || code === 92 ? "_" : char}b`, `ASCII ${code}`);
  }
});

test("header filenames replace controls and non-ASCII without trimming", () => {
  assert.equal(safeHeaderFilename(" \r\nfile\t\0\x7f.pdf "), " __file___.pdf ");
  assert.equal(safeHeaderFilename("Отчёт-😀.pdf"), "_____-__.pdf");
});

test("header formatting remains distinct from upload filename validation", () => {
  for (const filename of ["", ".", "..", "/file.pdf", "x".repeat(161), "file%20name.pdf"]) {
    assert.equal(safeHeaderFilename(filename), filename);
  }
});

test("MIME normalization leaves the multipart record and bytes untouched", () => {
  const input = part(" IMAGE/PNG ; charset=binary");
  const before = { ...input, data: Buffer.from(input.data) };
  Object.freeze(input);
  assert.equal(normalizeDocumentContentType(input, "file.png"), "image/png");
  assert.deepEqual(input, before);
});
