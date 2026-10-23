import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ROOM_PLUGIN_LIMITS } from "@vrata/room-plugin-sdk";
import { createRoomPluginBlobStorage, configuredRoomPluginBlobStorage, RoomPluginBlobWriteUncertain } from "./blob-storage.js";
import { roomPluginPrefix } from "./storage.js";
import type { DocumentUploadStorage } from "../upload-storage-config.js";
import { writeDocumentObject } from "../uploaded-object-storage.js";
import { RoomPluginBlobConfigurationError, RoomPluginBlobIoError } from "./blob-errors.js";

function ioFailure(operation: "put" | "read" | "delete", expectedCause: string) {
  return (error: unknown) => {
    assert.ok(error instanceof RoomPluginBlobIoError); assert.equal(error.operation, operation);
    const cause = error.cause as Error & { code?: string };
    assert.equal(cause.code ?? cause.message, expectedCause); return true;
  };
}

const scope = { tenantId: "tenant/../../A", roomId: "../room/α" };
const key = `${roomPluginPrefix(scope)}${randomUUID()}/${"a".repeat(64)}.vrata-plugin.json`;

test("plugin local wrapper keeps exact bytes and rejects cross-room/path keys before IO", async t => {
  const root = await mkdtemp(join(tmpdir(), "plugin-objects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: DocumentUploadStorage = { type: "local", provider: "minio-default", root, publicBaseUrl: "http://unused/" };
  const adapter = createRoomPluginBlobStorage(config);
  const bytes = Buffer.from(" \r\nutf8 α \n");
  await adapter.put(scope, key, bytes);
  assert.deepEqual(await adapter.read(scope, key), bytes);
  for (const bad of ["../secret", `${roomPluginPrefix(scope)}../secret`, key.replace("room-plugins/", "documents/")]) {
    await assert.rejects(adapter.read(scope, bad), /unsafe_plugin_storage_key/);
    await assert.rejects(adapter.put(scope, bad, bytes), /unsafe_plugin_storage_key/);
    await assert.rejects(adapter.delete(scope, bad), /unsafe_plugin_storage_key/);
  }
  await assert.rejects(adapter.read({ ...scope, roomId: "different" }, key), /unsafe_plugin_storage_key/);
  await assert.rejects(adapter.put(scope, key, bytes), RoomPluginBlobWriteUncertain);
  await assert.rejects(adapter.put(scope, key, new Uint8Array(ROOM_PLUGIN_LIMITS.artifactBytes + 1)), /plugin_object_too_large/);
  // Simulate external storage corruption, rather than let the plugin wrapper overwrite immutable objects.
  await writeDocumentObject(config, key, Buffer.alloc(ROOM_PLUGIN_LIMITS.artifactBytes + 1), "application/octet-stream");
  await assert.rejects(adapter.read(scope, key), ioFailure("read", "private_object_too_large"));
  await adapter.delete(scope, key);
  await adapter.delete(scope, key);
  await assert.rejects(adapter.read(scope, key), ioFailure("read", "ENOENT"));
});

const s3: DocumentUploadStorage = { type: "s3", provider: "s3-compatible", endpoint: "https://objects.example.test/",
  region: "test-region", bucket: "private-bucket", accessKeyId: "storage-key", secretAccessKey: "not-public" };

test("plugin S3 wrapper signs private reads, uses octet-stream, bounds response and distinguishes uncertain PUT", async t => {
  const requests: { url: string; options: RequestInit }[] = [];
  let response: () => Response = () => new Response("original bytes");
  t.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit) => {
    requests.push({ url: String(url), options }); return response();
  });
  const adapter = createRoomPluginBlobStorage(s3);
  await adapter.put(scope, key, Buffer.from("original bytes"));
  assert.equal(new Headers(requests[0].options.headers).get("content-type"), "application/octet-stream");
  assert.ok(new Headers(requests[0].options.headers).get("authorization")?.includes("AWS4-HMAC-SHA256"));
  assert.equal(new Headers(requests[0].options.headers).get("if-none-match"), "*");
  assert.deepEqual(await adapter.read(scope, key), Buffer.from("original bytes"));
  assert.ok(requests[1].url.startsWith("https://objects.example.test/private-bucket/room-plugins/"));
  assert.ok(new Headers(requests[1].options.headers).get("authorization")?.includes("storage-key/"));
  assert.equal(requests[1].options.method, undefined); // fetch's GET default, not a public CDN URL.
  response = () => new Response(new Uint8Array(ROOM_PLUGIN_LIMITS.artifactBytes + 1));
  await assert.rejects(adapter.read(scope, key), ioFailure("read", "private_object_too_large"));
  response = () => new Response(null, { status: 404 });
  await adapter.delete(scope, key);
  assert.equal(requests.at(-1)?.options.method, "DELETE");
  response = () => new Response(null, { status: 503 });
  await assert.rejects(adapter.put(scope, key, Buffer.from("bytes")), RoomPluginBlobWriteUncertain);
  response = () => { throw new Error("network reset with unknown PUT outcome"); };
  await assert.rejects(adapter.put(scope, key, Buffer.from("bytes")), RoomPluginBlobWriteUncertain);
});

test("configured local plugin objects are outside the publicly served runtime tree", async t => {
  const root = await mkdtemp(join(tmpdir(), "plugin-private-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  for (const name of ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "MINIO_BUCKET", "MINIO_PUBLIC_BASE_URL", "ROOM_PLUGIN_BUCKET", "ROOM_PLUGIN_LOCAL_UPLOAD_ROOT"]) delete process.env[name];
  process.env.NODE_ENV = "test";
  process.env.DOCUMENT_PROVIDER = "minio-default";
  const publicRoot = join(root, "runtime", "public");
  const adapter = configuredRoomPluginBlobStorage(publicRoot, {} as IncomingMessage, () => "https://app.example.test/");
  await adapter.put(scope, key, Buffer.from("private bytes"));
  const publicAdapter = createRoomPluginBlobStorage({ type: "local", provider: "minio-default", root: publicRoot, publicBaseUrl: "https://app.example.test/" });
  await assert.rejects(publicAdapter.read(scope, key), ioFailure("read", "ENOENT"));
  assert.deepEqual(await adapter.read(scope, key), Buffer.from("private bytes"));
  process.env.ROOM_PLUGIN_LOCAL_UPLOAD_ROOT = join(publicRoot, "leaked-code");
  assert.throws(() => configuredRoomPluginBlobStorage(publicRoot, {} as IncomingMessage, () => "https://app.example.test/"), RoomPluginBlobConfigurationError);
});
