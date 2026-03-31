import test from "node:test";
import assert from "node:assert/strict";

import { getSceneBundleProviderConfig, resolveSceneBundlePublicUrl } from "./scene-bundle-storage.js";

test("minio default provider resolves public URL", () => {
  const url = resolveSceneBundlePublicUrl("scenes/demo/v1/scene.json", {
    MINIO_PUBLIC_BASE_URL: "http://127.0.0.1:9000",
    MINIO_BUCKET: "noah-scene-bundles"
  } as NodeJS.ProcessEnv);

  assert.equal(url, "http://127.0.0.1:9000/noah-scene-bundles/scenes/demo/v1/scene.json");
});

test("s3-compatible provider resolves public URL", () => {
  const url = resolveSceneBundlePublicUrl("scenes/demo/v2/scene.json", {
    SCENE_BUNDLE_PROVIDER: "s3-compatible",
    SCENE_BUNDLE_S3_ENDPOINT: "https://storage.yandexcloud.net",
    SCENE_BUNDLE_S3_REGION: "ru-central1",
    SCENE_BUNDLE_S3_BUCKET: "noah-scene-bundles",
    SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://storage.example.com/noah-scene-bundles"
  } as NodeJS.ProcessEnv, "s3-compatible");

  assert.equal(url, "https://storage.example.com/noah-scene-bundles/scenes/demo/v2/scene.json");
});

test("provider config fails fast when required env is missing", () => {
  assert.throws(
    () => getSceneBundleProviderConfig({ MINIO_BUCKET: "noah-scene-bundles" } as NodeJS.ProcessEnv),
    /misconfigured_storage_provider:minio-default/
  );

  assert.throws(
    () => getSceneBundleProviderConfig({
      SCENE_BUNDLE_PROVIDER: "s3-compatible",
      SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://storage.example.com/noah-scene-bundles"
    } as NodeJS.ProcessEnv, "s3-compatible"),
    /misconfigured_storage_provider:s3-compatible/
  );
});
