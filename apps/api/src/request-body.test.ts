import test from "node:test";
import assert from "node:assert/strict";
import { createServer, IncomingMessage, request as httpRequest } from "node:http";
import { Socket } from "node:net";

import { parseBody, readRequestBuffer } from "./request-body.js";

// Real IncomingMessage instances with explicitly emitted stream events keep
// chunk boundaries and error ordering deterministic without opening a socket.
function incoming(): IncomingMessage {
  return new IncomingMessage(new Socket());
}

function finish(request: IncomingMessage, chunks: Array<Buffer | string | Uint8Array>): void {
  for (const chunk of chunks) request.emit("data", chunk);
  request.emit("end");
}

test("JSON without data events resolves to null", async () => {
  const request = incoming();
  const result = parseBody(request);
  request.emit("end");
  assert.equal(await result, null);
  assert.equal(request.destroyed, false);
});

test("JSON accepts objects, arrays and primitive JSON values", async () => {
  for (const value of [{ nested: [1, true, null] }, [1, "two"], "text", 0, false, null]) {
    const request = incoming();
    const result = parseBody<unknown>(request);
    finish(request, [Buffer.from(JSON.stringify(value))]);
    assert.deepEqual(await result, value);
  }
});

test("JSON combines chunks before decoding split UTF-8 sequences", async () => {
  const value = { text: "Привет, 世界 😀" };
  const request = incoming();
  const result = parseBody<typeof value>(request);
  finish(request, Array.from(Buffer.from(JSON.stringify(value)), (byte) => Buffer.from([byte])));
  assert.deepEqual(await result, value);
});

test("JSON accepts string and Uint8Array chunks", async () => {
  const request = incoming();
  const result = parseBody<{ value: number }>(request);
  finish(request, ['{"value":', new Uint8Array([52, 50]), "}"]);
  assert.deepEqual(await result, { value: 42 });
});

test("JSON copies each buffer when the data event is received", async () => {
  const request = incoming();
  const result = parseBody(request);
  const chunk = Buffer.from('{"value":1}');
  request.emit("data", chunk);
  chunk.fill(0);
  request.emit("end");
  assert.deepEqual(await result, { value: 1 });
});

test("JSON permits exactly 64 KiB including surrounding whitespace", async () => {
  const request = incoming();
  const result = parseBody(request);
  finish(request, [Buffer.from("0" + " ".repeat(64 * 1024 - 1))]);
  assert.equal(await result, 0);
  assert.equal(request.destroyed, false);
});

test("JSON rejects one byte above the limit and destroys the request", async () => {
  const request = incoming();
  const result = parseBody(request);
  request.emit("data", Buffer.from("0" + " ".repeat(64 * 1024)));
  await assert.rejects(result, { message: "payload_too_large" });
  assert.equal(request.destroyed, true);
});

test("JSON enforces the cumulative byte limit across chunks", async () => {
  const request = incoming();
  const result = parseBody(request);
  request.emit("data", Buffer.from("0" + " ".repeat(32 * 1024 - 1)));
  request.emit("data", Buffer.alloc(32 * 1024, 32));
  assert.equal(request.destroyed, false);
  request.emit("data", Buffer.from(" "));
  await assert.rejects(result, { message: "payload_too_large" });
  assert.equal(request.destroyed, true);
});

test("JSON counts UTF-8 bytes rather than string length", async () => {
  const request = incoming();
  const result = parseBody(request);
  const value = JSON.stringify("я".repeat(32 * 1024));
  assert.ok(value.length < 64 * 1024);
  request.emit("data", value);
  await assert.rejects(result, { message: "payload_too_large" });
  assert.equal(request.destroyed, true);
});

test("empty data chunks, blank text, BOM and malformed JSON retain SyntaxError", async () => {
  for (const value of ["", " \t\r\n", "\ufeff{}", "{", "[1,]", "undefined"]) {
    const request = incoming();
    const result = parseBody(request);
    finish(request, [Buffer.from(value)]);
    await assert.rejects(result, SyntaxError);
    assert.equal(request.destroyed, false);
  }
});

test("JSON decoding retains replacement characters for malformed UTF-8", async () => {
  const request = incoming();
  const result = parseBody(request);
  finish(request, [Buffer.from([34, 255, 34])]);
  assert.equal(await result, "\ufffd");
});

test("JSON propagates the original stream error", async () => {
  const request = incoming();
  const result = parseBody(request);
  const failure = new Error("transport failed");
  request.emit("data", Buffer.from("{"));
  request.emit("error", failure);
  await assert.rejects(result, (error: unknown) => error === failure);
});

test("JSON oversize rejection is not replaced by later end or error events", async () => {
  const request = incoming();
  const result = parseBody(request);
  request.emit("data", Buffer.alloc(64 * 1024 + 1, 32));
  request.emit("end");
  request.emit("error", new Error("later error"));
  await assert.rejects(result, { message: "payload_too_large" });
});

test("buffer reader returns an empty Buffer for a request with no chunks", async () => {
  const request = incoming();
  const result = readRequestBuffer(request, 0);
  request.emit("end");
  assert.deepEqual(await result, Buffer.alloc(0));
  assert.equal(request.destroyed, false);
});

test("buffer reader preserves arbitrary bytes and chunk order", async () => {
  const request = incoming();
  const result = readRequestBuffer(request, 6);
  finish(request, [Buffer.from([0, 255]), Buffer.alloc(0), new Uint8Array([128, 1]), "ab"]);
  assert.deepEqual(await result, Buffer.from([0, 255, 128, 1, 97, 98]));
  assert.equal(request.destroyed, false);
});

test("buffer reader copies chunks and returns independent output storage", async () => {
  const request = incoming();
  const result = readRequestBuffer(request, 3);
  const chunk = Buffer.from([1, 2, 3]);
  request.emit("data", chunk);
  chunk.fill(9);
  request.emit("end");
  const body = await result;
  assert.deepEqual(body, Buffer.from([1, 2, 3]));
  body.fill(0);
  assert.deepEqual(chunk, Buffer.from([9, 9, 9]));
});

test("buffer reader accepts the limit and rejects the next byte cumulatively", async () => {
  const request = incoming();
  const result = readRequestBuffer(request, 3);
  request.emit("data", Buffer.from([1]));
  request.emit("data", Buffer.from([2, 3]));
  assert.equal(request.destroyed, false);
  request.emit("data", Buffer.from([4]));
  await assert.rejects(result, { message: "payload_too_large" });
  assert.equal(request.destroyed, true);
});

test("buffer reader rejects an oversized first chunk and zero-limit data", async () => {
  for (const limit of [0, 2]) {
    const request = incoming();
    const result = readRequestBuffer(request, limit);
    request.emit("data", Buffer.from([1, 2, 3]));
    await assert.rejects(result, { message: "payload_too_large" });
    assert.equal(request.destroyed, true);
  }
});

test("buffer reader counts encoded bytes in string chunks", async () => {
  const request = incoming();
  const result = readRequestBuffer(request, 1);
  request.emit("data", "я");
  await assert.rejects(result, { message: "payload_too_large" });
  assert.equal(request.destroyed, true);
});

test("buffer reader retains JavaScript comparison for special numeric limits", async () => {
  // Limit validation belongs to callers; this extraction does not add it.
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const request = incoming();
    const result = readRequestBuffer(request, limit);
    finish(request, [Buffer.from([1, 2, 3])]);
    assert.deepEqual(await result, Buffer.from([1, 2, 3]));
  }
  const request = incoming();
  const result = readRequestBuffer(request, -1);
  request.emit("data", Buffer.alloc(0));
  await assert.rejects(result, { message: "payload_too_large" });
  assert.equal(request.destroyed, true);
});

test("buffer reader propagates stream errors without returning partial data", async () => {
  const request = incoming();
  const result = readRequestBuffer(request, 10);
  const failure = new Error("transport failed");
  request.emit("data", Buffer.from([1]));
  request.emit("error", failure);
  request.emit("end");
  await assert.rejects(result, (error: unknown) => error === failure);
});

test("buffer oversize rejection survives subsequent end and error events", async () => {
  const request = incoming();
  const result = readRequestBuffer(request, 1);
  request.emit("data", Buffer.from([1, 2]));
  request.emit("end");
  request.emit("error", new Error("later error"));
  await assert.rejects(result, { message: "payload_too_large" });
});

async function overHttp(reader: (request: IncomingMessage) => Promise<Buffer>, chunks: Buffer[]): Promise<Buffer> {
  const server = createServer((request, response) => {
    void reader(request).then((body) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(body);
    }).catch((error: unknown) => {
      response.writeHead(400);
      response.end(error instanceof Error ? error.message : "unknown_error");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await new Promise<Buffer>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: address.port, method: "POST", agent: false }, (response) => {
        const received: Buffer[] = [];
        response.on("data", (chunk: Buffer) => received.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error(`unexpected_status:${response.statusCode}`));
          resolve(Buffer.concat(received));
        });
      });
      request.on("error", reject);
      for (const chunk of chunks) request.write(chunk);
      request.end();
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("JSON reader works with a real chunked HTTP IncomingMessage", { timeout: 5000 }, async () => {
  const value = { text: "HTTP Привет 😀", values: [1, false, null] };
  const bytes = Buffer.from(JSON.stringify(value));
  const result = await overHttp(async (request) => Buffer.from(JSON.stringify(await parseBody(request))), [bytes.subarray(0, 15), bytes.subarray(15)]);
  assert.deepEqual(JSON.parse(result.toString("utf8")), value);
});

test("buffer reader works with real chunked HTTP at the exact limit", { timeout: 5000 }, async () => {
  const bytes = Buffer.from([0, 255, 1, 2, 128, 13, 10]);
  const result = await overHttp((request) => readRequestBuffer(request, bytes.length), [bytes.subarray(0, 2), bytes.subarray(2)]);
  assert.deepEqual(result, bytes);
});
