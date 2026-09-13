import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachment, json, serveStatic, text } from "./http-responses.js";

// Capture the helper's exact calls separately from headers added by node:http.
function capture() {
  const calls: unknown[][] = [];
  const response = {
    writeHead(status: number, headers: Record<string, string>) { calls.push(["writeHead", status, headers]); },
    end(body: unknown) { calls.push(["end", body]); }
  } as unknown as ServerResponse;
  return { response, calls };
}

function withCors(value: string | undefined, run: () => void): void {
  const before = process.env.API_CORS_ORIGIN;
  try {
    if (value === undefined) delete process.env.API_CORS_ORIGIN;
    else process.env.API_CORS_ORIGIN = value;
    run();
  } finally {
    if (before === undefined) delete process.env.API_CORS_ORIGIN;
    else process.env.API_CORS_ORIGIN = before;
  }
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-request-id,x-vrata-admin-token,x-vrata-internal-token,x-noah-admin-token,x-noah-internal-token",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store"
};

function commonHeaders(contentType: string, origin = "*") {
  return {
    "content-type": contentType,
    "access-control-allow-origin": origin,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store"
  };
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vrata-http-responses-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function roundTrip(handle: (response: ServerResponse) => void | Promise<void>, method = "GET") {
  const server = createServer((_request, response) => {
    Promise.resolve().then(() => handle(response)).catch(() => {
      response.statusCode = 500;
      response.end("failed");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await new Promise<{ status: number | undefined; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: address.port, method, agent: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(5000, () => req.destroy(new Error("HTTP test timed out")));
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("JSON writes the original status, ordered headers and compact UTF-8 body", () => {
  withCors(undefined, () => {
    const { response, calls } = capture();
    assert.equal(json(response, 201, { z: "Привет", a: [false, null, 1] }), undefined);
    assert.deepEqual(calls, [["writeHead", 201, jsonHeaders], ["end", '{"z":"Привет","a":[false,null,1]}']]);
    assert.deepEqual(Object.keys(calls[0]?.[2] as object), Object.keys(jsonHeaders));
  });
});

test("JSON preserves primitive, undefined and nonfinite serialization", () => {
  for (const [input, expected] of [[null, "null"], [false, "false"], [42, "42"], ["hi", '"hi"'], [undefined, undefined], [NaN, "null"], [Infinity, "null"]]) {
    const { response, calls } = capture();
    json(response, 200, input);
    assert.deepEqual(calls[1], ["end", expected]);
  }
});

test("JSON calls toJSON once after writing headers", () => {
  const { response, calls } = capture();
  let count = 0;
  json(response, 202, { toJSON() { count += 1; assert.equal(calls.length, 1); return { ok: true }; } });
  assert.equal(count, 1);
  assert.deepEqual(calls[1], ["end", '{"ok":true}']);
});

test("JSON serialization errors propagate after headers without ending the response", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  for (const body of [circular, 1n]) {
    const { response, calls } = capture();
    assert.throws(() => json(response, 200, body), TypeError);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "writeHead");
  }
});

test("JSON retains the original exception thrown by toJSON", () => {
  const { response, calls } = capture();
  const error = new Error("serialization failed");
  assert.throws(() => json(response, 200, { toJSON() { throw error; } }), (value) => value === error);
  assert.equal(calls.length, 1);
});

test("text writes default headers and passes the body unchanged", () => {
  withCors(undefined, () => {
    const { response, calls } = capture();
    assert.equal(text(response, 503, "Привет\n<raw>"), undefined);
    assert.deepEqual(calls, [["writeHead", 503, commonHeaders("text/plain; charset=utf-8")], ["end", "Привет\n<raw>"]]);
  });
});

test("text accepts custom and empty content types without adding JSON-only headers", () => {
  withCors(undefined, () => {
    for (const contentType of ["text/plain; version=0.0.4", "text/html", ""]) {
      const { response, calls } = capture();
      text(response, 200, "", contentType);
      assert.deepEqual(calls, [["writeHead", 200, commonHeaders(contentType)], ["end", ""]]);
    }
  });
});

test("attachments preserve Buffer identity, status and header order", () => {
  withCors(undefined, () => {
    const { response, calls } = capture();
    const body = Buffer.from([0, 255, 128, 10]);
    assert.equal(attachment(response, 206, body, "file_1.2-3.zip", "application/zip"), undefined);
    const headers = {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="file_1.2-3.zip"',
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store"
    };
    assert.deepEqual(calls, [["writeHead", 206, headers], ["end", body]]);
    assert.strictEqual(calls[1]?.[1], body);
    assert.deepEqual(Object.keys(calls[0]?.[2] as object), Object.keys(headers));
  });
});

test("attachment filenames replace each invalid run without trimming or fallback", () => {
  for (const [name, expected] of [["  отчёт / \"<x>\r\n.pdf", "-x-.pdf"], ["", ""], ["...", "..."], ["😀😀", "-"], ["a b/c\\d", "a-b-c-d"]] as const) {
    const { response, calls } = capture();
    attachment(response, 200, "raw\nтекст", name, "text/markdown");
    assert.equal((calls[0]?.[2] as Record<string, string>)["content-disposition"], `attachment; filename="${expected}"`);
    assert.deepEqual(calls[1], ["end", "raw\nтекст"]);
  }
});

for (const origin of [undefined, "https://example.test", "", " https://example.test "]) {
  test(`response helpers read CORS at call time and preserve ${JSON.stringify(origin)}`, () => {
    withCors(origin, () => {
      for (const send of [
        (r: ServerResponse) => json(r, 200, {}),
        (r: ServerResponse) => text(r, 200, ""),
        (r: ServerResponse) => attachment(r, 200, "", "a", "text/plain")
      ]) {
        const { response, calls } = capture();
        send(response);
        assert.equal((calls[0]?.[2] as Record<string, string>)["access-control-allow-origin"], origin ?? "*");
      }
    });
  });
}

test("response helpers propagate writeHead and end failures unchanged", () => {
  for (const send of [
    (r: ServerResponse) => json(r, 400, {}),
    (r: ServerResponse) => text(r, 400, ""),
    (r: ServerResponse) => attachment(r, 400, "", "a", "text/plain")
  ]) {
    for (const method of ["writeHead", "end"] as const) {
      const { response, calls } = capture();
      const error = new Error(method);
      Object.assign(response, { [method]: () => { throw error; } });
      assert.throws(() => send(response), (value) => value === error);
      assert.equal(calls.length, method === "writeHead" ? 0 : 1);
    }
  }
});

for (const [extension, type] of [
  [".HTML", "text/html; charset=utf-8"], [".js", "application/javascript; charset=utf-8"],
  [".MJS", "application/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".JSON", "application/json; charset=utf-8"], [".svg", "image/svg+xml"],
  [".png", "application/octet-stream"], [".glb", "application/octet-stream"], ["", "application/octet-stream"]
]) {
  test(`static files retain the original MIME mapping for ${extension || "no extension"}`, async () => {
    await fixture(async (root) => {
      const path = join(root, `file${extension}`);
      const body = Buffer.from("Привет\n");
      await writeFile(path, body);
      const { response, calls } = capture();
      assert.equal(await serveStatic(response, path), true);
      assert.deepEqual(calls, [["writeHead", 200, { "content-type": type, "content-length": String(body.length) }], ["end", body]]);
    });
  });
}

test("missing static files return false without touching the response", async () => {
  await fixture(async (root) => {
    const { response, calls } = capture();
    assert.equal(await serveStatic(response, join(root, "absent.html")), false);
    assert.deepEqual(calls, []);
  });
});

test("empty and arbitrary binary static files are returned byte-for-byte", async () => {
  await fixture(async (root) => {
    for (const body of [Buffer.alloc(0), Buffer.from([0, 255, 128, 10])]) {
      const path = join(root, "binary");
      await writeFile(path, body);
      const { response, calls } = capture();
      assert.equal(await serveStatic(response, path), true);
      assert.deepEqual(calls[1], ["end", body]);
      assert.equal((calls[0]?.[2] as Record<string, string>)["content-length"], String(body.length));
    }
  });
});

test("static path normalization and symlink lookup retain their original semantics", async () => {
  await fixture(async (root) => {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "target"), "linked");
    await symlink(join(root, "target"), join(root, "link.css"));
    const { response, calls } = capture();
    assert.equal(await serveStatic(response, `${root}/dir/../link.css`), true);
    assert.deepEqual(calls, [["writeHead", 200, { "content-type": "text/css; charset=utf-8", "content-length": "6" }], ["end", Buffer.from("linked")]]);
  });
});

test("static directory read failures reject without sending headers or a body", async () => {
  await fixture(async (root) => {
    const { response, calls } = capture();
    await assert.rejects(serveStatic(response, root), { code: "EISDIR" });
    assert.deepEqual(calls, []);
  });
});

test("static response failures reject with the original exception", async () => {
  await fixture(async (root) => {
    const path = join(root, "file");
    await writeFile(path, "ok");
    for (const method of ["writeHead", "end"] as const) {
      const { response, calls } = capture();
      const error = new Error(method);
      Object.assign(response, { [method]: () => { throw error; } });
      await assert.rejects(serveStatic(response, path), (value) => value === error);
      assert.equal(calls.length, method === "writeHead" ? 0 : 1);
    }
  });
});

test("real HTTP JSON keeps an existing request ID and sends the expected bytes", async () => {
  const result = await roundTrip((response) => {
    response.setHeader("x-request-id", "request-123");
    json(response, 201, { message: "Привет" });
  });
  assert.equal(result.status, 201);
  assert.equal(result.headers["x-request-id"], "request-123");
  assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(result.body, Buffer.from('{"message":"Привет"}'));
});

test("real HTTP text and attachment responses preserve their bodies", async () => {
  const plain = await roundTrip((response) => text(response, 202, "текст\n", "text/markdown"));
  assert.equal(plain.status, 202);
  assert.equal(plain.headers["content-type"], "text/markdown");
  assert.deepEqual(plain.body, Buffer.from("текст\n"));
  const body = Buffer.from([0, 255, 128, 10]);
  const file = await roundTrip((response) => attachment(response, 200, body, "report file.zip", "application/zip"));
  assert.equal(file.headers["content-disposition"], 'attachment; filename="report-file.zip"');
  assert.deepEqual(file.body, body);
});

test("real HTTP static GET and HEAD retain length, bytes and request ID", async () => {
  await fixture(async (root) => {
    const path = join(root, "index.html");
    const body = Buffer.from("<h1>Привет</h1>");
    await writeFile(path, body);
    for (const method of ["GET", "HEAD"]) {
      const result = await roundTrip(async (response) => {
        response.setHeader("x-request-id", "static-123");
        assert.equal(await serveStatic(response, path), true);
      }, method);
      assert.equal(result.status, 200);
      assert.equal(result.headers["x-request-id"], "static-123");
      assert.equal(result.headers["content-length"], String(body.length));
      assert.equal(result.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(result.headers["access-control-allow-origin"], undefined);
      assert.equal(result.headers["cache-control"], undefined);
      assert.deepEqual(result.body, method === "HEAD" ? Buffer.alloc(0) : body);
    }
  });
});

test("a missing static file leaves the real HTTP response available for a fallback", async () => {
  await fixture(async (root) => {
    const result = await roundTrip(async (response) => {
      if (!await serveStatic(response, join(root, "missing"))) text(response, 404, "not found");
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.toString(), "not found");
  });
});
