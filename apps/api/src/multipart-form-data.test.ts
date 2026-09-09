import test from "node:test";
import assert from "node:assert/strict";

import { parseMultipartBoundary, parseMultipartFormData, textPart, filePart, type MultipartPart } from "./multipart-form-data.js";

function multipart(parts: Array<{ headers: string; data: string | Buffer }>, boundary = "vrata-test"): Buffer {
  return Buffer.concat([
    ...parts.flatMap(({ headers, data }) => [
      Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`),
      Buffer.isBuffer(data) ? data : Buffer.from(data),
      Buffer.from("\r\n")
    ]),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
}

function field(name: string, data: string | Buffer, filename?: string): { headers: string; data: string | Buffer } {
  return { headers: `Content-Disposition: form-data; name="${name}"${filename === undefined ? "" : `; filename="${filename}"`}`, data };
}

function part(name: string, data: string, filename?: string): MultipartPart {
  return { name, data: Buffer.from(data), filename };
}

test("boundary parser returns null when the parameter is absent or empty", () => {
  for (const value of [undefined, "", "multipart/form-data", "multipart/form-data; boundary=", "multipart/form-data; otherboundary=x"]) {
    assert.equal(parseMultipartBoundary(value), null);
  }
});

test("boundary parser preserves quoted, unquoted and case-insensitive parameters", () => {
  for (const [value, expected] of [
    ["multipart/form-data; boundary=vrata-test", "vrata-test"],
    ['multipart/form-data; boundary="vrata-test"', "vrata-test"],
    ['multipart/form-data; BOUNDARY="a;b"; charset=utf-8', "a;b"],
    ["boundary=vrata-test; charset=utf-8", "vrata-test"],
    ["multipart/form-data; charset=utf-8; boundary=x=y", "x=y"]
  ]) assert.equal(parseMultipartBoundary(value), expected);
});

test("boundary parser keeps existing whitespace, first-match and media-type semantics", () => {
  assert.equal(parseMultipartBoundary("multipart/form-data; boundary=x  ; charset=utf-8"), "x  ");
  assert.equal(parseMultipartBoundary("multipart/form-data; boundary =x"), null);
  assert.equal(parseMultipartBoundary('multipart/form-data; boundary=""'), "");
  assert.equal(parseMultipartBoundary("multipart/form-data; boundary=first; boundary=second"), "first");
  assert.equal(parseMultipartBoundary("text/plain; boundary=x"), "x");
});

test("text fields and binary files are parsed in wire order without changing bytes", () => {
  const binary = Buffer.from([0, 1, 255, 128, 13, 10, 65, 0]);
  const body = multipart([
    field("title", "  Комната  "),
    { headers: 'Content-Disposition: form-data; name="document"; filename="image.png"\r\nContent-Type: image/png', data: binary }
  ]);
  const parts = parseMultipartFormData(body, "vrata-test");
  assert.deepEqual(parts, [
    { name: "title", filename: undefined, contentType: undefined, data: Buffer.from("  Комната  ") },
    { name: "document", filename: "image.png", contentType: "image/png", data: binary }
  ]);
  assert.equal(textPart(parts, "title"), "Комната");
  assert.equal(filePart(parts, "document"), parts[1]);
});

test("empty named parts and repeated fields remain present in order", () => {
  const parts = parseMultipartFormData(multipart([field("item", ""), field("item", "second"), field("file", "", "empty.txt")]), "vrata-test");
  assert.deepEqual(parts.map((entry) => [entry.name, entry.filename, entry.data.length]), [["item", undefined, 0], ["item", undefined, 6], ["file", "empty.txt", 0]]);
});

test("parts without a nonempty disposition name are omitted", () => {
  const parts = parseMultipartFormData(multipart([
    { headers: "X-Other: value", data: "ignored" },
    { headers: 'Content-Disposition: form-data; name=""; filename="a.txt"', data: "ignored" },
    field("kept", "value")
  ]), "vrata-test");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, "kept");
});

test("header names are case-insensitive, trimmed and use the last duplicate", () => {
  const parts = parseMultipartFormData(multipart([{
    headers: 'CONTENT-DISPOSITION: form-data; name="old"\r\n content-disposition : form-data; name="file"; filename="a.txt"\r\nCONTENT-TYPE: old/type\r\ncontent-type: text/plain; note=a:b',
    data: "value"
  }]), "vrata-test");
  assert.equal(parts[0].name, "file");
  assert.equal(parts[0].filename, "a.txt");
  assert.equal(parts[0].contentType, "text/plain; note=a:b");
});

test("disposition parameters retain case handling, equals signs and last-value precedence", () => {
  const parts = parseMultipartFormData(multipart([{
    headers: 'Content-Disposition: form-data; NAME="old"; name = "file"; FILENAME="old.txt"; filename="a=b.txt"',
    data: "value"
  }]), "vrata-test");
  assert.equal(parts[0].name, "file");
  assert.equal(parts[0].filename, "a=b.txt");
});

test("unquoted parameters and empty filenames retain current classification", () => {
  const parts = parseMultipartFormData(multipart([
    { headers: 'Content-Disposition: form-data; name=field; filename=""', data: " text " },
    { headers: 'Content-Disposition: form-data; name=file; filename=a.txt; filename*=UTF-8\'\'other.txt', data: "file" }
  ]), "vrata-test");
  assert.equal(textPart(parts, "field"), "text");
  assert.equal(filePart(parts, "field"), undefined);
  assert.equal(parts[1].filename, "a.txt");
});

test("malformed header lines are ignored without changing valid headers", () => {
  const parts = parseMultipartFormData(multipart([{
    headers: 'ignored\r\n:ignored\r\nContent-Disposition: form-data; name="item"\r\nX-Other: value',
    data: "ok"
  }]), "vrata-test");
  assert.equal(textPart(parts, "item"), "ok");
});

test("closing boundary alone produces no parts and preamble or epilogue is ignored", () => {
  assert.deepEqual(parseMultipartFormData(Buffer.from("--vrata-test--\r\n"), "vrata-test"), []);
  const body = Buffer.concat([Buffer.from("preamble\r\n"), multipart([field("item", "ok")]), Buffer.from("epilogue")]);
  assert.equal(textPart(parseMultipartFormData(body, "vrata-test"), "item"), "ok");
});

test("boundary-like bytes without the CRLF prefix remain part of file data", () => {
  const data = Buffer.from("binary\0--vrata-test\n--vrata-test\r\nend\r\n");
  const parsed = parseMultipartFormData(multipart([field("file", data, "a.bin")]), "vrata-test");
  assert.deepEqual(parsed[0].data, data);
});

test("a missing initial boundary retains the exact error", () => {
  assert.throws(() => parseMultipartFormData(Buffer.from("not multipart"), "vrata-test"), { message: "invalid_multipart_body" });
});

test("unterminated headers retain the exact error", () => {
  assert.throws(() => parseMultipartFormData(Buffer.from('--vrata-test\r\nContent-Disposition: form-data; name="item"'), "vrata-test"), { message: "invalid_multipart_part_headers" });
});

test("unterminated content retains the exact error", () => {
  assert.throws(() => parseMultipartFormData(Buffer.from('--vrata-test\r\nContent-Disposition: form-data; name="item"\r\n\r\nvalue'), "vrata-test"), { message: "invalid_multipart_part_body" });
});

test("part data remains a view into the request buffer rather than a copied buffer", () => {
  const body = multipart([field("item", "payload")]);
  const parsed = parseMultipartFormData(body, "vrata-test");
  const original = Buffer.from(body);
  assert.deepEqual(body, original);
  body[body.indexOf(Buffer.from("payload"))] = "P".charCodeAt(0);
  assert.equal(parsed[0].data.toString(), "Payload");
});

test("independent calls do not share the parts array", () => {
  const body = multipart([field("item", "value")]);
  const first = parseMultipartFormData(body, "vrata-test");
  const second = parseMultipartFormData(body, "vrata-test");
  first.pop();
  assert.equal(second.length, 1);
});

test("text selection skips files, trims UTF-8 values and returns the first matching field", () => {
  const parts = [part("item", "ignored", "file.txt"), part("item", "  Значение \r\n"), part("item", "later")];
  assert.equal(textPart(parts, "item"), "Значение");
  assert.equal(textPart(parts, "missing"), undefined);
  assert.equal(textPart([], "item"), undefined);
});

test("empty first text field does not fall through to later duplicate fields", () => {
  assert.equal(textPart([part("item", " \r\n"), part("item", "later")], "item"), undefined);
  assert.equal(textPart([part("item", "", ""), part("item", "later")], "item"), undefined);
});

test("file selection uses the first matching truthy filename and preserves object identity", () => {
  const first = part("file", "one", "one.txt");
  const second = part("file", "two", "two.txt");
  assert.equal(filePart([part("file", "text"), part("file", "empty-name", ""), first, second], "file"), first);
  assert.equal(filePart([first], "missing"), undefined);
  assert.equal(filePart([], "file"), undefined);
  const whitespaceName = part("file", "content", " ");
  assert.equal(filePart([whitespaceName], "file"), whitespaceName);
});

test("native FormData encoding remains compatible with text and binary file selection", async () => {
  const form = new FormData();
  form.append("title", "  Native upload  ");
  form.append("file", new Blob([new Uint8Array([0, 255, 65, 13, 10])], { type: "application/octet-stream" }), "native.bin");
  const request = new Request("http://localhost/upload", { method: "POST", body: form });
  const boundary = parseMultipartBoundary(request.headers.get("content-type") ?? undefined);
  assert.ok(boundary);
  const parts = parseMultipartFormData(Buffer.from(await request.arrayBuffer()), boundary);
  assert.equal(textPart(parts, "title"), "Native upload");
  assert.equal(filePart(parts, "file")?.filename, "native.bin");
  assert.equal(filePart(parts, "file")?.contentType, "application/octet-stream");
  assert.deepEqual(filePart(parts, "file")?.data, Buffer.from([0, 255, 65, 13, 10]));
});
