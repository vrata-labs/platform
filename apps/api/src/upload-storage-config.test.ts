import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";

import { createUploadStorageConfig } from "./upload-storage-config.js";

const envKeys = [
  "NODE_ENV", "SCENE_BUNDLE_PROVIDER", "DOCUMENT_PROVIDER", "MINIO_ENDPOINT",
  "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "MINIO_BUCKET", "MINIO_PUBLIC_BASE_URL",
  "SCENE_BUNDLE_S3_ENDPOINT", "SCENE_BUNDLE_S3_REGION", "SCENE_BUNDLE_S3_BUCKET",
  "SCENE_BUNDLE_S3_PUBLIC_BASE_URL", "SCENE_BUNDLE_S3_ACCESS_KEY_ID", "SCENE_BUNDLE_S3_SECRET_ACCESS_KEY",
  "SCENE_BUNDLE_LOCAL_UPLOAD_ROOT", "DOCUMENT_LOCAL_UPLOAD_ROOT"
] as const;

function withEnv(values: NodeJS.ProcessEnv, run: () => void): void {
  const before = envKeys.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of envKeys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const minio = {
  MINIO_ROOT_USER: "fixture-user", MINIO_ROOT_PASSWORD: "fixture-password",
  MINIO_BUCKET: "fixture-bucket", MINIO_PUBLIC_BASE_URL: "https://objects.example.test"
};
const s3 = {
  SCENE_BUNDLE_S3_ENDPOINT: "https://s3.example.test", SCENE_BUNDLE_S3_REGION: "fixture-region",
  SCENE_BUNDLE_S3_BUCKET: "fixture-bucket", SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://cdn.example.test",
  SCENE_BUNDLE_S3_ACCESS_KEY_ID: "fixture-key", SCENE_BUNDLE_S3_SECRET_ACCESS_KEY: "fixture-secret"
};
const request = { headers: { host: "example.test" } } as IncomingMessage;
const publicRoot = resolve("fixture-runtime-public");
const create = () => createUploadStorageConfig(publicRoot, () => "https://example.test/nested?query=1#hash");

// No real storage is contacted: these tests exercise only configuration selection.
test("factory construction does not resolve URLs or validate the environment", () => {
  withEnv({ NODE_ENV: "production" }, () => {
    const config = createUploadStorageConfig(publicRoot, () => { throw new Error("must not be called"); });
    assert.deepEqual(Object.keys(config), ["getSceneBundleUploadStorage", "getDocumentUploadStorage"]);
  });
});

for (const [method, rootKey, directory, prefix] of [
  ["getSceneBundleUploadStorage", "SCENE_BUNDLE_LOCAL_UPLOAD_ROOT", "uploaded-scene-bundles", "scene_bundle"],
  ["getDocumentUploadStorage", "DOCUMENT_LOCAL_UPLOAD_ROOT", "uploaded-documents", "document"]
] as const) {
  test(`${method}: unconfigured development uses its original local directory and URL`, () => {
    withEnv({}, () => {
      const result = create()[method](request);
      assert.deepEqual(result, {
        type: "local", provider: "minio-default", root: resolve(publicRoot, "assets", directory),
        publicBaseUrl: `https://example.test/assets/${directory}/`
      });
      assert.deepEqual(Object.keys(result), ["type", "provider", "root", "publicBaseUrl"]);
    });
  });

  test(`${method}: local roots preserve relative, absolute, empty and whitespace values`, () => {
    for (const root of ["relative/../uploads", resolve("absolute-uploads"), "", "  uploads  "]) {
      withEnv({ [rootKey]: root }, () => {
        const result = create()[method](request);
        assert.equal(result.type, "local");
        if (result.type !== "local") assert.fail();
        assert.equal(result.root, resolve(root));
      });
    }
  });

  test(`${method}: MinIO uses unchanged defaults and ordered fields`, () => {
    withEnv({ ...minio, NODE_ENV: "production" }, () => {
      const result = create()[method](request);
      assert.deepEqual(result, {
        type: "s3", provider: "minio-default", endpoint: "http://minio:9000", region: "us-east-1",
        bucket: "fixture-bucket", accessKeyId: "fixture-user", secretAccessKey: "fixture-password"
      });
      assert.deepEqual(Object.keys(result), ["type", "provider", "endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"]);
    });
  });

  test(`${method}: empty MinIO endpoint is retained but empty region uses its fallback`, () => {
    withEnv({ ...minio, MINIO_ENDPOINT: "", SCENE_BUNDLE_S3_REGION: "" }, () => {
      const result = create()[method](request);
      assert.ok(result.type === "s3");
      assert.equal(result.endpoint, "");
      assert.equal(result.region, "us-east-1");
    });
  });

  test(`${method}: MinIO values are passed through without trimming or URL validation`, () => {
    withEnv({ ...minio, MINIO_ENDPOINT: "not a URL", MINIO_ROOT_USER: " user ", MINIO_ROOT_PASSWORD: " pass ",
      MINIO_BUCKET: " bucket ", MINIO_PUBLIC_BASE_URL: " ", SCENE_BUNDLE_S3_REGION: " region " }, () => {
      assert.deepEqual(create()[method](request), {
        type: "s3", provider: "minio-default", endpoint: "not a URL", region: " region ",
        bucket: " bucket ", accessKeyId: " user ", secretAccessKey: " pass "
      });
    });
  });

  test(`${method}: each required MinIO value must be nonempty`, () => {
    for (const key of Object.keys(minio)) for (const value of [undefined, ""]) {
      withEnv({ ...minio, [key]: value }, () => assert.equal(create()[method](request).type, "local"));
      withEnv({ ...minio, [key]: value, NODE_ENV: "production" }, () => {
        assert.throws(() => create()[method](request), { message: `misconfigured_${prefix}_upload_storage:minio-default` });
      });
    }
  });

  test(`${method}: configured S3 uses only its existing configuration fields`, () => {
    withEnv({ ...s3, ...minio, SCENE_BUNDLE_PROVIDER: "s3-compatible", NODE_ENV: "production" }, () => {
      assert.deepEqual(create()[method](request), {
        type: "s3", provider: "s3-compatible", endpoint: s3.SCENE_BUNDLE_S3_ENDPOINT,
        region: s3.SCENE_BUNDLE_S3_REGION, bucket: s3.SCENE_BUNDLE_S3_BUCKET,
        accessKeyId: s3.SCENE_BUNDLE_S3_ACCESS_KEY_ID, secretAccessKey: s3.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY
      });
    });
  });

  test(`${method}: each required S3 value must be nonempty without falling back to MinIO`, () => {
    for (const key of Object.keys(s3)) for (const value of [undefined, ""]) {
      const env = { ...s3, ...minio, SCENE_BUNDLE_PROVIDER: "s3-compatible", [key]: value };
      withEnv(env, () => assert.equal(create()[method](request).type, "local"));
      withEnv({ ...env, NODE_ENV: "production" }, () => {
        assert.throws(() => create()[method](request), { message: `misconfigured_${prefix}_upload_storage:s3-compatible` });
      });
    }
  });

  test(`${method}: S3 accepts nonempty whitespace values without normalization`, () => {
    const values = Object.fromEntries(Object.keys(s3).map((key) => [key, " "]));
    withEnv({ ...values, SCENE_BUNDLE_PROVIDER: "s3-compatible", NODE_ENV: "production" }, () => {
      const result = create()[method](request);
      assert.ok(result.type === "s3");
      for (const key of ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"] as const) assert.equal(result[key], " ");
    });
  });

  test(`${method}: unknown providers preserve local fallback and production errors`, () => {
    for (const provider of ["", "MINIO-DEFAULT", " minio-default ", "unsupported"]) {
      withEnv({ ...minio, ...s3, SCENE_BUNDLE_PROVIDER: provider }, () => {
        const result = create()[method](request);
        assert.equal(result.type, "local");
        assert.equal(result.provider, "minio-default");
      });
      withEnv({ ...minio, ...s3, SCENE_BUNDLE_PROVIDER: provider, NODE_ENV: "production" }, () => {
        assert.throws(() => create()[method](request), { message: `misconfigured_${prefix}_upload_storage:${provider}` });
      });
    }
  });

  test(`${method}: production matching remains exact`, () => {
    for (const nodeEnv of [undefined, "", "test", "Production", "production "]) {
      withEnv({ NODE_ENV: nodeEnv }, () => assert.equal(create()[method](request).type, "local"));
    }
  });

  test(`${method}: URL resolution stays lazy and receives the original request once per local call`, () => {
    let calls = 0;
    const config = createUploadStorageConfig(publicRoot, (value) => {
      assert.strictEqual(value, request);
      calls += 1;
      return `https://host-${calls}.example.test/base`;
    });
    for (const env of [{ ...minio }, { ...s3, SCENE_BUNDLE_PROVIDER: "s3-compatible" }]) {
      withEnv(env, () => assert.equal(config[method](request).type, "s3"));
    }
    withEnv({ NODE_ENV: "production" }, () => assert.throws(() => config[method](request)));
    assert.equal(calls, 0);
    withEnv({}, () => {
      const first = config[method](request);
      const second = config[method](request);
      assert.ok(first.type === "local" && second.type === "local");
      assert.equal(first.publicBaseUrl, `https://host-1.example.test/assets/${directory}/`);
      assert.equal(second.publicBaseUrl, `https://host-2.example.test/assets/${directory}/`);
    });
    assert.equal(calls, 2);
  });

  test(`${method}: local URL callback errors propagate unchanged`, () => {
    withEnv({}, () => {
      const error = new Error("fixture-url-error");
      const config = createUploadStorageConfig(publicRoot, () => { throw error; });
      assert.throws(() => config[method](request), (value) => value === error);
      assert.throws(() => createUploadStorageConfig(publicRoot, () => "not a URL")[method](request), TypeError);
    });
  });

  test(`${method}: environment changes are observed after factory creation`, () => {
    const config = create();
    withEnv({}, () => assert.equal(config[method](request).type, "local"));
    withEnv(minio, () => assert.equal(config[method](request).type, "s3"));
    withEnv({ NODE_ENV: "production" }, () => assert.throws(() => config[method](request)));
    withEnv({}, () => assert.equal(config[method](request).type, "local"));
  });

  test(`${method}: each call allocates a fresh configuration object`, () => {
    for (const env of [{}, minio, { ...s3, SCENE_BUNDLE_PROVIDER: "s3-compatible" }]) {
      withEnv(env, () => {
        const config = create();
        const first = config[method](request);
        const second = config[method](request);
        assert.deepEqual(first, second);
        assert.notStrictEqual(first, second);
      });
    }
  });
}

test("document provider overrides scene provider, including an explicit empty value", () => {
  for (const documentProvider of [undefined, "minio-default", "s3-compatible", ""]) {
    withEnv({ ...minio, ...s3, SCENE_BUNDLE_PROVIDER: "s3-compatible", DOCUMENT_PROVIDER: documentProvider }, () => {
      const config = create();
      assert.equal(config.getSceneBundleUploadStorage(request).provider, "s3-compatible");
      const result = config.getDocumentUploadStorage(request);
      assert.equal(result.type, documentProvider === "" ? "local" : "s3");
      assert.equal(result.provider, documentProvider === "" ? "minio-default" : documentProvider ?? "s3-compatible");
    });
  }
});

test("document provider selects S3 even when scene provider is unset", () => {
  withEnv({ ...minio, ...s3, DOCUMENT_PROVIDER: "s3-compatible" }, () => {
    const config = create();
    assert.equal(config.getSceneBundleUploadStorage(request).provider, "minio-default");
    assert.equal(config.getDocumentUploadStorage(request).provider, "s3-compatible");
  });
});

test("scene and document roots remain independent", () => {
  withEnv({ SCENE_BUNDLE_LOCAL_UPLOAD_ROOT: "scene-files", DOCUMENT_LOCAL_UPLOAD_ROOT: "document-files" }, () => {
    const config = create();
    const scene = config.getSceneBundleUploadStorage(request);
    const document = config.getDocumentUploadStorage(request);
    assert.ok(scene.type === "local" && document.type === "local");
    assert.equal(scene.root, resolve("scene-files"));
    assert.equal(document.root, resolve("document-files"));
  });
});

test("factory instances retain their own injected root and URL resolver", () => {
  withEnv({}, () => {
    for (const name of ["one", "two"]) {
      const config = createUploadStorageConfig(name, () => `https://${name}.example.test`);
      const result = config.getDocumentUploadStorage(request);
      assert.ok(result.type === "local");
      assert.equal(result.root, resolve(join(name, "assets", "uploaded-documents")));
      assert.equal(result.publicBaseUrl, `https://${name}.example.test/assets/uploaded-documents/`);
    }
  });
});
