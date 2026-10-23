import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { MemoryStorage } from "../storage.js";
import type { DocumentUploadStorage } from "../upload-storage-config.js";
import { deleteDocumentObject, readDocumentObject, readPrivateUploadedObject, writeDocumentObject } from "../uploaded-object-storage.js";
import { createRoomPluginBlobStorage } from "./blob-storage.js";
import { RoomPluginBlobIoError } from "./blob-errors.js";
import { createRoomPluginPackageService, RoomPluginOperationPending } from "./package-service.js";
import { roomPluginPrefix } from "./storage.js";

async function streamingErrorServer(t: TestContext) {
  const bodies = new Set<ServerResponse>(), sockets = new Set<Socket>();
  let status = 503, requests = 0, closed = 0, peakSockets = 0, peakBodies = 0;
  const server = createServer((request, response) => {
    requests++; bodies.add(response); peakBodies = Math.max(peakBodies, bodies.size);
    response.once("close", () => { bodies.delete(response); closed++; });
    request.on("end", () => {
      response.writeHead(status, { "content-type": "text/plain", connection: "keep-alive" });
      response.write("headers received; upstream body deliberately never finishes");
    });
    request.resume();
  });
  server.on("connection", socket => {
    sockets.add(socket); peakSockets = Math.max(peakSockets, sockets.size);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  // Test-only final teardown. Every assertion below runs before this, so teardown cannot hide a leak.
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const config: Extract<DocumentUploadStorage, { type: "s3" }> = { type: "s3", provider: "s3-compatible", endpoint,
    region: "test-region", bucket: "objects", accessKeyId: "test-key", secretAccessKey: "test-secret" };
  return {
    config,
    setStatus(value: number) { status = value; },
    async released(expected: number) {
      const end = Date.now() + 3000;
      while ((bodies.size || sockets.size > 2 || closed < expected) && Date.now() < end) await delay(10);
      assert.equal(bodies.size, 0, "finished operation must close the native streaming response before its deadline or teardown");
      assert.equal(closed, expected, "each real server response must have observed transport closure");
      assert.equal(requests, expected);
      assert.ok(sockets.size <= 2, "idle connection count must remain bounded across retries");
      assert.ok(peakBodies <= 1, "unfinished response bodies must not accumulate across retries");
      assert.ok(peakSockets <= 4, "native socket growth must be bounded, not one socket per retry");
    }
  };
}

test("real 503 GET headers with endless body release private/public/plugin HTTP transports across retries", { timeout: 20_000 }, async t => {
  const server = await streamingErrorServer(t);
  const env = { ...process.env }; t.after(() => { process.env = env; });
  process.env.SCENE_BUNDLE_S3_PUBLIC_BASE_URL = `${server.config.endpoint}objects`;
  process.env.SCENE_BUNDLE_S3_BUCKET = server.config.bucket;
  process.env.SCENE_BUNDLE_S3_ENDPOINT = server.config.endpoint;
  process.env.SCENE_BUNDLE_S3_REGION = server.config.region;
  const scope = { tenantId: "transport", roomId: "get" };
  const key = `${roomPluginPrefix(scope)}${randomUUID()}/${"a".repeat(64)}.vrata-plugin.json`;
  // Deliberately longer than the assertion window: passing cannot rely on the deadline timer.
  const adapter = createRoomPluginBlobStorage(server.config, { requestTimeoutMs: 10_000 });
  let attempts = 0;
  for (let index = 0; index < 12; index++) {
    await assert.rejects(readPrivateUploadedObject(server.config, key, 1024), /private_object_download_failed:503/);
    await server.released(++attempts);
    await assert.rejects(readDocumentObject(server.config, key), /document_object_download_failed:503/);
    await server.released(++attempts);
    await assert.rejects(adapter.read(scope, key), RoomPluginBlobIoError);
    await server.released(++attempts);
  }
});

test("real PUT success/rejection bodies close without changing the unknown-writer reservation guarantee", { timeout: 20_000 }, async t => {
  const server = await streamingErrorServer(t);
  let attempts = 0;
  for (let index = 0; index < 18; index++) {
    const status = [200, 400, 503][index % 3]; server.setStatus(status);
    const operation = writeDocumentObject(server.config, `put-${index}`, Buffer.from("bytes"), "application/octet-stream");
    if (status === 200) await operation;
    else await assert.rejects(operation, new RegExp(`document_object_upload_failed:${status}`));
    await server.released(++attempts);
  }
  server.setStatus(503);
  const storage = new MemoryStorage(), scope = { tenantId: "demo-tenant", roomId: "demo-room" };
  const adapter = createRoomPluginBlobStorage(server.config, { requestTimeoutMs: 10_000 });
  const bytes = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "transport", version: "1.0.0",
    displayName: "Transport", requestedCapabilities: [], configSchema: {} }, "export function init() {}").bytes;
  const service = createRoomPluginPackageService(storage.roomPlugins, adapter);
  await assert.rejects(service.savePackage(scope, bytes), RoomPluginOperationPending);
  await server.released(++attempts);
  const value = (await storage.roomPlugins.listPackages(scope))[0];
  assert.equal(value.state, "reserved"); assert.equal(value.uploadSettled, false);
  await assert.rejects(service.deletePackage(scope, value.packageId), { code: "plugin_upload_pending" });
  await assert.rejects(service.reconcileUpload(scope, value.packageId), { code: "plugin_upload_pending" });
});

test("real DELETE success/404/error headers release ignored bodies for shared and plugin helpers", { timeout: 20_000 }, async t => {
  const server = await streamingErrorServer(t);
  const scope = { tenantId: "transport", roomId: "delete" };
  const key = `${roomPluginPrefix(scope)}${randomUUID()}/${"a".repeat(64)}.vrata-plugin.json`;
  const adapter = createRoomPluginBlobStorage(server.config, { requestTimeoutMs: 10_000 });
  let attempts = 0;
  for (let index = 0; index < 12; index++) {
    const status = [200, 404, 503][index % 3]; server.setStatus(status);
    const ordinary = deleteDocumentObject(server.config, key);
    if (status === 503) await assert.rejects(ordinary, /document_object_delete_failed:503/); else await ordinary;
    await server.released(++attempts);
    const plugin = adapter.delete(scope, key);
    if (status === 503) await assert.rejects(plugin, RoomPluginBlobIoError); else await plugin;
    await server.released(++attempts);
  }
});
