import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { privateDescriptor, servePrivateAsset } from "./private-scene-delivery.js";
import type { PrivateSceneVersion } from "./private-scene-release.js";
import { MemoryStorage } from "./storage.js";

test("private asset access stops at the expiry advertised in the server descriptor", async (t) => {
  const now = Date.parse("2026-11-24T10:49:00Z"), iso = new Date(now).toISOString();
  t.mock.timers.enable({ apis: ["Date"], now });
  const storage = new MemoryStorage();
  const secret = "test-secret";
  const server = createServer((req, res) => void servePrivateAsset(req, res, storage, secret));
  server.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const approval = {
    tenantId: "pt_01JBQ7Z8K3M4N5P6Q7R8S9T0VW", ownerSubject: "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW",
    bundleId: "mine", version: "v1", archiveSha256: "a".repeat(64)
  };
  const { tenantId, ownerSubject, bundleId, version, archiveSha256 } = approval;
  const scene: PrivateSceneVersion = {
    tenantId, bundleId, version, archiveSha256, state: "candidate", bundleVersionId: "v1", contentHash: "test-hash",
    files: [{ path: "scene.json", sha256: "test-hash", sizeBytes: 2, contentType: "application/json" }],
    sizeBytes: 2, createdAt: iso, validation: { issues: [] }
  };
  const room = {
    ...(await storage.getRoom("demo-room"))!, tenantId,
    managed: {
      kind: "custom" as const, status: "active" as const, ownerSubject, managedBy: "portal",
      publishedVersionId: scene.bundleVersionId, bundleContentHash: scene.contentHash,
      accessUntil: new Date(now + 900_000).toISOString(), graceSeconds: 0,
      revision: 1, createdAt: iso, updatedAt: iso, accessEpoch: "epoch"
    }
  };
  const grant = {
    grantId: "grant", roomId: room.roomId, tenantId, subject: ownerSubject, role: "host" as const, purpose: "visit" as const,
    maxUses: 1, usedCount: 1, expiresAt: room.managed.accessUntil, revokedAt: null, revokeReason: null,
    displayName: null, returnContext: null, revision: 1, lastOperationId: null, createdAt: iso, updatedAt: iso
  };
  t.mock.method(storage, "getRoom", async () => room);
  t.mock.method(storage, "getPrivateSceneVersion", async () => scene);
  t.mock.method(storage, "getManagedRoomGrant", async () => grant);
  const env = {
    NODE_ENV: "test", VRATA_PRIVATE_ASSET_ORIGIN: origin, RUNTIME_BASE_URL: "https://app.example",
    VRATA_PRIVATE_SCENE_APPROVAL: JSON.stringify(approval)
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const exp = now + 600_000;
  const descriptor = privateDescriptor(room, scene, grant.grantId, (now + 900_000) / 1000, secret);
  assert.ok(descriptor);
  assert.equal(descriptor.issuedAt, iso);
  assert.equal(Date.parse(descriptor.expiresAt), exp);
  assert.equal(Date.parse(descriptor.refreshAfter), exp - 30_000);
  t.mock.timers.setTime(exp - 1);
  assert.equal((await fetch(descriptor.manifestUrl, { method: "HEAD" })).status, 200);
  t.mock.timers.setTime(exp);
  assert.equal((await fetch(descriptor.manifestUrl, { method: "HEAD" })).status, 403);
});
