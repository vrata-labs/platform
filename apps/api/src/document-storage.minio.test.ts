import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { getRoomPermissions } from "@vrata/shared-types";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";

import { documentObjectStores } from "./document-storage.js";
import { moveLegacyDocuments, ORPHAN_MIN_AGE_MS, postgresDocumentRows } from "./document-storage-move.js";
import { PostgresStorage } from "./storage.js";
import { deleteDocumentObject, listStoredObjects, readPrivateUploadedObject, writeDocumentObject } from "./uploaded-object-storage.js";

// Same fixture as the room plugin private-storage test: bundled storage with a public bucket (anonymous download)
// and a separate private bucket, both created by minio-bootstrap, plus Postgres.
const endpoint = process.env.VRATA_TEST_PLUGIN_MINIO_ENDPOINT;
const env = {
  DOCUMENT_PROVIDER: "minio-default", SCENE_BUNDLE_PROVIDER: "minio-default", MINIO_ENDPOINT: endpoint,
  MINIO_ROOT_USER: process.env.VRATA_TEST_PLUGIN_MINIO_ACCESS_KEY, MINIO_ROOT_PASSWORD: process.env.VRATA_TEST_PLUGIN_MINIO_SECRET_KEY,
  MINIO_BUCKET: process.env.VRATA_TEST_PLUGIN_MINIO_PUBLIC_BUCKET, ROOM_PLUGIN_BUCKET: process.env.VRATA_TEST_PLUGIN_MINIO_PRIVATE_BUCKET,
  MINIO_PUBLIC_BASE_URL: endpoint, SCENE_BUNDLE_S3_REGION: "us-east-1"
};

async function anonymous(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { redirect: "manual" });
  return { status: response.status, body: await response.text() };
}

test("documents on real storage: private writes, legacy fallback, move command and anonymous access", {
  skip: !endpoint, timeout: 180_000
}, async t => {
  assert.ok(env.MINIO_ROOT_USER && env.MINIO_ROOT_PASSWORD && env.MINIO_BUCKET && env.ROOM_PLUGIN_BUCKET && process.env.VRATA_TEST_POSTGRES_URL,
    "real fixture needs credentials, separate private/public buckets and Postgres");
  const schema = `documents_minio_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  await root.query(`create schema "${schema}"`);
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL!);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href, max: 2 });
  t.after(async () => { await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const storage = new PostgresStorage(pool); await storage.init();

  const previous = { ...process.env };
  Object.assign(process.env, env, { POSTGRES_URL: connection.href, VRATA_DISABLE_AUTOSTART: "1", CONTROL_PLANE_ADMIN_TOKEN: "documents-minio-admin",
    STATE_TOKEN_SECRET: "documents-minio-state-secret-0123456789" });
  t.after(() => { process.env = previous; });
  const stores = documentObjectStores("/app/apps/runtime-web/public", process.env);
  assert.ok(stores.current.type === "s3" && stores.legacy?.type === "s3");
  const publicUrl = (key: string) => `${endpoint}/${env.MINIO_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const privateUrl = (key: string) => `${endpoint}/${env.ROOM_PLUGIN_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;

  // The fixture is realistic only if the public bucket really serves anonymous reads.
  const control = `documents/fixture-${randomUUID()}/control.txt`;
  await writeDocumentObject(stores.legacy, control, Buffer.from("public"), "text/plain");
  assert.deepEqual(await anonymous(publicUrl(control)), { status: 200, body: "public" });
  await deleteDocumentObject(stores.legacy, control);

  await t.test("listing pages through continuation tokens and decodes keys", async () => {
    const prefix = `listing-${randomUUID()}/`;
    const keys = ["a b.pdf", "c+d.pdf", "доклад.pdf", "x/y/z.txt", "e&f.txt"].map(name => `${prefix}${name}`);
    for (const key of keys) await writeDocumentObject(stores.current, key, Buffer.from(key), "text/plain");
    t.after(async () => { for (const key of keys) await deleteDocumentObject(stores.current, key); });
    const listed = await listStoredObjects(stores.current, prefix, { pageSize: 2 });
    assert.deepEqual(listed.map(entry => entry.key).sort(), [...keys].sort());
    for (const entry of listed) assert.equal(entry.size, Buffer.byteLength(entry.key));
  });

  const { startApiServer } = await import("./index.js");
  const server = startApiServer(0); if (!server.listening) await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const roomId = `documents-minio-${randomUUID().slice(0, 8)}`;
  const admin = { "content-type": "application/json", "x-vrata-admin-token": "documents-minio-admin" };
  assert.equal((await fetch(`${origin}/api/rooms`, { method: "POST", headers: admin,
    body: JSON.stringify({ roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Documents on real storage" }) })).status, 201);
  const now = Math.floor(Date.now() / 1000);
  const host = { authorization: `Bearer ${signRoomSessionToken({ tenantId: "demo-tenant", roomId, participantId: "documents-host",
    displayName: "Host", role: "host", roleSource: "trusted", permissions: getRoomPermissions("host"), sessionId: "documents-host-session",
    iat: now, exp: now + 600, jti: "documents-host-jti" }, process.env.STATE_TOKEN_SECRET!)}` };
  const upload = async (name: string, bytes: Buffer) => {
    const form = new FormData(); form.set("document", new File([new Uint8Array(bytes)], name, { type: "text/plain" }));
    const response = await fetch(`${origin}/api/rooms/${roomId}/documents`, { method: "POST", headers: host, body: form });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json() as { document: { documentId: string } }).document.documentId;
  };
  const download = (documentId: string) => fetch(`${origin}/api/rooms/${roomId}/documents/${documentId}/download`, { headers: host });
  const keyOf = async (documentId: string) => (await storage.getRoomDocument(roomId, documentId))!.storageKey;

  const fresh = Buffer.from("uploaded after the change"), legacy = Buffer.from("uploaded by an earlier release"), deleted = Buffer.from("tombstoned");
  const freshId = await upload("agenda 1.txt", fresh), legacyId = await upload("notes.txt", legacy), deletedId = await upload("draft.txt", deleted);
  const freshKey = await keyOf(freshId), legacyKey = await keyOf(legacyId), deletedKey = await keyOf(deletedId);

  await t.test("uploads land in the private bucket only and are released through the API", async () => {
    assert.deepEqual(await readPrivateUploadedObject(stores.current, freshKey, 1024), fresh);
    assert.equal((await anonymous(privateUrl(freshKey))).status, 403);
    assert.equal((await anonymous(publicUrl(freshKey))).status, 404);
    const response = await download(freshId);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fresh);
  });

  // Recreate the state an earlier release left: the object only in the public bucket, readable anonymously.
  for (const [key, bytes] of [[legacyKey, legacy], [deletedKey, deleted]] as const) {
    await writeDocumentObject(stores.legacy, key, bytes, "text/plain");
    await deleteDocumentObject(stores.current, key);
  }
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}/documents/${deletedId}`, { method: "DELETE", headers: host })).status, 200);
  await writeDocumentObject(stores.legacy, deletedKey, deleted, "text/plain"); // a cleanup that failed back then
  const orphanKey = `documents/demo-tenant/deleted-room/${randomUUID()}/old.pdf`;
  await writeDocumentObject(stores.legacy, orphanKey, Buffer.from("room deleted long ago"), "application/pdf");
  assert.equal((await anonymous(publicUrl(legacyKey))).status, 200);

  await t.test("a legacy object is still released through the API, from a signed read", async () => {
    const response = await download(legacyId);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), legacy);
    const metrics = await (await fetch(`${origin}/metrics`, { headers: admin })).text();
    assert.match(metrics, /^vrata_document_legacy_reads_total [1-9]/m);
  });

  const command = fileURLToPath(new URL("./document-storage-move.js", import.meta.url));
  const runWith = async (overrides: Record<string, string>, ...args: string[]) => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [command, ...args], { env: { ...process.env, ...overrides }, cwd: "/" })
      .catch((error: { stdout: string; stderr: string }) => error);
    for (const secret of [env.MINIO_ROOT_PASSWORD!, env.MINIO_ROOT_USER!, legacyKey, orphanKey]) {
      assert.ok(!stdout.includes(secret) && !stderr.includes(secret), "output carries counts only");
    }
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  };
  const run = (...args: string[]) => runWith({}, ...args);
  // As on a self-host whose public storage address is a loopback address of the host, not of the API container.
  const unreachablePublic = { MINIO_PUBLIC_BASE_URL: "http://127.0.0.1:1" };

  await t.test("the compiled move command moves, deletes public copies, keeps a recent orphan and probes privacy", async () => {
    const dry = await run();
    assert.equal(dry.ok, true); assert.equal(dry.liveToMove, 1); assert.equal(dry.publicCopiesToDelete, 1); assert.equal(dry.recentOrphans, 1);
    assert.equal((await anonymous(publicUrl(legacyKey))).status, 200, "a dry run changes nothing");
    const verify = await run("--verify");
    assert.equal(verify.ok, true);
    const moved = await run("--confirm");
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.moved, 1); assert.equal(moved.deletedTombstoned, 1); assert.equal(moved.recentOrphans, 1); assert.equal(moved.remaining, 1);
    assert.equal(moved.unexpectedRemaining, 0);
    assert.deepEqual(moved.probe, { checked: true, signedReadExact: true, publicUrlDenied: true, privateBucketAnonymousDenied: true,
      publicEndpointPrivateBucketDenied: true, cleanup: true });
    assert.equal((await anonymous(publicUrl(legacyKey))).status, 404);
    assert.equal((await anonymous(publicUrl(deletedKey))).status, 404);
    assert.equal((await anonymous(privateUrl(legacyKey))).status, 403);
    const response = await download(legacyId);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), legacy);
    assert.equal((await run("--confirm")).moved, 0, "a second run has nothing to move");
  });

  await t.test("the probe fails closed on an unreachable public address and uses a reachable anonymous endpoint instead", async () => {
    const unreachable = await runWith(unreachablePublic, "--confirm");
    assert.equal(unreachable.ok, false);
    assert.equal((unreachable.probe as Record<string, boolean>).publicUrlDenied, false);
    const endpointOverride = await runWith({ ...unreachablePublic, ROOM_PLUGIN_ANONYMOUS_ENDPOINT: endpoint! }, "--confirm");
    assert.equal(endpointOverride.ok, true, JSON.stringify(endpointOverride));
    assert.equal((endpointOverride.probe as Record<string, boolean>).publicUrlDenied, true);
  });

  await t.test("an orphan past the age limit is deleted; document and room deletion clear both namespaces", async () => {
    const counts = await moveLegacyDocuments(stores, postgresDocumentRows(pool), { prefix: "documents/", confirm: false, now: () => Date.now() + ORPHAN_MIN_AGE_MS });
    assert.equal(counts.recentOrphans, 0); assert.equal(counts.publicCopiesToDelete, 1);
    // After a restore no older writer runs: every object without a row goes, and no probe needs the public address.
    const restored = await runWith(unreachablePublic, "--restore");
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.deletedOrphans, 1); assert.equal(restored.remaining, 0); assert.equal(restored.probe, undefined);
    await writeDocumentObject(stores.legacy!, freshKey, fresh, "text/plain");
    assert.equal((await fetch(`${origin}/api/rooms/${roomId}`, { method: "DELETE", headers: admin })).status, 200);
    for (const key of [freshKey, legacyKey]) {
      assert.equal((await anonymous(publicUrl(key))).status, 404, key);
      await assert.rejects(readPrivateUploadedObject(stores.current, key, 1024), { message: "private_object_download_failed:404" });
    }
    assert.equal((await storage.listRoomDocuments(roomId, true)).length, 0);
  });
});
