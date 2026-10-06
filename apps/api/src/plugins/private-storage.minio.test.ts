import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { PostgresStorage } from "../storage.js";
import { roomPluginUploadStorage } from "./blob-config.js";
import { verifyPluginPrivateStorage, PluginPrivateStorageVerificationFailed } from "./verify-private-storage.js";

const endpoint = process.env.VRATA_TEST_PLUGIN_MINIO_ENDPOINT;
test("real MinIO private namespace proof, public-bucket rejection and compiled operator CLI", {
  skip: !endpoint, timeout: 120_000
}, async t => {
  const accessKey = process.env.VRATA_TEST_PLUGIN_MINIO_ACCESS_KEY;
  const secretKey = process.env.VRATA_TEST_PLUGIN_MINIO_SECRET_KEY;
  const privateBucket = process.env.VRATA_TEST_PLUGIN_MINIO_PRIVATE_BUCKET;
  const publicBucket = process.env.VRATA_TEST_PLUGIN_MINIO_PUBLIC_BUCKET;
  assert.ok(endpoint && accessKey && secretKey && privateBucket && publicBucket && privateBucket !== publicBucket && process.env.VRATA_TEST_POSTGRES_URL,
    "real fixture needs credentials, separate private/public buckets and Postgres; no automatic bucket/policy creation");
  const sensitiveValues: readonly string[] = [endpoint, accessKey, secretKey, privateBucket, publicBucket];
  const schema = `private_minio_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  await root.query(`create schema "${schema}"`);
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href, max: 1 });
  t.after(async () => { await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const storage = new PostgresStorage(pool); await storage.init();
  const env = { ...process.env, NODE_ENV: "production", DOCUMENT_PROVIDER: "minio-default", SCENE_BUNDLE_PROVIDER: "minio-default",
    MINIO_ENDPOINT: endpoint, MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey, MINIO_BUCKET: publicBucket,
    ROOM_PLUGIN_BUCKET: privateBucket, SCENE_BUNDLE_S3_REGION: "us-east-1", MINIO_PUBLIC_BASE_URL: endpoint,
    ROOM_PLUGIN_ANONYMOUS_ENDPOINT: endpoint, POSTGRES_URL: connection.href };
  const config = roomPluginUploadStorage("/runtime/public", env);
  assert.equal(config.type, "s3"); if (config.type !== "s3") assert.fail();
  const before = await storage.listRooms();
  let published = 0;
  const original = storage.roomPlugins.publishPackage;
  storage.roomPlugins.publishPackage = async (...args) => { published++; return original(...args); };

  await t.test("actual signed PUT/GET prove bytes while anonymous access to private bucket is 403", async () => {
    const checks = await verifyPluginPrivateStorage(storage, config, { publicEndpoint: endpoint });
    assert.equal(checks.signedPut, true); assert.equal(checks.signedReadExact, true);
    assert.equal(checks.anonymousDenied, true); assert.equal(checks.publicEndpointDenied, true);
    assert.equal(checks.roomCleanup, true); assert.equal(checks.blobMetadataCleanup, true);
    assert.equal(published, 0); assert.deepEqual(await storage.listRooms(), before);
  });
  await t.test("actually public namespace fails privacy despite signed exact bytes; known fixture cleanup preserves public policy", async () => {
    await assert.rejects(verifyPluginPrivateStorage(storage, { ...config, bucket: publicBucket }), (error: unknown) => {
      assert.ok(error instanceof PluginPrivateStorageVerificationFailed);
      assert.equal(error.checks.signedReadExact, true); assert.equal(error.checks.anonymousDenied, false);
      assert.equal(error.checks.noPackagePublication, true); assert.equal(error.checks.blobMetadataCleanup, true); assert.equal(error.checks.roomCleanup, true);
      return true;
    });
    assert.equal(published, 0); assert.deepEqual(await storage.listRooms(), before);
  });
  await t.test("deployed-style compiled CLI logs only boolean checks and leaves no owned room metadata", async () => {
    for (const override of [undefined, "", " \t ", endpoint]) {
      const cliEnv: NodeJS.ProcessEnv = { ...env };
      if (override === undefined) delete cliEnv.ROOM_PLUGIN_ANONYMOUS_ENDPOINT; else cliEnv.ROOM_PLUGIN_ANONYMOUS_ENDPOINT = override;
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./verify-private-storage.js", import.meta.url))],
        { env: cliEnv, timeout: 60_000, maxBuffer: 4096 });
      assert.equal(stderr, "");
      const result = JSON.parse(stdout) as Record<string, unknown>;
      assert.equal(result.ok, true); assert.equal(result.publicEndpointChecked, true); assert.equal(result.publicEndpointDenied, true);
      assert.ok(Object.values(result).every(value => typeof value === "boolean"));
      assert.deepEqual(await storage.listRooms(), before);
      for (const value of sensitiveValues) assert.equal(stdout.includes(value), false);
    }
  });
  await t.test("nonblank wrong endpoint fails instead of rewriting or falling back after successful mandatory direct proof", async () => {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("./verify-private-storage.js", import.meta.url))],
      { env: { ...env, ROOM_PLUGIN_ANONYMOUS_ENDPOINT: "http://127.0.0.1:1/" }, timeout: 60_000, maxBuffer: 4096 }), (error: unknown) => {
      const child = error as { stdout: string; stderr: string; code: number };
      assert.equal(child.code, 1); assert.equal(child.stderr, "");
      const result = JSON.parse(child.stdout) as Record<string, unknown>;
      assert.equal(result.ok, false); assert.equal(result.signedReadExact, true); assert.equal(result.anonymousDenied, true);
      assert.equal(result.publicEndpointChecked, true); assert.equal(result.publicEndpointDenied, false);
      assert.equal(result.roomCleanup, true); assert.equal(result.noPackagePublication, true);
      assert.ok(Object.values(result).every(value => typeof value === "boolean")); return true;
    });
    assert.deepEqual(await storage.listRooms(), before); assert.equal(published, 0);
  });
});
