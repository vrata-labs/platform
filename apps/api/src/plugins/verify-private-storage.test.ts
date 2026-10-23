import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { MemoryStorage } from "../storage.js";
import type { DocumentUploadStorage } from "../upload-storage-config.js";
import { verifyPluginPrivateStorage, PluginPrivateStorageVerificationFailed } from "./verify-private-storage.js";

async function objectServer(t: TestContext, anonymousStatus: number, unknownPut = false) {
  const objects = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    const key = request.url!;
    if (request.method === "PUT") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      if (!unknownPut) response.writeHead(200).end();
    } else if (request.method === "DELETE") { objects.delete(key); response.writeHead(204).end(); }
    else if (request.headers.authorization) { response.writeHead(objects.has(key) ? 200 : 404).end(objects.get(key)); }
    else response.writeHead(anonymousStatus).end(anonymousStatus === 200 ? objects.get(key) : "denied");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const config: DocumentUploadStorage = { type: "s3", provider: "minio-default", endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    region: "test-region", bucket: "private-plugins", accessKeyId: "test-key", secretAccessKey: "test-secret" };
  return { objects, config };
}
test("operator privacy fixture verifies signed bytes and unsigned 403 without publishing or leaving room/blob metadata", async t => {
  const fixture = await objectServer(t, 403), storage = new MemoryStorage();
  const rooms = await storage.listRooms();
  const publication = t.mock.method(storage.roomPlugins, "publishPackage", async () => { throw new Error("probe_must_not_publish"); });
  const checks = await verifyPluginPrivateStorage(storage, fixture.config);
  assert.equal(checks.signedPut, true); assert.equal(checks.signedReadExact, true); assert.equal(checks.anonymousDenied, true);
  assert.equal(checks.noPackagePublication, true); assert.equal(checks.blobMetadataCleanup, true); assert.equal(checks.roomCleanup, true);
  assert.equal(checks.publicEndpointChecked, false); assert.equal(checks.publicEndpointDenied, false);
  assert.equal(publication.mock.callCount(), 0); assert.equal(fixture.objects.size, 0); assert.deepEqual(await storage.listRooms(), rooms);
  assert.ok(Object.values(checks).every(value => typeof value === "boolean"));
});
for (const status of [200, 404, 503]) test(`operator privacy fixture rejects unsigned ${status} despite signed byte-exact read; no publication claim`, async t => {
  const fixture = await objectServer(t, status), storage = new MemoryStorage();
  const publication = t.mock.method(storage.roomPlugins, "publishPackage", async () => { throw new Error("probe_must_not_publish"); });
  await assert.rejects(verifyPluginPrivateStorage(storage, fixture.config), (error: unknown) => {
    assert.ok(error instanceof PluginPrivateStorageVerificationFailed);
    assert.equal(error.checks.signedReadExact, true); assert.equal(error.checks.anonymousDenied, false);
    assert.equal(error.checks.noPackagePublication, true); assert.equal(error.checks.blobMetadataCleanup, true); assert.equal(error.checks.roomCleanup, true);
    return true;
  });
  assert.equal(publication.mock.callCount(), 0); assert.equal(fixture.objects.size, 0);
});
test("privacy probe cannot turn a timed-out PUT into stopped writer evidence or clean its reserved index", async t => {
  const fixture = await objectServer(t, 403, true), storage = new MemoryStorage();
  await assert.rejects(verifyPluginPrivateStorage(storage, fixture.config, { requestTimeoutMs: 20 }), (error: unknown) => {
    assert.ok(error instanceof PluginPrivateStorageVerificationFailed);
    assert.equal(error.checks.signedPut, false); assert.equal(error.checks.unknownWriterRetained, true);
    assert.equal(error.checks.blobMetadataCleanup, false); assert.equal(error.checks.roomCleanup, false);
    return true;
  });
  const room = (await storage.listRooms()).find(value => value.roomId.startsWith("plugin-privacy-"))!;
  const packages = await storage.roomPlugins.listPackages({ tenantId: room.tenantId, roomId: room.roomId });
  assert.equal(packages[0].state, "reserved"); assert.equal(packages[0].uploadSettled, false);
});
