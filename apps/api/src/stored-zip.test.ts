import test from "node:test";
import assert from "node:assert/strict";

import { createStoredZip } from "./stored-zip.js";

// Read both directories independently of the writer and check their agreement.
function entries(zip: Buffer): Array<{ name: string; content: Buffer; checksum: number }> {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt32LE(end + 4), 0);
  const count = zip.readUInt16LE(end + 10);
  assert.equal(zip.readUInt16LE(end + 8), count);
  assert.equal(zip.readUInt16LE(end + 20), 0);
  let central = zip.readUInt32LE(end + 16);
  const centralStart = central;
  assert.equal(central + zip.readUInt32LE(end + 12), end);
  let local = 0;
  const result = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    assert.equal(zip.readUInt16LE(central + 4), 20);
    assert.equal(zip.readUInt16LE(central + 6), 20);
    assert.equal(zip.readUInt32LE(central + 8), 0); // flags and STORE method
    assert.equal(zip.readUInt32LE(central + 12), 0); // unchanged zero timestamps
    const checksum = zip.readUInt32LE(central + 16);
    const size = zip.readUInt32LE(central + 20);
    assert.equal(zip.readUInt32LE(central + 24), size);
    const nameSize = zip.readUInt16LE(central + 28);
    assert.deepEqual(zip.subarray(central + 30, central + 42), Buffer.alloc(12));
    assert.equal(zip.readUInt32LE(central + 42), local);
    const name = zip.subarray(central + 46, central + 46 + nameSize);

    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt16LE(local + 4), 20);
    assert.equal(zip.readUInt32LE(local + 6), 0);
    assert.equal(zip.readUInt32LE(local + 10), 0);
    assert.equal(zip.readUInt32LE(local + 14), checksum);
    assert.equal(zip.readUInt32LE(local + 18), size);
    assert.equal(zip.readUInt32LE(local + 22), size);
    assert.equal(zip.readUInt16LE(local + 26), nameSize);
    assert.equal(zip.readUInt16LE(local + 28), 0);
    assert.deepEqual(zip.subarray(local + 30, local + 30 + nameSize), name);
    const contentStart = local + 30 + nameSize;
    result.push({ name: name.toString("utf8"), content: zip.subarray(contentStart, contentStart + size), checksum });
    local = contentStart + size;
    central += 46 + nameSize;
  }
  assert.equal(local, centralStart);
  assert.equal(central, end);
  return result;
}

test("empty archive retains its exact end record", () => {
  const zip = createStoredZip([]);
  assert.equal(zip.toString("hex"), "504b0506000000000000000000000000000000000000");
  assert.deepEqual(entries(zip), []);
});

test("single entry matches the frozen pre-extraction archive bytes", () => {
  const zip = createStoredZip([{ name: "notes.txt", content: "123456789" }]);
  const expected = "504b0304140000000000000000002639f4cb0900000009000000090000006e6f7465732e747874313233343536373839"
    + "504b01021400140000000000000000002639f4cb09000000090000000900000000000000000000000000000000006e6f7465732e747874"
    + "504b0506000000000100010037000000300000000000";
  assert.equal(zip.toString("hex"), expected);
  assert.deepEqual(entries(zip), [{ name: "notes.txt", content: Buffer.from("123456789"), checksum: 0xcbf43926 }]);
});

test("text content is stored as UTF-8 bytes without normalization", () => {
  const content = "Заметки: привет 🌍\r\n\t e\u0301 \0";
  const [entry] = entries(createStoredZip([{ name: "notes.md", content }]));
  assert.deepEqual(entry.content, Buffer.from(content, "utf8"));
});

test("binary content preserves all byte values and embedded ZIP signatures", () => {
  const content = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from("PK\x03\x04PK\x05\x06")]);
  assert.deepEqual(entries(createStoredZip([{ name: "payload.bin", content }]))[0].content, content);
});

test("Buffer slices store only the selected bytes", () => {
  const original = Buffer.from([9, 8, 0, 255, 1, 7]);
  const content = original.subarray(2, 5);
  assert.deepEqual(entries(createStoredZip([{ name: "slice.bin", content }]))[0].content, Buffer.from([0, 255, 1]));
});

test("string and Buffer representations produce identical archives", () => {
  const content = "Заметки\n";
  assert.deepEqual(createStoredZip([{ name: "notes.txt", content }]), createStoredZip([{ name: "notes.txt", content: Buffer.from(content) }]));
});

test("multiple entries preserve input order and exact local offsets", () => {
  const files = [
    { name: "z/notes.md", content: "last alphabetically" },
    { name: "a/notes.json", content: "" },
    { name: "data.bin", content: Buffer.from([0, 255, 3]) }
  ];
  const parsed = entries(createStoredZip(files));
  assert.deepEqual(parsed.map(({ name, content }) => ({ name, content })), files.map(({ name, content }) => ({ name, content: Buffer.from(content) })));
});

test("empty string and Buffer entries retain zero size and CRC", () => {
  for (const content of ["", Buffer.alloc(0)]) {
    assert.deepEqual(entries(createStoredZip([{ name: "empty", content }])), [{ name: "empty", content: Buffer.alloc(0), checksum: 0 }]);
  }
});

test("filename replacement preserves the existing order and allowed characters", () => {
  for (const [name, expected] of [
    ["///notes/data-1_v2.md", "notes/data-1_v2.md"],
    ["room notes/общие.json", "room-notes/-.json"],
    ["\\folder\\notes?.txt", "-folder-notes-.txt"],
    [" a : b ", "-a-b-"],
    ["///", ""],
    ["", ""]
  ]) {
    assert.equal(entries(createStoredZip([{ name, content: "" }]))[0].name, expected);
  }
});

test("filename replacement is not general archive path validation", () => {
  for (const name of ["../notes.md", "a//b/./notes.md", "folder/"]) {
    assert.equal(entries(createStoredZip([{ name, content: "text" }]))[0].name, name);
  }
});

test("duplicate filenames and replacement collisions remain separate ordered entries", () => {
  const files = [
    { name: "a b", content: "first" },
    { name: "a?b", content: "second" },
    { name: "a-b", content: "third" }
  ];
  assert.deepEqual(entries(createStoredZip(files)).map(({ name, content }) => [name, content.toString()]), [
    ["a-b", "first"], ["a-b", "second"], ["a-b", "third"]
  ]);
});

test("input arrays, names and content buffers are not mutated", () => {
  const content = Buffer.from([0, 1, 255]);
  const files = [{ name: "/a b", content }];
  createStoredZip(files);
  assert.deepEqual(files, [{ name: "/a b", content: Buffer.from([0, 1, 255]) }]);
  assert.equal(files[0].content, content);
});

test("returned archive owns its bytes independently of input buffers", () => {
  const content = Buffer.from("original");
  const zip = createStoredZip([{ name: "a", content }]);
  content.fill(0);
  assert.equal(entries(zip)[0].content.toString(), "original");
});

test("repeated calls remain deterministic and return independent buffers", () => {
  const files = [{ name: "notes.txt", content: "123456789" }];
  const first = createStoredZip(files);
  createStoredZip([{ name: "other", content: Buffer.from([255, 0]) }]);
  const second = createStoredZip(files);
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  first.fill(0);
  assert.equal(entries(second)[0].checksum, 0xcbf43926);
});

test("maximum 16-bit filename length is preserved", () => {
  const name = "a".repeat(65535);
  assert.equal(entries(createStoredZip([{ name, content: "" }]))[0].name, name);
});

test("oversized normalized filename retains the native range error", () => {
  assert.throws(() => createStoredZip([{ name: "a".repeat(65536), content: "" }]), { name: "RangeError", code: "ERR_OUT_OF_RANGE" });
  assert.equal(entries(createStoredZip([{ name: "ж".repeat(65536), content: "" }]))[0].name, "-");
});

test("entry count exceeding the 16-bit field retains the native range error", () => {
  const files = Array.from({ length: 65536 }, () => ({ name: "", content: "" }));
  assert.throws(() => createStoredZip(files), { name: "RangeError", code: "ERR_OUT_OF_RANGE" });
});
