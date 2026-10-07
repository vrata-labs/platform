import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { validateRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { pluginHttpFixture } from "./http-test-helper.js";
import { readRoomPluginRequestBytes } from "./request-body.js";

function request(headers: Record<string, string> = {}) {
  const request = new IncomingMessage(new Socket()); request.headers = headers; return request;
}
test("raw reader preserves byte-exact whitespace and arbitrary chunk boundaries", async () => {
  const fixture = pluginHttpFixture();
  const bytes = Buffer.concat([Buffer.from(" \n"), fixture.bytes, Buffer.from(" \r\n")]);
  const req = request({ "content-length": String(bytes.length) });
  const pending = readRoomPluginRequestBytes(req, bytes.length);
  req.push(bytes.subarray(0, 3)); req.push(bytes.subarray(3, 20)); req.push(bytes.subarray(20)); req.push(null);
  const output = await pending;
  assert.deepEqual(output, new Uint8Array(bytes));
  assert.equal(validateRoomPluginArtifact(output).byteLength, bytes.length);
  assert.equal(req.listenerCount("data"), 0); assert.equal(req.listenerCount("aborted"), 0);
});
test("Content-Length overflow is denied without starting body consumption", async () => {
  const req = request({ "content-length": "1048577" });
  await assert.rejects(readRoomPluginRequestBytes(req, 1048576), { code: "plugin_body_too_large" });
  assert.equal(req.listenerCount("data"), 0); assert.equal(req.isPaused(), true);
});
test("chunked overflow checks the actual bytes before copying and stops subsequent chunks", async () => {
  const req = request({ "transfer-encoding": "chunked" });
  const pending = readRoomPluginRequestBytes(req, 8);
  req.push(Buffer.alloc(4)); req.push(Buffer.alloc(5)); req.push(Buffer.alloc(100));
  await assert.rejects(pending, { code: "plugin_body_too_large" });
  assert.equal(req.isPaused(), true); assert.equal(req.listenerCount("data"), 0);
});
test("invalid UTF-8 stays original bytes so the ordinary SDK rejects it instead of normalizing", async () => {
  const req = request(); const pending = readRoomPluginRequestBytes(req, 100);
  req.push(Buffer.from([0xc3, 0x28])); req.push(null);
  const output = await pending; assert.deepEqual(output, Uint8Array.of(0xc3, 0x28));
  assert.throws(() => validateRoomPluginArtifact(output), { code: "invalid_utf8" });
});
test("aborted/error/early-close uploads reject promptly and detach the consuming listeners", async () => {
  for (const event of ["aborted", "error", "close"]) {
    const req = request(); const pending = readRoomPluginRequestBytes(req, 100);
    req.push(Buffer.from("partial")); req.emit(event, new Error("private details"));
    await assert.rejects(pending, { code: "plugin_body_aborted" });
    assert.equal(req.listenerCount("data"), 0); assert.equal(req.listenerCount("aborted"), 0);
  }
});
test("a stalled chunked upload hits its bounded deadline", async () => {
  const req = request(); const pending = readRoomPluginRequestBytes(req, 100, 10);
  const rejected = assert.rejects(pending, { code: "plugin_body_timeout" });
  await delay(20); await rejected;
  assert.equal(req.isPaused(), true); assert.equal(req.listenerCount("data"), 0);
});
test("ambiguous framing, decoded streams and mismatched declared lengths fail closed", async () => {
  const framing: Record<string, string>[] = [{ "content-length": "5", "transfer-encoding": "chunked" }, { "content-length": "-1" }, { "content-length": "1, 1" }];
  for (const headers of framing) {
    await assert.rejects(readRoomPluginRequestBytes(request(headers), 10), { code: "plugin_body_invalid" });
  }
  const short = request({ "content-length": "5" }); const result = readRoomPluginRequestBytes(short, 10);
  short.push(Buffer.from("xx")); short.push(null);
  await assert.rejects(result, { code: "plugin_body_invalid" });
  const decoded = request(); decoded.setEncoding("utf8"); const data = readRoomPluginRequestBytes(decoded, 10);
  decoded.push(Buffer.from("xx")); decoded.push(null);
  await assert.rejects(data, { code: "plugin_body_invalid" });
});
