import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { MemoryStorage } from "../storage.js";
import { immutableUploadTempKey } from "../uploaded-object-storage.js";
import type { DocumentUploadStorage } from "../upload-storage-config.js";
import { createRoomPluginBlobStorage, RoomPluginBlobWriteUncertain } from "./blob-storage.js";
import { RoomPluginBlobIoError } from "./blob-errors.js";
import { createRoomPluginPackageService, deleteRoomWithPluginCleanup, RoomPluginOperationPending } from "./package-service.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const bytes = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "atomic", version: "1.0.0",
  displayName: "Atomic", requestedCapabilities: ["status.set"], configSchema: {} }, "export function init() {}").bytes;
const s3: DocumentUploadStorage = { type: "s3", provider: "s3-compatible", endpoint: "https://objects.example.test/",
  region: "test-region", bucket: "private-bucket", accessKeyId: "storage-key", secretAccessKey: "secret-not-in-fingerprint" };

test("S3 PUT/GET-body/DELETE have finite deadlines; a write deadline is always uncertain", { timeout: 15_000 }, async t => {
  const server = createServer((request, response) => {
    request.resume();
    if (request.method === "GET") { response.writeHead(200); response.write("partial body that never ends"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const adapter = createRoomPluginBlobStorage({ ...s3, endpoint }, { requestTimeoutMs: 60 });
  const storage = new MemoryStorage(), scope = { tenantId: "demo-tenant", roomId: "demo-room" };
  const value = (await storage.roomPlugins.reservePackage(scope, bytes, adapter.backendFingerprint)).package;
  for (const [operation, expected] of [[() => adapter.put(scope, value.storageKey, bytes), RoomPluginBlobWriteUncertain],
    [() => adapter.read(scope, value.storageKey), RoomPluginBlobIoError], [() => adapter.delete(scope, value.storageKey), RoomPluginBlobIoError]] as const) {
    const start = Date.now(); await assert.rejects(operation, expected);
    assert.ok(Date.now() - start < 2000, "client call must finish even when the object server never responds");
  }
});

test("aborted PUT may finish later; neither the deadline nor its late completion releases the reservation", { timeout: 15_000 }, async t => {
  const late = deferred();
  const keepAlive = setInterval(() => undefined, 100); t.after(() => clearInterval(keepAlive));
  let aborted = false, calls = 0, completed = false;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++; options.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    await late.promise; completed = true; return new Response(null, { status: 200 });
  });
  const adapter = createRoomPluginBlobStorage(s3, { requestTimeoutMs: 20 });
  const storage = new MemoryStorage(), scope = { tenantId: "demo-tenant", roomId: "demo-room" };
  const service = createRoomPluginPackageService(storage.roomPlugins, adapter);
  await assert.rejects(service.savePackage(scope, bytes), RoomPluginOperationPending);
  const value = (await storage.roomPlugins.listPackages(scope))[0];
  assert.equal(aborted, true); assert.equal(value.uploadSettled, false);
  await assert.rejects(service.reconcileUpload(scope, value.packageId), { code: "plugin_upload_pending" });
  await assert.rejects(deleteRoomWithPluginCleanup(storage, scope, () => adapter), { code: "plugin_upload_pending" });
  late.resolve(); await delay(20); assert.equal(completed, true);
  assert.equal((await storage.roomPlugins.getPackage(scope, value.packageId))?.uploadSettled, false);
  assert.equal(calls, 1);
  assert.ok(await storage.getRoom(scope.roomId));
});

test("local partial write is invisible until atomic publication and a known failure settles before compensation", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "vrata-plugin-atomic-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sample = await open(join(root, "sample"), "wx");
  const prototype = Object.getPrototypeOf(sample) as { writeFile(data: Uint8Array): Promise<void> };
  await sample.close();
  const entered = deferred(), finish = deferred();
  t.mock.method(prototype, "writeFile", async function(this: FileHandle, data: Uint8Array) {
    await this.write(data.subarray(0, 5)); entered.resolve(); await finish.promise;
    throw new Error("known-local-write-rejection");
  });
  const adapter = createRoomPluginBlobStorage({ type: "local", provider: "minio-default", root, publicBaseUrl: "https://unused/" });
  const storage = new MemoryStorage(), scope = { tenantId: "demo-tenant", roomId: "demo-room" };
  const saving = createRoomPluginPackageService(storage.roomPlugins, adapter).savePackage(scope, bytes);
  await entered.promise;
  const value = (await storage.roomPlugins.listPackages(scope))[0];
  await assert.rejects(stat(join(root, value.storageKey)), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(root, immutableUploadTempKey(value.storageKey))), Buffer.from(bytes.subarray(0, 5)));
  assert.equal(value.uploadSettled, false);
  const rejected = assert.rejects(saving, RoomPluginBlobIoError); finish.resolve(); await rejected;
  await assert.rejects(stat(join(root, value.storageKey)), { code: "ENOENT" });
  await assert.rejects(stat(join(root, immutableUploadTempKey(value.storageKey))), { code: "ENOENT" });
  const tombstone = await storage.roomPlugins.getPackage(scope, value.packageId);
  assert.equal(tombstone?.uploadSettled, true); assert.equal(tombstone?.state, "deleted");
});

test("backend fingerprint binds the target, permits credential rotation and snapshots mutable configuration", () => {
  const original = createRoomPluginBlobStorage(s3);
  const rotated = createRoomPluginBlobStorage({ ...s3, accessKeyId: "new-key", secretAccessKey: "new-secret" });
  assert.equal(original.backendFingerprint, rotated.backendFingerprint);
  for (const changed of [{ ...s3, bucket: "wrong-bucket" }, { ...s3, endpoint: "https://another.example.test/" }, { ...s3, region: "another-region" }]) {
    assert.notEqual(original.backendFingerprint, createRoomPluginBlobStorage(changed).backendFingerprint);
  }
  const config = { type: "local" as const, provider: "minio-default" as const, root: join(tmpdir(), "target-a"), publicBaseUrl: "https://unused/" };
  const captured = createRoomPluginBlobStorage(config); config.root = join(tmpdir(), "target-b");
  assert.notEqual(captured.backendFingerprint, createRoomPluginBlobStorage(config).backendFingerprint);
  assert.match(captured.backendFingerprint, /^[a-f0-9]{64}$/);
});
