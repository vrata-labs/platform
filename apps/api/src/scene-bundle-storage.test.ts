import test from "node:test";
import assert from "node:assert/strict";

import { getSceneBundleProviderConfig, resolveSceneBundlePublicUrl, type SceneBundleProvider } from "./scene-bundle-storage.js";

test("minio default provider resolves public URL", () => {
  const url = resolveSceneBundlePublicUrl("scenes/demo/v1/scene.json", {
    MINIO_PUBLIC_BASE_URL: "http://127.0.0.1:9000",
    MINIO_BUCKET: "vrata-scene-bundles"
  } as NodeJS.ProcessEnv);

  assert.equal(url, "http://127.0.0.1:9000/vrata-scene-bundles/scenes/demo/v1/scene.json");
});

test("s3-compatible provider resolves public URL", () => {
  const url = resolveSceneBundlePublicUrl("scenes/demo/v2/scene.json", {
    SCENE_BUNDLE_PROVIDER: "s3-compatible",
    SCENE_BUNDLE_S3_ENDPOINT: "https://storage.yandexcloud.net",
    SCENE_BUNDLE_S3_REGION: "ru-central1",
    SCENE_BUNDLE_S3_BUCKET: "vrata-scene-bundles",
    SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://storage.example.com/vrata-scene-bundles"
  } as NodeJS.ProcessEnv, "s3-compatible");

  assert.equal(url, "https://storage.example.com/vrata-scene-bundles/scenes/demo/v2/scene.json");
});

test("provider config fails fast when required env is missing", () => {
  assert.throws(
    () => getSceneBundleProviderConfig({ MINIO_BUCKET: "vrata-scene-bundles" } as NodeJS.ProcessEnv),
    /misconfigured_storage_provider:minio-default/
  );

  assert.throws(
    () => getSceneBundleProviderConfig({
      SCENE_BUNDLE_PROVIDER: "s3-compatible",
      SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://storage.example.com/vrata-scene-bundles"
    } as NodeJS.ProcessEnv, "s3-compatible"),
    /misconfigured_storage_provider:s3-compatible/
  );
});

const minioEnv: NodeJS.ProcessEnv = {
  MINIO_PUBLIC_BASE_URL: "https://storage.example.com/",
  MINIO_BUCKET: "vrata-scene-bundles"
};
const s3Env: NodeJS.ProcessEnv = {
  SCENE_BUNDLE_S3_ENDPOINT: "https://storage.yandexcloud.net",
  SCENE_BUNDLE_S3_REGION: "ru-central1",
  SCENE_BUNDLE_S3_BUCKET: "vrata-scene-bundles",
  SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://storage.example.com/vrata-scene-bundles/"
};

test("unknown environment provider fails before reading storage settings", () => {
  assert.throws(
    () => getSceneBundleProviderConfig({ SCENE_BUNDLE_PROVIDER: "unknown-provider" }),
    { message: "invalid_scene_bundle_provider" }
  );
});

test("unknown environment provider cannot silently use configured S3 storage", () => {
  const env = { ...s3Env, SCENE_BUNDLE_PROVIDER: "unknown-provider" };
  assert.throws(
    () => getSceneBundleProviderConfig(env),
    { message: "invalid_scene_bundle_provider" }
  );
  assert.throws(
    () => resolveSceneBundlePublicUrl("scenes/demo/v1/scene.json", env),
    { message: "invalid_scene_bundle_provider" }
  );
});

test("empty, whitespace and misspelled environment providers are rejected", () => {
  for (const provider of ["", " ", " minio-default ", "MINIO-DEFAULT"]) {
    assert.throws(
      () => getSceneBundleProviderConfig({ ...s3Env, SCENE_BUNDLE_PROVIDER: provider }),
      { message: "invalid_scene_bundle_provider" }
    );
  }
});

test("invalid explicit provider is rejected at runtime", () => {
  const env = { ...s3Env, SCENE_BUNDLE_PROVIDER: "s3-compatible" };
  assert.throws(
    () => getSceneBundleProviderConfig(env, "unknown-provider" as SceneBundleProvider),
    { message: "invalid_scene_bundle_provider" }
  );
});

test("supported environment providers resolve without an explicit override", () => {
  for (const provider of ["minio-default", "s3-compatible"] as const) {
    assert.deepEqual(
      getSceneBundleProviderConfig({ ...minioEnv, ...s3Env, SCENE_BUNDLE_PROVIDER: provider }),
      { provider, publicBaseUrl: "https://storage.example.com/vrata-scene-bundles" }
    );
  }
});

test("explicit provider takes precedence over a different environment provider", () => {
  assert.equal(
    getSceneBundleProviderConfig({ ...minioEnv, SCENE_BUNDLE_PROVIDER: "s3-compatible" }, "minio-default").provider,
    "minio-default"
  );
  assert.equal(
    getSceneBundleProviderConfig({ ...s3Env, SCENE_BUNDLE_PROVIDER: "minio-default" }, "s3-compatible").provider,
    "s3-compatible"
  );
});

test("supported explicit provider still overrides an invalid environment value", () => {
  for (const provider of ["minio-default", "s3-compatible"] as const) {
    assert.equal(
      getSceneBundleProviderConfig({ ...minioEnv, ...s3Env, SCENE_BUNDLE_PROVIDER: "unknown-provider" }, provider).provider,
      provider
    );
  }
});

test("public URL slash normalization is unchanged for both providers", () => {
  for (const provider of ["minio-default", "s3-compatible"] as const) {
    assert.equal(
      resolveSceneBundlePublicUrl("/scenes/demo/v1/scene.json", { ...minioEnv, ...s3Env }, provider),
      "https://storage.example.com/vrata-scene-bundles/scenes/demo/v1/scene.json"
    );
  }
});
