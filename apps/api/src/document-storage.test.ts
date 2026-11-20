import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { assertDocumentStorageKey, deleteDocumentBytes, documentObjectStores, isLegacyLocalDocumentAssetPath, readDocumentBytes,
  writeDocumentBytes, type DocumentObjectStores } from "./document-storage.js";
import { moveLegacyDocuments, movePassed, ORPHAN_MIN_AGE_MS, parseMoveMode, type DocumentRowSource, type DocumentRowState } from "./document-storage-move.js";
import { sha256Hex } from "./uploaded-object-storage.js";

const publicRoot = resolve("/srv/vrata/apps/runtime-web/public");
const minio = { MINIO_ROOT_USER: "user", MINIO_ROOT_PASSWORD: "password", MINIO_BUCKET: "public-assets", ROOM_PLUGIN_BUCKET: "private-objects" };
const s3 = { SCENE_BUNDLE_S3_ENDPOINT: "https://s3.example.invalid", SCENE_BUNDLE_S3_REGION: "region", SCENE_BUNDLE_S3_BUCKET: "public-scenes",
  SCENE_BUNDLE_S3_ACCESS_KEY_ID: "key", SCENE_BUNDLE_S3_SECRET_ACCESS_KEY: "secret", ROOM_PLUGIN_BUCKET: "private-objects" };

test("documents are written to the private bucket; the public bucket is only the legacy location", () => {
  const bundled = documentObjectStores(publicRoot, { NODE_ENV: "production", ...minio });
  assert.ok(bundled.current.type === "s3" && bundled.legacy?.type === "s3");
  assert.equal(bundled.current.bucket, "private-objects");
  assert.equal(bundled.legacy.bucket, "public-assets");
  assert.equal(bundled.current.endpoint, "http://minio:9000");
  const custom = documentObjectStores(publicRoot, { NODE_ENV: "production", DOCUMENT_PROVIDER: "s3-compatible", ...s3 });
  assert.ok(custom.current.type === "s3" && custom.legacy?.type === "s3");
  assert.equal(custom.current.bucket, "private-objects");
  assert.equal(custom.legacy.bucket, "public-scenes");
  assert.equal(documentObjectStores(publicRoot, { NODE_ENV: "production", DOCUMENT_PROVIDER: "s3-compatible", ...s3, SCENE_BUNDLE_S3_BUCKET: undefined }).legacy, null);
});

test("a missing, malformed or public private bucket and partial credentials fail closed", () => {
  for (const env of [
    { ...minio, ROOM_PLUGIN_BUCKET: undefined }, { ...minio, ROOM_PLUGIN_BUCKET: "public-assets" }, { ...minio, ROOM_PLUGIN_BUCKET: "/public-assets/" },
    { ...minio, ROOM_PLUGIN_BUCKET: "Bad_Bucket" }, { ...minio, MINIO_ROOT_PASSWORD: undefined }, { ROOM_PLUGIN_BUCKET: "private-objects" },
    { DOCUMENT_PROVIDER: "s3-compatible", ...s3, ROOM_PLUGIN_BUCKET: "public-scenes" }, { DOCUMENT_PROVIDER: "s3-compatible", ...s3, SCENE_BUNDLE_S3_REGION: "" }
  ]) assert.throws(() => documentObjectStores(publicRoot, { NODE_ENV: "development", ...env }), { message: "document_private_storage_unavailable" }, JSON.stringify(env));
  assert.throws(() => documentObjectStores(publicRoot, { NODE_ENV: "production" }), { message: "misconfigured_document_upload_storage:minio-default" });
  assert.throws(() => documentObjectStores(publicRoot, { NODE_ENV: "production", DOCUMENT_PROVIDER: "" }), { message: "misconfigured_document_upload_storage:" });
});

test("local development keeps documents outside the statically served tree", () => {
  const stores = documentObjectStores(publicRoot, { NODE_ENV: "development" });
  assert.ok(stores.current.type === "local" && stores.legacy?.type === "local");
  assert.equal(stores.current.root, resolve("/srv/vrata/apps/.room-document-objects"));
  assert.equal(stores.legacy.root, join(publicRoot, "assets", "uploaded-documents"));
  assert.equal(documentObjectStores(publicRoot, { DOCUMENT_LOCAL_UPLOAD_ROOT: "/tmp/documents" }).current.type, "local");
  const controlPlaneAssets = join(dirname(dirname(publicRoot)), "control-plane", "dist", "assets", "private-documents");
  for (const root of [publicRoot, join(publicRoot, "assets", "uploaded-documents"), join(dirname(publicRoot), "dist", "x"), controlPlaneAssets]) {
    assert.throws(() => documentObjectStores(publicRoot, { DOCUMENT_LOCAL_UPLOAD_ROOT: root }), { message: "document_storage_root_is_public" }, root);
  }
  // The static route also serves local scene uploads.
  for (const root of ["/tmp/uploads", "/tmp/uploads/documents"]) {
    assert.throws(() => documentObjectStores(publicRoot, { DOCUMENT_LOCAL_UPLOAD_ROOT: root, SCENE_BUNDLE_LOCAL_UPLOAD_ROOT: "/tmp/uploads" }),
      { message: "document_storage_root_is_public" }, root);
  }
  assert.equal(documentObjectStores(publicRoot, { DOCUMENT_LOCAL_UPLOAD_ROOT: "/tmp/documents", SCENE_BUNDLE_LOCAL_UPLOAD_ROOT: "/tmp/scenes" }).current.type, "local");
});

test("the legacy local document directory is refused in every request spelling", () => {
  for (const path of ["/assets/uploaded-documents/documents/t/r/d/a.pdf", "/assets//uploaded-documents/x", "/assets/./uploaded-documents/x",
    "/assets/uploaded-documents", "/assets/x/../uploaded-documents/y"]) assert.equal(isLegacyLocalDocumentAssetPath(path), true, path);
  for (const path of ["/assets/uploaded-scene-bundles/x/scene.json", "/assets/uploaded-documents-other/x", "/assets/scenes/hall/scene.json"]) {
    assert.equal(isLegacyLocalDocumentAssetPath(path), false, path);
  }
});

test("document keys that a URL or path could reinterpret are refused", () => {
  assertDocumentStorageKey("documents/demo-tenant/room/7c9e/agenda 1.pdf");
  for (const key of ["", "documents//x", "documents/../room-plugins/x", "documents/./x", "/documents/x", "documents/x/", "documents\\x", "documents/x\0"]) {
    assert.throws(() => assertDocumentStorageKey(key), { message: "unsafe_document_storage_key" }, JSON.stringify(key));
  }
});

type LocalStorage = Extract<DocumentObjectStores["current"], { type: "local" }>;
async function localStores(t: TestContext): Promise<{ current: LocalStorage; legacy: LocalStorage }> {
  const root = await mkdtemp(join(tmpdir(), "vrata-document-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = { type: "local" as const, provider: "minio-default" as const, publicBaseUrl: "https://private-storage.invalid/" };
  return { current: { ...local, root: join(root, "private") }, legacy: { ...local, root: join(root, "public") } };
}

async function putLegacy(stores: { legacy: { root: string } }, key: string, bytes: Buffer, ageMs = ORPHAN_MIN_AGE_MS * 2): Promise<void> {
  const file = join(stores.legacy.root, key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  const time = new Date(Date.now() - ageMs);
  await utimes(file, time, time);
}

const exists = (path: string) => readFile(path).then(() => true, () => false);

test("reads use the private object and fall back to a legacy copy only when the private object is missing", async t => {
  const stores = await localStores(t);
  const key = "documents/tenant/room/doc/a.pdf";
  await putLegacy(stores, key, Buffer.from("legacy"));
  assert.deepEqual(await readDocumentBytes(stores, key, 6), { bytes: Buffer.from("legacy"), legacy: true });
  await writeDocumentBytes(stores, key, Buffer.from("current"), "application/pdf");
  assert.deepEqual(await readDocumentBytes(stores, key, 7), { bytes: Buffer.from("current"), legacy: false });
  // The recorded size bounds the read; an oversized private object is an error, not a reason to fall back.
  await assert.rejects(readDocumentBytes(stores, key, 3), { message: "private_object_too_large" });
  await assert.rejects(readDocumentBytes({ ...stores, legacy: null }, "documents/tenant/room/other/a.pdf", 6), { code: "ENOENT" });
  await deleteDocumentBytes(stores, key);
  assert.equal(await exists(join(stores.current.root, key)), false);
  assert.equal(await exists(join(stores.legacy.root, key)), false);
  await deleteDocumentBytes(stores, key);
});

test("S3 reads are signed, never use a public URL, and only 404 falls back", async t => {
  const calls: string[] = [];
  let privateStatus = 404;
  t.mock.method(globalThis, "fetch", async (input: URL | string, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    assert.match(String((init?.headers as Record<string, string>)?.authorization), /^AWS4-HMAC-SHA256 /, url);
    if (url.includes("/private-objects/")) return new Response(privateStatus === 200 ? "private" : null, { status: privateStatus });
    return new Response("legacy");
  });
  const stores = documentObjectStores(publicRoot, { NODE_ENV: "production", ...minio, MINIO_PUBLIC_BASE_URL: "https://storage.example.invalid" });
  const key = "documents/tenant/room/doc/a.pdf";
  assert.deepEqual(await readDocumentBytes(stores, key, 16), { bytes: Buffer.from("legacy"), legacy: true });
  assert.deepEqual(calls, [`http://minio:9000/private-objects/${key}`, `http://minio:9000/public-assets/${key}`]);
  for (const status of [403, 500, 503]) {
    privateStatus = status; calls.length = 0;
    await assert.rejects(readDocumentBytes(stores, key, 16), { message: `private_object_download_failed:${status}` });
    assert.equal(calls.length, 1);
  }
  privateStatus = 200;
  assert.deepEqual(await readDocumentBytes(stores, key, 16), { bytes: Buffer.from("private"), legacy: false });
});

function rowSource(rows: Map<string, DocumentRowState>, hooks: { beforeCurrent?: (key: string, call: number) => void } = {}): DocumentRowSource {
  let calls = 0;
  return {
    async snapshot() { return new Map(rows); },
    async current(key) { hooks.beforeCurrent?.(key, ++calls); return rows.get(key) ?? null; }
  };
}
const row = (bytes: Buffer, live = true): DocumentRowState => ({ live, sizeBytes: bytes.length, checksum: `sha256:${sha256Hex(bytes)}`, contentType: "application/pdf" });

test("the move copies verified live objects, deletes public copies and leaves only recent orphans", async t => {
  const stores = await localStores(t);
  const prefix = "documents/";
  const live = Buffer.from("live document"), tombstoned = Buffer.from("deleted document"), orphan = Buffer.from("room was deleted");
  const keys = { live: `${prefix}t/r/live/a.pdf`, tombstoned: `${prefix}t/r/gone/b.pdf`, orphan: `${prefix}t/old/c/c.pdf`,
    recent: `${prefix}t/r/new/d.pdf`, mismatch: `${prefix}t/r/bad/e.pdf`, already: `${prefix}t/r/done/f.pdf` };
  await putLegacy(stores, keys.live, live);
  await putLegacy(stores, keys.tombstoned, tombstoned);
  await putLegacy(stores, keys.orphan, orphan);
  await putLegacy(stores, keys.recent, orphan, 1000);
  await putLegacy(stores, keys.mismatch, Buffer.from("changed bytes"));
  await putLegacy(stores, keys.already, live);
  await writeDocumentBytes(stores, keys.already, live, "application/pdf");
  const rows = new Map([[keys.live, row(live)], [keys.tombstoned, row(tombstoned, false)], [keys.mismatch, row(Buffer.from("original bytes"))],
    [keys.already, row(live)]]);

  const dry = await moveLegacyDocuments(stores, rowSource(rows), { prefix, confirm: false });
  assert.deepEqual(dry, { legacyConfigured: true, legacyObjects: 6, liveToMove: 3, publicCopiesToDelete: 2,
    recentOrphans: 1, moved: 0, alreadyPrivate: 0, deletedTombstoned: 0, deletedOrphans: 0, checksumMismatch: 0, conflicts: 0, failed: 0, remaining: null,
    unexpectedRemaining: null });
  assert.equal(await exists(join(stores.legacy.root, keys.live)), true, "a dry run writes and deletes nothing");
  assert.equal(await exists(join(stores.current.root, keys.live)), false);

  const counts = await moveLegacyDocuments(stores, rowSource(rows), { prefix, confirm: true });
  assert.equal(counts.moved, 1); assert.equal(counts.alreadyPrivate, 1);
  assert.equal(counts.deletedTombstoned, 1); assert.equal(counts.deletedOrphans, 1);
  assert.equal(counts.checksumMismatch, 1); assert.equal(counts.failed, 0); assert.equal(counts.remaining, 2); assert.equal(counts.unexpectedRemaining, 0);
  assert.equal(movePassed(counts), false, "a mismatched object fails the run and stays for the operator");
  assert.deepEqual(await readFile(join(stores.current.root, keys.live)), live);
  for (const key of [keys.live, keys.tombstoned, keys.orphan, keys.already]) assert.equal(await exists(join(stores.legacy.root, key)), false, key);
  assert.equal(await exists(join(stores.legacy.root, keys.recent)), true);
  assert.equal(await exists(join(stores.current.root, keys.mismatch)), false);
  assert.deepEqual(await readDocumentBytes(stores, keys.live, live.length), { bytes: live, legacy: false });

  rows.delete(keys.mismatch);
  const again = await moveLegacyDocuments(stores, rowSource(rows), { prefix, confirm: true, orphanMinAgeMs: 0 });
  assert.equal(again.deletedOrphans, 2); assert.equal(again.remaining, 0); assert.equal(movePassed(again), true);
});

test("a document deleted while it is copied does not keep a private copy", async t => {
  const stores = await localStores(t);
  const bytes = Buffer.from("deleted during the move"), key = "documents/t/r/doc/a.pdf";
  await putLegacy(stores, key, bytes);
  const rows = new Map([[key, row(bytes)]]);
  // The first current() read sees the live row; the deletion's tombstone commits before the re-check.
  const counts = await moveLegacyDocuments(stores, rowSource(rows, { beforeCurrent: (_, call) => { if (call === 2) rows.set(key, row(bytes, false)); } }),
    { prefix: "documents/", confirm: true });
  assert.equal(counts.moved, 0); assert.equal(counts.deletedTombstoned, 1); assert.equal(counts.remaining, 0);
  assert.equal(await exists(join(stores.current.root, key)), false);
  assert.equal(await exists(join(stores.legacy.root, key)), false);
});

test("a public object written during the run fails it even when the totals match the kept objects", async t => {
  const stores = await localStores(t);
  const live = Buffer.from("live"), recentKey = "documents/t/r/new/a.pdf", liveKey = "documents/t/r/live/b.pdf", lateKey = "documents/t/r/late/c.pdf";
  await putLegacy(stores, recentKey, live, 1000);
  await putLegacy(stores, liveKey, live);
  const rows = new Map([[liveKey, row(live)]]);
  // The recent orphan's row commits after the snapshot (it is moved), while another writer adds an object.
  const counts = await moveLegacyDocuments(stores, rowSource(rows, { beforeCurrent: (_, call) => {
    if (call === 1) {
      rows.set(recentKey, row(live));
      mkdirSync(dirname(join(stores.legacy.root, lateKey)), { recursive: true }); writeFileSync(join(stores.legacy.root, lateKey), live);
    }
  } }), { prefix: "documents/", confirm: true });
  assert.equal(counts.recentOrphans, 1); assert.equal(counts.remaining, 1);
  assert.equal(counts.unexpectedRemaining, 1); assert.equal(movePassed(counts), false);
});

test("rows outside the current prefix are checked by key, tombstones included", async t => {
  const stores = await localStores(t);
  const bytes = Buffer.from("old prefix"), live = "attachments/t/r/a/a.pdf", tombstoned = "attachments/t/r/b/b.pdf";
  await putLegacy(stores, live, bytes);
  await putLegacy(stores, tombstoned, bytes);
  const counts = await moveLegacyDocuments(stores, rowSource(new Map([[live, row(bytes)], [tombstoned, row(bytes, false)]])), { prefix: "documents/", confirm: true });
  assert.equal(counts.moved, 1); assert.equal(counts.deletedTombstoned, 1); assert.equal(movePassed(counts), true);
  assert.equal(await exists(join(stores.legacy.root, live)), false);
  assert.equal(await exists(join(stores.legacy.root, tombstoned)), false);
  assert.deepEqual(await readFile(join(stores.current.root, live)), bytes);
});

test("a private object that differs from the row is a conflict and keeps the public copy", async t => {
  const stores = await localStores(t);
  const bytes = Buffer.from("recorded"), key = "documents/t/r/doc/a.pdf";
  await putLegacy(stores, key, bytes);
  await writeDocumentBytes(stores, key, Buffer.from("other"), "application/pdf");
  const counts = await moveLegacyDocuments(stores, rowSource(new Map([[key, row(bytes)]])), { prefix: "documents/", confirm: true });
  assert.equal(counts.conflicts, 1); assert.equal(counts.remaining, 1); assert.equal(movePassed(counts), false);
});

test("without a legacy location nothing is listed, and the command accepts exactly one mode", async () => {
  const counts = await moveLegacyDocuments({ current: { type: "local", provider: "minio-default", root: "/nonexistent", publicBaseUrl: "https://x.invalid/" }, legacy: null },
    rowSource(new Map()), { prefix: "documents/", confirm: true });
  assert.equal(counts.legacyConfigured, false); assert.equal(movePassed(counts), true);
  assert.equal(parseMoveMode([]), "dry-run");
  assert.equal(parseMoveMode(["--verify"]), "verify");
  assert.equal(parseMoveMode(["--confirm"]), "confirm");
  assert.equal(parseMoveMode(["--restore"]), "restore");
  for (const argv of [["--confirm", "--verify"], ["--confirm", "--restore"], ["--force"], ["confirm"], ["--dry-run"], ["--confirm --restore"]]) {
    assert.throws(() => parseMoveMode(argv), JSON.stringify(argv));
  }
});
