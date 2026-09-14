import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  trimSlashes,
  sha256Hex,
  writeDocumentObject,
  deleteDocumentObject,
  resolveUploadedDocumentPublicUrl,
  readDocumentObject,
  publishSceneBundleFiles,
  resolveUploadedSceneBundlePublicUrl
} from "./uploaded-object-storage.js";
import type { DocumentUploadStorage } from "./upload-storage-config.js";

type LocalStorage = Extract<DocumentUploadStorage, { type: "local" }>;
type S3Storage = Extract<DocumentUploadStorage, { type: "s3" }>;

const s3: S3Storage = {
  type: "s3", provider: "s3-compatible", endpoint: "https://s3.example.invalid:9443/base",
  region: "test-region-1", bucket: "/test-bucket///", accessKeyId: "test-access-key", secretAccessKey: "test-secret-key"
};
const payload = Buffer.from([0, 1, 127, 128, 255]);
const objectUrl = "https://s3.example.invalid:9443/base/test-bucket/folder/a%20b%23%25.bin";
const putAuthorization = "AWS4-HMAC-SHA256 Credential=test-access-key/20200102/test-region-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=eb2a7ac066c5674d09ef9ff5a2edcecd8a5040d934527bdf4c6d35268e715358";
const deleteAuthorization = "AWS4-HMAC-SHA256 Credential=test-access-key/20200102/test-region-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=5023b07e5b880fe5f980624f5d5c1a0b6fa437ab7e4afdb653500ba364223911";

async function temporaryDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vrata-object-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function localStorage(t: TestContext): Promise<LocalStorage> {
  return { type: "local", provider: "minio-default", root: join(await temporaryDirectory(t), "objects"), publicBaseUrl: "https://assets.example.invalid/uploaded" };
}

function fixedDate(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2020-01-02T03:04:05.678Z") });
}

function setPublicStorageEnv(t: TestContext, values: Record<string, string> = {}): void {
  const keys = ["SCENE_BUNDLE_PROVIDER", "MINIO_PUBLIC_BASE_URL", "MINIO_BUCKET", "SCENE_BUNDLE_S3_PUBLIC_BASE_URL", "SCENE_BUNDLE_S3_BUCKET", "SCENE_BUNDLE_S3_ENDPOINT", "SCENE_BUNDLE_S3_REGION"];
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function captureFetch(t: TestContext, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status });
  });
  return calls;
}

function forbidFetch(t: TestContext): void {
  t.mock.method(globalThis, "fetch", () => assert.fail("local storage must not call fetch"));
}

test("slash trimming preserves inner slashes, whitespace and empty values", () => {
  for (const [input, expected] of [["///a//b///", "a//b"], ["////", ""], ["", ""], [" /a/ ", " /a/ "], ["a\\b", "a\\b"]]) {
    assert.equal(trimSlashes(input), expected);
  }
});

test("checksums preserve string and binary hashing", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(sha256Hex(Buffer.from("hello")), sha256Hex("hello"));
  assert.equal(sha256Hex(payload), "0150a92bb1212cd00516b65fde0704614760000963874fcbb11eaa734ee87809");
});

test("local document storage creates parents, preserves bytes and overwrites files", async (t) => {
  forbidFetch(t);
  const storage = await localStorage(t);
  const key = "tenant/room/файл #1.bin";
  assert.equal(await writeDocumentObject(storage, key, payload, "application/octet-stream"), undefined);
  assert.deepEqual(await readFile(join(storage.root, key)), payload);
  const read = await readDocumentObject(storage, key);
  assert.equal(Buffer.isBuffer(read), true);
  assert.deepEqual(read, payload);
  await writeDocumentObject(storage, key, Buffer.alloc(0), "text/plain");
  assert.deepEqual(await readDocumentObject(storage, key), Buffer.alloc(0));
});

test("local deletion removes only the file and tolerates missing files", async (t) => {
  forbidFetch(t);
  const storage = await localStorage(t);
  await writeDocumentObject(storage, "nested/file.bin", payload, "application/octet-stream");
  assert.equal(await deleteDocumentObject(storage, "nested/file.bin"), undefined);
  assert.deepEqual(await readdir(join(storage.root, "nested")), []);
  assert.equal(await deleteDocumentObject(storage, "nested/file.bin"), undefined);
  await assert.rejects(readDocumentObject(storage, "nested/file.bin"), { code: "ENOENT" });
});

test("local filesystem errors propagate without being converted to upload errors", async (t) => {
  const storage = await localStorage(t);
  await mkdir(join(storage.root, "directory"), { recursive: true });
  await assert.rejects(writeDocumentObject(storage, "directory", payload, "text/plain"), { code: "EISDIR" });
  await assert.rejects(deleteDocumentObject(storage, "directory"), { code: "ERR_FS_EISDIR" });
  await assert.rejects(readDocumentObject(storage, "missing.bin"), { code: "ENOENT" });
});

for (const operation of ["write", "read", "delete"] as const) {
  test(`local ${operation} rejects keys outside the root, including prefix collisions`, async (t) => {
    forbidFetch(t);
    const storage = await localStorage(t);
    for (const key of ["", ".", "..", "../outside.bin", "../objects-other/file.bin", "nested/../../outside.bin"]) {
      const result = operation === "write" ? writeDocumentObject(storage, key, payload, "text/plain")
        : operation === "read" ? readDocumentObject(storage, key) : deleteDocumentObject(storage, key);
      await assert.rejects(result, { message: "unsafe_document_storage_key" });
    }
  });
}

test("local public URLs encode path segments and preserve endpoint slash behavior", async (t) => {
  const storage = await localStorage(t);
  for (const resolveUrl of [resolveUploadedDocumentPublicUrl, resolveUploadedSceneBundlePublicUrl]) {
    for (const publicBaseUrl of [storage.publicBaseUrl, `${storage.publicBaseUrl}/`]) {
      assert.equal(resolveUrl({ ...storage, publicBaseUrl }, "folder/a b#%.bin"), "https://assets.example.invalid/uploaded/folder/a%20b%23%25.bin");
      assert.equal(resolveUrl({ ...storage, publicBaseUrl }, ""), "https://assets.example.invalid/uploaded/");
    }
  }
});

test("remote public URLs use provider configuration and read the environment on each call", (t) => {
  setPublicStorageEnv(t, {
    MINIO_PUBLIC_BASE_URL: "https://minio-public.example.invalid///", MINIO_BUCKET: "/public-bucket",
    SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://cdn.example.invalid/base/", SCENE_BUNDLE_S3_BUCKET: "configured-bucket",
    SCENE_BUNDLE_S3_ENDPOINT: "https://internal.example.invalid", SCENE_BUNDLE_S3_REGION: "region"
  });
  for (const resolveUrl of [resolveUploadedDocumentPublicUrl, resolveUploadedSceneBundlePublicUrl]) {
    assert.equal(resolveUrl({ ...s3, provider: "minio-default" }, "/folder/a b.bin"), "https://minio-public.example.invalid/public-bucket/folder/a b.bin");
    assert.equal(resolveUrl(s3, "/folder/a b.bin"), "https://cdn.example.invalid/base/folder/a b.bin");
    assert.throws(() => resolveUrl(s3, " "), { message: "invalid_scene_bundle_storage_key" });
  }
  process.env.SCENE_BUNDLE_S3_PUBLIC_BASE_URL = "https://changed.example.invalid";
  assert.equal(resolveUploadedDocumentPublicUrl(s3, "file"), "https://changed.example.invalid/file");
  delete process.env.SCENE_BUNDLE_S3_REGION;
  assert.throws(() => resolveUploadedSceneBundlePublicUrl(s3, "file"), { message: "misconfigured_storage_provider:s3-compatible" });
});

test("S3 document PUT preserves the complete signed request and binary body", async (t) => {
  fixedDate(t);
  const calls = captureFetch(t);
  assert.equal(await writeDocumentObject(s3, "folder/a b#%.bin", payload, "application/octet-stream"), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, objectUrl);
  assert.deepEqual(calls[0].init, {
    method: "PUT", headers: { authorization: putAuthorization, "content-type": "application/octet-stream", "x-amz-content-sha256": "0150a92bb1212cd00516b65fde0704614760000963874fcbb11eaa734ee87809", "x-amz-date": "20200102T030405Z" },
    body: new Uint8Array(payload)
  });
  assert.notEqual(calls[0].init?.body, payload);
});

test("S3 signatures trim header values without changing transmitted content type", async (t) => {
  fixedDate(t);
  const calls = captureFetch(t);
  await writeDocumentObject({ ...s3, endpoint: `${s3.endpoint}/` }, "folder/a b#%.bin", payload, " application/octet-stream ");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(calls[0].url, objectUrl);
  assert.equal(headers.authorization, putAuthorization);
  assert.equal(headers["content-type"], " application/octet-stream ");
});

test("S3 document PUT handles empty files and escapes Unicode key segments", async (t) => {
  fixedDate(t);
  const calls = captureFetch(t, 204);
  await writeDocumentObject(s3, "папка/файл.txt", Buffer.alloc(0), "text/plain");
  assert.equal(calls[0].url, "https://s3.example.invalid:9443/base/test-bucket/%D0%BF%D0%B0%D0%BF%D0%BA%D0%B0/%D1%84%D0%B0%D0%B9%D0%BB.txt");
  assert.deepEqual(calls[0].init?.body, new Uint8Array(0));
  assert.equal((calls[0].init?.headers as Record<string, string>)["x-amz-content-sha256"], sha256Hex(""));
});

test("S3 PUT failures preserve document-specific status errors and do not retry", async (t) => {
  let calls = 0;
  for (const status of [301, 403, 404, 500]) {
    t.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response(null, { status }); });
    await assert.rejects(writeDocumentObject(s3, "file", payload, "text/plain"), { message: `document_object_upload_failed:${status}` });
  }
  assert.equal(calls, 4);
});

test("S3 DELETE preserves its signed empty-body request and accepts a missing object", async (t) => {
  fixedDate(t);
  const calls = captureFetch(t, 404);
  assert.equal(await deleteDocumentObject(s3, "folder/a b#%.bin"), undefined);
  assert.deepEqual(calls, [{ url: objectUrl, init: {
    method: "DELETE", headers: { authorization: deleteAuthorization, "x-amz-content-sha256": sha256Hex(""), "x-amz-date": "20200102T030405Z" }
  } }]);
});

test("S3 DELETE accepts success and rejects other statuses without retries", async (t) => {
  let calls = 0;
  for (const status of [200, 204, 403, 500]) {
    t.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response(null, { status }); });
    const result = deleteDocumentObject(s3, "file");
    if (status < 300) assert.equal(await result, undefined);
    else await assert.rejects(result, { message: `document_object_delete_failed:${status}` });
  }
  assert.equal(calls, 4);
});

test("S3 transport rejections retain their original identity", async (t) => {
  for (const failure of [new Error("network down"), { reason: "offline" }, undefined]) {
    t.mock.method(globalThis, "fetch", async () => { throw failure; });
    for (const operation of [() => writeDocumentObject(s3, "file", payload, "text/plain"), () => deleteDocumentObject(s3, "file")]) {
      await operation().then(() => assert.fail("expected rejection"), (error: unknown) => assert.equal(error, failure));
    }
  }
});

test("remote document reads use the public URL without write credentials and return a Buffer", async (t) => {
  setPublicStorageEnv(t, { MINIO_PUBLIC_BASE_URL: "https://public.example.invalid", MINIO_BUCKET: "documents" });
  const calls: unknown[][] = [];
  t.mock.method(globalThis, "fetch", async (...args: unknown[]) => { calls.push(args); return new Response(new Uint8Array(payload)); });
  const result = await readDocumentObject({ ...s3, provider: "minio-default" }, "room/file.bin");
  assert.equal(Buffer.isBuffer(result), true);
  assert.deepEqual(result, payload);
  assert.deepEqual(calls, [["https://public.example.invalid/documents/room/file.bin"]]);
});

test("remote read status, network and response-body errors propagate", async (t) => {
  setPublicStorageEnv(t, { MINIO_PUBLIC_BASE_URL: "https://public.example.invalid", MINIO_BUCKET: "documents" });
  const storage = { ...s3, provider: "minio-default" as const };
  for (const status of [403, 404, 500]) {
    captureFetch(t, status);
    await assert.rejects(readDocumentObject(storage, "file"), { message: `document_object_download_failed:${status}` });
  }
  const failure = new Error("read failed");
  t.mock.method(globalThis, "fetch", async () => { throw failure; });
  await assert.rejects(readDocumentObject(storage, "file"), (error) => error === failure);
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, arrayBuffer: async () => { throw failure; } }));
  await assert.rejects(readDocumentObject(storage, "file"), (error) => error === failure);
});

test("scene publication recursively copies files, skips symlinks and overwrites destinations", async (t) => {
  forbidFetch(t);
  const storage = await localStorage(t);
  const source = await temporaryDirectory(t);
  await mkdir(join(source, "nested"));
  await writeFile(join(source, "scene.json"), "{}");
  await writeFile(join(source, "nested", "scene.glb"), payload);
  await symlink(join(source, "scene.json"), join(source, "linked.json"));
  await symlink(join(source, "nested"), join(source, "linked-directory"));
  await writeDocumentObject(storage, "scenes/v1/nested/scene.glb", Buffer.from("old"), "text/plain");
  assert.equal(await publishSceneBundleFiles(storage, source, "scenes/v1"), undefined);
  assert.deepEqual(await readdir(join(storage.root, "scenes/v1")), ["nested", "scene.json"]);
  assert.deepEqual(await readFile(join(storage.root, "scenes/v1/nested/scene.glb")), payload);
  assert.equal(await readFile(join(storage.root, "scenes/v1/scene.json"), "utf8"), "{}");
  assert.deepEqual(await readFile(join(source, "nested/scene.glb")), payload);
});

test("scene publication rejects unsafe destination prefixes and invalid source names", async (t) => {
  const storage = await localStorage(t);
  const source = await temporaryDirectory(t);
  await writeFile(join(source, "scene.json"), "{}");
  await assert.rejects(publishSceneBundleFiles(storage, source, "../outside"), { message: "unsafe_scene_bundle_file_path" });
  await rm(join(source, "scene.json"));
  await writeFile(join(source, "bad\\name.glb"), payload);
  const calls = captureFetch(t);
  for (const target of [storage, s3]) {
    await assert.rejects(publishSceneBundleFiles(target, source, "scenes/v1"), { message: "unsafe_scene_bundle_file_path" });
  }
  assert.equal(calls.length, 0);
});

test("empty scene directories perform no uploads and missing directories retain filesystem errors", async (t) => {
  const source = await temporaryDirectory(t);
  const calls = captureFetch(t);
  await publishSceneBundleFiles(s3, source, "scenes/v1");
  assert.equal(calls.length, 0);
  await assert.rejects(publishSceneBundleFiles(s3, join(source, "missing"), "scenes/v1"), { code: "ENOENT" });
});

test("S3 scene publication preserves MIME types, nested keys, bytes and sequential execution", async (t) => {
  fixedDate(t);
  const source = await temporaryDirectory(t);
  const types: Record<string, string> = { json: "application/json", glb: "model/gltf-binary", gltf: "model/gltf+json", fbx: "application/octet-stream", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", ktx2: "image/ktx2", other: "application/octet-stream" };
  await mkdir(join(source, "nested"));
  for (const extension of Object.keys(types)) await writeFile(join(source, "nested", `file.${extension.toUpperCase()}`), payload);
  let active = 0;
  let maximumActive = 0;
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const url = new URL(String(input));
    const extension = url.pathname.split(".").at(-1)!.toLowerCase();
    assert.equal(url.pathname, `/base/test-bucket/scenes/v1/nested/file.${extension.toUpperCase()}`);
    assert.equal(init?.method, "PUT");
    assert.equal((init?.headers as Record<string, string>)["content-type"], types[extension]);
    assert.deepEqual(init?.body, new Uint8Array(payload));
    seen.push(extension);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return new Response(null, { status: 200 });
  });
  await publishSceneBundleFiles(s3, source, "scenes/v1");
  assert.deepEqual(seen, Object.keys(types).sort());
  assert.equal(maximumActive, 1);
});

test("scene upload failure stops publication immediately with its original error prefix", async (t) => {
  const source = await temporaryDirectory(t);
  await writeFile(join(source, "a.json"), "{}");
  await writeFile(join(source, "b.glb"), payload);
  const calls = captureFetch(t, 503);
  await assert.rejects(publishSceneBundleFiles(s3, source, "scenes/v1"), { message: "scene_bundle_object_upload_failed:503" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://s3.example.invalid:9443/base/test-bucket/scenes/v1/a.json");
});
