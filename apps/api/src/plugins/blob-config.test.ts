import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { createUploadStorageConfig } from "../upload-storage-config.js";
import { requireRoomPluginBucket, roomPluginUploadStorage } from "./blob-config.js";
import { createRoomPluginBlobStorage } from "./blob-storage.js";
import { RoomPluginBlobConfigurationError } from "./blob-errors.js";

const minio = { NODE_ENV: "production", MINIO_ROOT_USER: "test-key", MINIO_ROOT_PASSWORD: "test-secret", MINIO_ENDPOINT: "http://minio:9000",
  MINIO_BUCKET: "public-assets", MINIO_PUBLIC_BASE_URL: "https://storage.example.test", ROOM_PLUGIN_BUCKET: "private-plugins" };
test("private MinIO config reuses only endpoint/credentials and fingerprints the actual separate bucket", () => {
  const config = roomPluginUploadStorage("/runtime/public", minio);
  assert.equal(config.type, "s3"); if (config.type !== "s3") assert.fail();
  assert.equal(config.bucket, "private-plugins"); assert.equal(config.endpoint, minio.MINIO_ENDPOINT);
  const withoutPublic = { ...minio, MINIO_BUCKET: undefined, MINIO_PUBLIC_BASE_URL: undefined };
  assert.deepEqual(roomPluginUploadStorage("/runtime/public", withoutPublic), config);
  assert.notEqual(createRoomPluginBlobStorage(config).backendFingerprint,
    createRoomPluginBlobStorage({ ...config, bucket: "public-assets" }).backendFingerprint);
});
test("remote plugins have no public bucket fallback or boolean privacy attestation", () => {
  for (const env of [{ ...minio, ROOM_PLUGIN_BUCKET: undefined }, { ...minio, ROOM_PLUGIN_BUCKET: "public-assets" },
    { ...minio, ROOM_PLUGIN_BUCKET: " public-assets " }, { ...minio, ROOM_PLUGIN_BUCKET: "private/path" },
    { ...minio, ROOM_PLUGIN_BUCKET: "private-plugins", SCENE_BUNDLE_S3_BUCKET: "private-plugins" },
    { ...minio, ROOM_PLUGIN_BUCKET: undefined, ROOM_PLUGIN_PRIVATE: "true" }]) {
    assert.throws(() => roomPluginUploadStorage("/runtime/public", env), RoomPluginBlobConfigurationError);
  }
  assert.throws(() => requireRoomPluginBucket({ ROOM_PLUGIN_BUCKET: "public-assets", MINIO_BUCKET: "/public-assets/" }), RoomPluginBlobConfigurationError);
});
test("custom S3 plugins require an operator-provisioned private bucket independent of public URLs/buckets", () => {
  const env = { NODE_ENV: "production", DOCUMENT_PROVIDER: "s3-compatible", SCENE_BUNDLE_S3_ENDPOINT: "https://objects.example.test/",
    SCENE_BUNDLE_S3_REGION: "region", SCENE_BUNDLE_S3_ACCESS_KEY_ID: "test-key", SCENE_BUNDLE_S3_SECRET_ACCESS_KEY: "test-secret",
    ROOM_PLUGIN_BUCKET: "private-plugins" };
  const config = roomPluginUploadStorage("/runtime/public", env);
  assert.equal(config.type, "s3"); if (config.type !== "s3") assert.fail();
  assert.equal(config.bucket, "private-plugins");
  assert.throws(() => roomPluginUploadStorage("/runtime/public", { ...env, ROOM_PLUGIN_BUCKET: undefined }), RoomPluginBlobConfigurationError);
  assert.throws(() => roomPluginUploadStorage("/runtime/public", { ...env, SCENE_BUNDLE_S3_BUCKET: "private-plugins" }), RoomPluginBlobConfigurationError);
});
test("private bucket selection leaves existing public scene/document storage configuration unchanged", t => {
  const old = { ...process.env }; t.after(() => { process.env = old; });
  Object.assign(process.env, minio); delete process.env.DOCUMENT_PROVIDER; delete process.env.SCENE_BUNDLE_PROVIDER;
  const config = createUploadStorageConfig("/runtime/public", () => "https://app.example.test");
  const request = {} as IncomingMessage;
  for (const storage of [config.getDocumentUploadStorage(request), config.getSceneBundleUploadStorage(request)]) {
    assert.equal(storage.type, "s3"); if (storage.type !== "s3") assert.fail();
    assert.equal(storage.bucket, "public-assets");
  }
  assert.equal(roomPluginUploadStorage("/runtime/public").type, "s3");
});
