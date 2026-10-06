import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { roomPluginAnonymousEndpoint } from "./anonymous-probe-endpoint.js";

test("MinIO additional route falls back on missing/empty/whitespace override and preserves a nonblank explicit endpoint", () => {
  const fallback = "https://storage.example.test/";
  for (const value of [undefined, "", " \t "]) assert.equal(roomPluginAnonymousEndpoint({ provider: "minio-default" },
    { ROOM_PLUGIN_ANONYMOUS_ENDPOINT: value, MINIO_PUBLIC_BASE_URL: fallback }), fallback);
  assert.equal(roomPluginAnonymousEndpoint({ provider: "minio-default" }, { ROOM_PLUGIN_ANONYMOUS_ENDPOINT: " https://alternate.example.test/ ", MINIO_PUBLIC_BASE_URL: fallback }), "https://alternate.example.test/");
  assert.equal(roomPluginAnonymousEndpoint({ provider: "minio-default" }, { ROOM_PLUGIN_ANONYMOUS_ENDPOINT: "not-an-endpoint", MINIO_PUBLIC_BASE_URL: fallback }), "not-an-endpoint");
});
test("custom S3 has no inferred MinIO/public-assets route when override is absent or blank", () => {
  for (const value of [undefined, "", " \t "]) assert.equal(roomPluginAnonymousEndpoint({ provider: "s3-compatible" },
    { ROOM_PLUGIN_ANONYMOUS_ENDPOINT: value, MINIO_PUBLIC_BASE_URL: "https://minio.example.test/", SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "https://public-assets.example.test/" }), undefined);
  assert.equal(roomPluginAnonymousEndpoint({ provider: "s3-compatible" }, { ROOM_PLUGIN_ANONYMOUS_ENDPOINT: " https://anonymous.example.test/ " }), "https://anonymous.example.test/");
});

const dockerRoot = fileURLToPath(new URL("../../../../infra/docker/", import.meta.url));
const variants = [
  { name: "staging", env: ".env.staging.example", files: ["compose.staging.yml"] },
  { name: "production", env: ".env.production.example", files: ["compose.production.yml"] },
  { name: "selfhost", env: ".env.selfhost.example", files: ["compose.selfhost.yml"] },
  { name: "demo-local", env: ".env.selfhost.example", files: ["compose.selfhost.yml", "compose.demo-local.yml"] }
];
for (const variant of variants) test(`${variant.name} actual Compose model forwards env-file endpoint values to API including override-only environment`, { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "vrata-anonymous-compose-")); t.after(() => rm(root, { recursive: true, force: true }));
  const childEnv = { ...process.env }; delete childEnv.ROOM_PLUGIN_ANONYMOUS_ENDPOINT;
  for (const value of [undefined, "", " \t ", "http://anonymous-proxy.example.test:9000/"]) {
    const extra = join(root, "override.env");
    await writeFile(extra, value === undefined ? "" : `ROOM_PLUGIN_ANONYMOUS_ENDPOINT='${value}'\n`);
    const args = ["compose", "--env-file", join(dockerRoot, variant.env), "--env-file", extra,
      ...variant.files.flatMap(file => ["-f", join(dockerRoot, file)]), "config", "--format", "json"];
    let stdout: string;
    try { ({ stdout } = await promisify(execFile)("docker", args, { env: childEnv, timeout: 20_000, maxBuffer: 1024 * 1024 })); }
    catch { assert.fail("Compose model generation failed; configuration values are intentionally not logged"); }
    const model = JSON.parse(stdout) as { services: { api: { environment: NodeJS.ProcessEnv } } };
    const actual = model.services.api.environment;
    assert.equal(actual.ROOM_PLUGIN_ANONYMOUS_ENDPOINT, value ?? "");
    assert.equal(roomPluginAnonymousEndpoint({ provider: "minio-default" }, actual), value?.trim() || actual.MINIO_PUBLIC_BASE_URL?.trim() || undefined);
  }
});
