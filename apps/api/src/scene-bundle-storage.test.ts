import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  getSceneBundleProviderConfig,
  getSceneBundleUploadConfig,
  normalizeSceneBundleRelativePath,
  resolveSceneBundlePublicUrl,
  resolveSceneBundleStorageKey,
  uploadSceneBundleObject
} from "./scene-bundle-storage.js";

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

test("scene bundle upload storage key is deterministic and path-safe", () => {
  assert.equal(
    resolveSceneBundleStorageKey("old-room", "v1", "/scene.glb"),
    "scenes/old-room/v1/scene.glb"
  );
  assert.equal(
    resolveSceneBundleStorageKey("old-room", "v1", "docs/ATTRIBUTIONS.md"),
    "scenes/old-room/v1/docs/ATTRIBUTIONS.md"
  );
  assert.equal(normalizeSceneBundleRelativePath("textures/wallpaper_01.png"), "textures/wallpaper_01.png");

  assert.throws(() => normalizeSceneBundleRelativePath("../scene.glb"), /invalid_scene_bundle_file_path/);
  assert.throws(() => normalizeSceneBundleRelativePath("textures//wall.png"), /invalid_scene_bundle_file_path/);
  assert.throws(() => resolveSceneBundleStorageKey("old room", "v1", "scene.glb"), /invalid_scene_bundle_id/);
});

test("minio upload config uses internal endpoint and root credentials", () => {
  const config = getSceneBundleUploadConfig({
    MINIO_PUBLIC_BASE_URL: "https://assets.example.test",
    MINIO_BUCKET: "vrata-scene-bundles",
    MINIO_ROOT_USER: "minio-user",
    MINIO_ROOT_PASSWORD: "minio-password"
  } as NodeJS.ProcessEnv);

  assert.equal(config.provider, "minio-default");
  assert.equal(config.endpoint, "http://minio:9000");
  assert.equal(config.bucket, "vrata-scene-bundles");
  assert.equal(config.forcePathStyle, true);
  assert.equal(config.publicBaseUrl, "https://assets.example.test/vrata-scene-bundles");
});

test("s3-compatible upload config requires write credentials", () => {
  assert.throws(
    () => getSceneBundleUploadConfig({
      SCENE_BUNDLE_PROVIDER: "s3-compatible",
      SCENE_BUNDLE_S3_ENDPOINT: "https://storage.yandexcloud.net",
      SCENE_BUNDLE_S3_REGION: "ru-central1",
      SCENE_BUNDLE_S3_BUCKET: "vrata-scene-bundles",
      SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://storage.example.com/vrata-scene-bundles"
    } as NodeJS.ProcessEnv, "s3-compatible"),
    /misconfigured_scene_bundle_upload:s3-compatible/
  );

  const config = getSceneBundleUploadConfig({
    SCENE_BUNDLE_PROVIDER: "s3-compatible",
    SCENE_BUNDLE_S3_ENDPOINT: "https://storage.yandexcloud.net",
    SCENE_BUNDLE_S3_REGION: "ru-central1",
    SCENE_BUNDLE_S3_BUCKET: "vrata-scene-bundles",
    SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://storage.example.com/vrata-scene-bundles",
    SCENE_BUNDLE_S3_ACCESS_KEY_ID: "key-id",
    SCENE_BUNDLE_S3_SECRET_ACCESS_KEY: "secret-key"
  } as NodeJS.ProcessEnv, "s3-compatible");

  assert.equal(config.provider, "s3-compatible");
  assert.equal(config.endpoint, "https://storage.yandexcloud.net");
  assert.equal(config.region, "ru-central1");
  assert.equal(config.bucket, "vrata-scene-bundles");
});

test("scene bundle upload writes object to configured S3 endpoint", async () => {
  const received = await new Promise<{ url?: string; method?: string; body?: string; contentType?: string }>((resolve, reject) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.writeHead(200);
        response.end();
        server.close((error) => {
          if (error) reject(error);
          else resolve({
            url: request.url,
            method: request.method,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: request.headers["content-type"]
          });
        });
      });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      assert.notEqual(address, null);
      assert.notEqual(typeof address, "string");
      const endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      try {
        const result = await uploadSceneBundleObject({
          storageKey: "scenes/old-room/v1/scene.json",
          body: Buffer.from('{"schemaVersion":1}', "utf8"),
          contentType: "application/json",
          env: {
            MINIO_PUBLIC_BASE_URL: "https://assets.example.test",
            MINIO_BUCKET: "vrata-scene-bundles",
            MINIO_INTERNAL_ENDPOINT: endpoint,
            MINIO_ROOT_USER: "minio-user",
            MINIO_ROOT_PASSWORD: "minio-password"
          } as NodeJS.ProcessEnv
        });

        assert.equal(result.publicUrl, "https://assets.example.test/vrata-scene-bundles/scenes/old-room/v1/scene.json");
        assert.equal(result.sizeBytes, 19);
        assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });

  assert.equal(received.method, "PUT");
  assert.equal(received.url, "/vrata-scene-bundles/scenes/old-room/v1/scene.json?x-id=PutObject");
  assert.equal(received.body, '{"schemaVersion":1}');
  assert.equal(received.contentType, "application/json");
});
