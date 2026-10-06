import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";

import {
  createBackupManifest,
  createTempBackupDir,
  findPruneCandidates,
  main,
  parseBackupRestoreArgs,
  formatBackupManifestIssues,
  isSafeImageTag,
  inspectRestoreDump,
  redactText,
  runSmokeChecks,
  updateImageTagInEnvText,
  validateBackupManifest
} from "./backup-restore.mjs";

function writeSampleBackupFiles(backupDir) {
  mkdirSync(join(backupDir, "minio", "objects", "scenes", "demo"), { recursive: true });
  writeFileSync(join(backupDir, "postgres.sql"), "create table rooms(id text);\n");
  writeFileSync(join(backupDir, "minio", "objects.jsonl"), "{\"key\":\"scenes/demo/scene.json\"}\n");
  writeFileSync(join(backupDir, "minio", "objects", "scenes", "demo", "scene.json"), "{\"glbPath\":\"scene.glb\"}\n");
}

test("backup manifest validation accepts complete artifacts", async () => {
  const backupDir = createTempBackupDir();
  try {
    writeSampleBackupFiles(backupDir);
    const manifest = await createBackupManifest({
      backupDir,
      source: {
        imageTag: "0.1.0",
        platformVersion: "0.1.0",
        gitCommit: "a".repeat(40),
        profile: "selfhost",
        composeFile: "compose.selfhost.yml",
        envFile: ".env.selfhost"
      },
      smoke: { roomId: "demo-room" },
      createdAt: "2026-06-19T00:00:00.000Z"
    });

    const result = await validateBackupManifest(manifest, { backupDir });
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
    assert.equal(manifest.artifacts.some((artifact) => artifact.kind === "postgres-dump"), true);
    assert.equal(manifest.artifacts.some((artifact) => artifact.kind === "minio-inventory"), true);
    assert.equal(manifest.artifacts.some((artifact) => artifact.kind === "minio-object"), true);
    assert.equal(manifest.source.platformVersion, "0.1.0");
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }
});

test("backup manifest validation rejects corrupt artifacts", async () => {
  const backupDir = createTempBackupDir();
  try {
    writeSampleBackupFiles(backupDir);
    const manifest = await createBackupManifest({
      backupDir,
      source: {
        imageTag: "0.1.0",
        platformVersion: "0.1.0",
        gitCommit: "a".repeat(40),
        profile: "selfhost",
        composeFile: "compose.selfhost.yml",
        envFile: ".env.selfhost"
      },
      smoke: { roomId: "demo-room" }
    });
    writeFileSync(join(backupDir, "postgres.sql"), "corrupted\n");

    const result = await validateBackupManifest(manifest, { backupDir });
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.code === "artifact_sha256_mismatch"), true);
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }
});

test("backup manifest validation rejects unsafe artifact paths", async () => {
  const result = await validateBackupManifest({
    schemaVersion: 1,
    createdAt: "2026-06-19T00:00:00.000Z",
    source: {
      imageTag: "0.1.0",
      gitCommit: "a".repeat(40),
      profile: "selfhost",
      composeFile: "compose.selfhost.yml",
      envFile: ".env.selfhost"
    },
    artifacts: [
      { path: "../postgres.sql", kind: "postgres-dump", bytes: 1, sha256: "a".repeat(64) },
      { path: "minio/objects.jsonl", kind: "minio-inventory", bytes: 1, sha256: "b".repeat(64) }
    ]
  }, { checkFiles: false });

  assert.equal(result.ok, false);
  assert.equal(formatBackupManifestIssues(result.issues).some((line) => line.includes("invalid_artifact_path")), true);
});

test("backup manifest validation requires platform version metadata", async () => {
  const result = await validateBackupManifest({
    schemaVersion: 1,
    createdAt: "2026-06-19T00:00:00.000Z",
    source: {
      imageTag: "0.1.0",
      gitCommit: "a".repeat(40),
      profile: "selfhost",
      composeFile: "compose.selfhost.yml",
      envFile: ".env.selfhost"
    },
    artifacts: [
      { path: "postgres.sql", kind: "postgres-dump", bytes: 1, sha256: "a".repeat(64) },
      { path: "minio/objects.jsonl", kind: "minio-inventory", bytes: 1, sha256: "b".repeat(64) }
    ]
  }, { checkFiles: false });

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "missing_source_field" && issue.path === "source.platformVersion"), true);
});

test("rollback env update validates image tags and preserves other values", () => {
  assert.equal(isSafeImageTag("0.1.1"), true);
  assert.equal(isSafeImageTag("9040380a9fdcd3bd80efad86650eab404904b39e"), true);
  assert.equal(isSafeImageTag("latest"), false);

  const updated = updateImageTagInEnvText("A=1\nIMAGE_TAG=0.1.0\nB=2\n", "0.1.1");
  assert.equal(updated.includes("A=1"), true);
  assert.equal(updated.includes("IMAGE_TAG=0.1.1"), true);
  assert.equal(updated.includes("B=2"), true);
  assert.throws(() => updateImageTagInEnvText("A=1\n", "latest"), /invalid_image_tag/);
});

test("backup log redaction hides secret env values", () => {
  const redacted = redactText("failed with password postgres_password_123 and minio-user and s3-access-key", {
    POSTGRES_PASSWORD: "postgres_password_123", MINIO_ROOT_USER: "minio-user", SCENE_BUNDLE_S3_ACCESS_KEY_ID: "s3-access-key"
  });
  assert.equal(redacted.includes("postgres_password_123"), false);
  assert.equal(redacted.includes("minio-user"), false);
  assert.equal(redacted.includes("s3-access-key"), false);
  assert.equal(redacted.includes("[redacted]"), true);
});

test("backup smoke check opens restored room and scene bundle", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === "/rooms/restored-room") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>room</html>");
      return;
    }
    if (url.pathname === "/api/rooms/restored-room/manifest") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sceneBundle: { url: "/assets/scenes/restored/scene.json" } }));
      return;
    }
    if (url.pathname === "/assets/scenes/restored/scene.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 1 }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await runSmokeChecks({
      baseUrl: `http://127.0.0.1:${address.port}`,
      roomId: "restored-room"
    });
    assert.equal(result.ok, true);
    assert.deepEqual(requests, [
      "/health",
      "/rooms/restored-room",
      "/api/rooms/restored-room/manifest",
      "/assets/scenes/restored/scene.json"
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("backup prune selects only old backup directories", () => {
  const outputDir = createTempBackupDir();
  try {
    const oldDir = join(outputDir, "vrata-2026-01-01T00-00-00-000Z-0.1.0");
    const newDir = join(outputDir, "vrata-2026-06-19T00-00-00-000Z-0.1.1");
    const otherDir = join(outputDir, "notes");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    mkdirSync(otherDir);
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    const newDate = new Date("2026-06-18T00:00:00.000Z");
    utimesSync(oldDir, oldDate, oldDate);
    utimesSync(newDir, newDate, newDate);
    utimesSync(otherDir, oldDate, oldDate);

    const candidates = findPruneCandidates(outputDir, 14, Date.parse("2026-06-19T00:00:00.000Z"));
    assert.deepEqual(candidates, [oldDir]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("backup CLI parser ignores pnpm argument separator", () => {
  const parsed = parseBackupRestoreArgs(["backup", "--", "--env-file", "infra/docker/.env.selfhost"]);
  assert.equal(parsed.command, "backup");
  assert.equal(parsed.options["env-file"], "infra/docker/.env.selfhost");
});

test("rollback preflight requires smoke URL before editing env file", async () => {
  const root = createTempBackupDir();
  try {
    const envFile = join(root, ".env.selfhost");
    const composeFile = join(root, "compose.selfhost.yml");
    const envText = "IMAGE_TAG=0.1.0\nPOSTGRES_PASSWORD=secret-password\n";
    writeFileSync(envFile, envText);
    writeFileSync(composeFile, "services: {}\n");

    await assert.rejects(() => main([
      "rollback",
      "--previous-image-tag",
      "0.1.1",
      "--env-file",
      envFile,
      "--compose-file",
      composeFile,
      "--confirm-rollback"
    ]), /rollback_requires_smoke_base_url/);
    assert.equal(readFileSync(envFile, "utf8"), envText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pluginBytes = Buffer.from('{"manifest":{"id":"fixture"},"source":"export default {}"}\n');
const pluginKey = `room-plugins/74656e616e74/726f6f6d/00000000-0000-4000-8000-000000000001/${hash(pluginBytes)}.vrata-plugin.json`;
const publicKey = "scenes/demo/scene.json";
const restorePrefix = "SET LOCAL client_encoding TO 'UTF8';\nSET LOCAL standard_conforming_strings TO on;\n";

function pluginDump(storage, rows = [{ state: "ready" }]) {
  const columns = ["storage_key", "state", "byte_length", "artifact_sha256", "backend_fingerprint"];
  const fingerprint = storage && hash(JSON.stringify(["s3-v1", storage.MINIO_ENDPOINT, storage.SCENE_BUNDLE_S3_REGION, storage.ROOM_PLUGIN_BUCKET]));
  return `COPY public.room_plugin_packages (${columns.join(", ")}) FROM stdin;\n` + rows.map(row =>
    [row.key ?? pluginKey, row.state, pluginBytes.length, hash(pluginBytes), row.fingerprint ?? fingerprint ?? "\\N"].join("\t") + "\n").join("") + "\\.\n";
}

function writeBucketExport(root, objects, policy = {}) {
  mkdirSync(join(root, "objects"), { recursive: true });
  const inventory = [];
  for (const [key, bytes] of objects) {
    const file = join(root, "objects", key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    inventory.push({ status: "success", type: "file", key, size: bytes.length });
  }
  writeFileSync(join(root, "objects.jsonl"), inventory.map(entry => JSON.stringify(entry)).join("\n"));
  writeFileSync(join(root, "bucket-policy.json"), JSON.stringify(policy));
}

function fakeDeployment(t, { privateConfigured = true, rows, provider = "minio-default", profile = "selfhost" } = {}) {
  const root = createTempBackupDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const api = { MINIO_BUCKET: "public-scenes", MINIO_ENDPOINT: "http://minio:9000/", SCENE_BUNDLE_S3_REGION: "us-east-1",
    MINIO_ROOT_USER: "fixture-user", MINIO_ROOT_PASSWORD: "fixture-password", SCENE_BUNDLE_PROVIDER: provider,
    POSTGRES_URL: "postgresql://fixture-owner:fixture-password@postgres:5432/fixture",
    ...(privateConfigured ? { ROOM_PLUGIN_BUCKET: "private-plugins" } : {}) };
  const config = { services: { api: { environment: api }, "minio-bootstrap": { environment: { ...api } },
    postgres: { environment: { POSTGRES_USER: "fixture-owner", POSTGRES_DB: "fixture" } } } };
  const envFile = join(root, ".env.fixture");
  const composeFile = join(root, `compose.${profile}.yml`);
  // Deliberately no ROOM_PLUGIN_BUCKET in the env file: Compose's effective API config is authoritative.
  writeFileSync(envFile, "IMAGE_TAG=fixture\nVRATA_APP_BASE_URL=http://fixture.invalid\n");
  writeFileSync(composeFile, "services: {}\n");
  const backupDir = join(root, "backup");
  const calls = [];
  const publicObjects = new Map([[publicKey, Buffer.from('{"scene":"public"}\n')]]);
  const privateObjects = new Map(privateConfigured ? [[pluginKey, pluginBytes]] : []);
  const fixture = { root, backupDir, api, config, calls, publicObjects, privateObjects, privatePolicy: {}, restoredSql: null,
    targetCatalog: [], targetPluginEmpty: true, schemaQueries: ["CREATE TABLE public.room_plugin_state (marker integer);"],
    dump: pluginDump(privateConfigured ? api : null, rows ?? (privateConfigured ? [{ state: "ready" }] : [])) };
  const mounts = args => args.flatMap((arg, index) => arg === "-v" ? [args[index + 1]] : []);
  const mountRoot = (args, target) => mounts(args).find(value => value.endsWith(`:${target}`) || value.endsWith(`:${target}:ro`))?.split(":")[0];
  fixture.operations = {
    captureCompose(_compose, args) {
      if (args[0] === "config") { assert.deepEqual(args, ["config", "--format", "json"]); return JSON.stringify(config); }
      if (args[0] === "exec" && args[2] === "api") {
        assert.ok(args.at(-1).includes('import("./apps/api/dist/plugins/postgres-schema.js")'));
        return JSON.stringify(fixture.schemaQueries);
      }
      assert.equal(args[2], "postgres");
      if (args.at(-1).includes("from pg_class")) return JSON.stringify(fixture.targetCatalog);
      assert.ok(args.at(-1).startsWith("select not (exists(select 1 from public.room_plugin_bindings)"));
      const empty = fixture.targetPluginEmpty;
      fixture.afterReadOnlyPreflight?.();
      return empty ? "t\n" : "f\n";
    },
    runCompose(_compose, args, io = {}) {
      calls.push(args);
      if (args[0] === "images") { writeFileSync(io.stdoutFile, "fixture-images\n"); return; }
      if (args[0] === "exec") {
        if (io.stdoutFile) writeFileSync(io.stdoutFile, fixture.dump);
        else {
          assert.ok(args.at(-1).includes("psql -X --single-transaction -v ON_ERROR_STOP=1"));
          const sql = readFileSync(io.stdinFile, "utf8");
          if (fixture.targetCatalog.some(row => row.name === "room_plugin_packages")) {
            const lockIndex = sql.indexOf("LOCK TABLE public.room_plugin_bindings");
            const doIndex = sql.indexOf("DO $vrata_restore$ BEGIN IF NOT");
            const recheckIndex = sql.indexOf("RAISE EXCEPTION 'legacy_restore_requires_empty_plugin_tables'");
            const dropIndex = sql.indexOf("DROP TABLE public.room_plugin_bindings;");
            assert.ok(lockIndex >= 0 && doIndex > lockIndex && recheckIndex > doIndex && dropIndex > recheckIndex,
              "actual empty-table DO recheck must execute after lock and before DROP");
            if (!fixture.targetPluginEmpty) throw new Error("legacy_restore_requires_empty_plugin_tables");
          }
          if (fixture.sqlFailure) throw new Error("injected_sql_failure");
          fixture.restoredSql = sql;
        }
        return;
      }
      assert.equal(args[0], "run");
      const script = args.at(-1);
      const isPrivate = script.includes("$ROOM_PLUGIN_BUCKET");
      const objects = isPrivate ? privateObjects : publicObjects;
      const root = mountRoot(args, "/backup");
      if (!script.includes("--remove")) {
        writeBucketExport(root, objects, isPrivate ? fixture.privatePolicy : { Statement: [{ Effect: "Allow", Principal: "*" }] });
        fixture.exportMutation?.(root, isPrivate);
        return;
      }
      if (isPrivate) {
        const noneIndex = script.indexOf("mc anonymous set none");
        const mirrorIndex = script.indexOf("mc mirror");
        assert.ok(noneIndex >= 0 && mirrorIndex > noneIndex, "private policy none must execute before loading private bytes");
        assert.equal(script.includes("anonymous set download"), false);
        assert.equal(script.includes("$MINIO_BUCKET"), false);
        if (noneIndex >= 0) fixture.privatePolicy = fixture.restorePolicy ?? {};
      } else {
        assert.ok(script.includes("anonymous set download"));
        assert.equal(script.includes("$ROOM_PLUGIN_BUCKET"), false);
      }
      objects.clear();
      const inventory = readFileSync(join(root, "objects.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
      for (const entry of inventory) objects.set(entry.key, readFileSync(join(root, "objects", entry.key)));
      const verifyRoot = mountRoot(args, "/verify");
      if (verifyRoot) {
        fixture.restoreMutation?.(objects);
        writeBucketExport(verifyRoot, objects, fixture.privatePolicy);
      }
    },
    async smoke() { fixture.smokeRan = true; return { ok: true }; }
  };
  fixture.backup = () => main(["backup", "--env-file", envFile, "--compose-file", composeFile, "--backup-dir", backupDir], fixture.operations);
  fixture.restore = () => main(["restore", "--env-file", envFile, "--compose-file", composeFile, "--backup-dir", backupDir, "--confirm-restore"], fixture.operations);
  fixture.manifest = () => JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"));
  fixture.tamperedArchive = async dump => {
    fixture.dump = "CREATE TABLE public.rooms (room_id text);\n";
    await fixture.backup();
    fixture.dump = dump;
    writeFileSync(join(backupDir, "postgres.sql"), dump);
    const previous = fixture.manifest();
    writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(await createBackupManifest({ backupDir, source: previous.source, smoke: previous.smoke })), { mode: 0o600 });
    calls.length = 0;
  };
  return fixture;
}

test("compose backup and restore preserve private plugin namespace, checksums, SQL references and public policy", async t => {
  for (const profile of ["selfhost", "production"]) {
    await t.test(profile, async t => {
      const fixture = fakeDeployment(t, { profile });
      await fixture.backup();
      const manifest = fixture.manifest();
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.source.profile, profile);
      assert.equal(manifest.roomPlugins.bucket, "private-plugins");
      assert.equal(manifest.roomPlugins.publicBucket, "public-scenes");
      assert.equal(manifest.roomPlugins.metadataCount, 1);
      assert.equal(manifest.roomPlugins.anonymousPolicy, "none");
      assert.equal(manifest.artifacts.filter(artifact => artifact.kind.startsWith("room-plugin-")).length, 3);
      assert.equal(manifest.artifacts.find(artifact => artifact.kind === "room-plugin-object").sha256, hash(pluginBytes));
      assert.ok(!JSON.stringify(manifest).includes(fixture.api.MINIO_ROOT_PASSWORD));
      assert.ok(!JSON.stringify(fixture.calls).includes(fixture.api.MINIO_ROOT_PASSWORD));
      assert.ok(!JSON.stringify(manifest).includes(fixture.api.MINIO_ROOT_USER));
      fixture.privateObjects.clear(); fixture.publicObjects.clear(); fixture.privatePolicy = { Statement: [{ Effect: "Allow", Principal: "*" }] };
      fixture.privateObjects.set("stale-object", Buffer.from("stale"));
      await fixture.restore();
      assert.deepEqual(fixture.privateObjects, new Map([[pluginKey, pluginBytes]]));
      assert.deepEqual(fixture.privatePolicy, {});
      assert.equal(fixture.publicObjects.has(publicKey), true);
      assert.equal(fixture.restoredSql, `${restorePrefix}${fixture.dump}\n`);
      assert.equal(fixture.smokeRan, true);
    });
  }
});

test("legacy schema-1 backup/restore needs no private configuration and does not touch the new private bucket", async t => {
  const fixture = fakeDeployment(t, { privateConfigured: false });
  await fixture.backup();
  assert.equal(fixture.manifest().schemaVersion, 1);
  fixture.api.ROOM_PLUGIN_BUCKET = "private-plugins";
  fixture.privateObjects.set(pluginKey, pluginBytes);
  await fixture.restore();
  assert.deepEqual(fixture.privateObjects, new Map([[pluginKey, pluginBytes]]));
  assert.equal(fixture.calls.some(args => args.at(-1)?.includes("$ROOM_PLUGIN_BUCKET")), false);
});

test("backup refuses plugin SQL metadata with missing config, unknown fingerprint, or unsupported S3 provider", async t => {
  for (const [name, options, error] of [
    ["missing private config", { privateConfigured: false, rows: [{ state: "ready" }] }, /plugin_storage_not_captured/],
    ["different backend", { rows: [{ state: "ready", fingerprint: "a".repeat(64) }] }, /plugin_metadata_backend_not_captured/],
    ["legacy null backend", { rows: [{ state: "ready", fingerprint: "\\N" }] }, /plugin_metadata_backend_not_captured/],
    ["external S3", { provider: "s3-compatible" }, /provider_not_supported/]
  ]) {
    await t.test(name, async t => {
      const fixture = fakeDeployment(t, options);
      await assert.rejects(fixture.backup(), error);
      assert.equal(existsSync(join(fixture.backupDir, "manifest.json")), false);
      assert.equal(fixture.calls.some(args => args.at(-1)?.includes("mc mirror")), false);
    });
  }
});

test("private inventory entries must have actual bytes before backup can succeed", async t => {
  const fixture = fakeDeployment(t);
  fixture.exportMutation = (root, isPrivate) => { if (isPrivate) rmSync(join(root, "objects", pluginKey)); };
  await assert.rejects(fixture.backup(), /backup_manifest_invalid/);
  assert.equal(existsSync(join(fixture.backupDir, "manifest.json")), false);
});

test("private ready package cannot be silently skipped even when the mirrored bucket is empty", async t => {
  const fixture = fakeDeployment(t);
  fixture.privateObjects.clear();
  await assert.rejects(fixture.backup(), /backup_manifest_invalid/);
});

test("private package bytes must match SQL content hash, not just their freshly calculated manifest hash", async t => {
  const fixture = fakeDeployment(t);
  fixture.privateObjects.set(pluginKey, Buffer.alloc(pluginBytes.length, 65));
  await assert.rejects(fixture.backup(), /backup_manifest_invalid/);
});

test("pending uploads/deletes may be absent but their private backend must still be captured", async t => {
  const fixture = fakeDeployment(t, { rows: [{ state: "reserved" }, { state: "cleanup-pending", key: "room-plugins/pending-delete" }] });
  fixture.privateObjects.clear();
  await fixture.backup();
  assert.equal(fixture.manifest().roomPlugins.metadataCount, 2);
  assert.equal(fixture.manifest().artifacts.filter(artifact => artifact.kind === "room-plugin-object").length, 0);
});

test("schema-1 manifest containing plugin metadata refuses restore before any compose writes", async t => {
  const fixture = fakeDeployment(t, { privateConfigured: false });
  await fixture.backup();
  fixture.dump = pluginDump(fixture.api);
  writeFileSync(join(fixture.backupDir, "postgres.sql"), fixture.dump);
  const legacy = await createBackupManifest({ backupDir: fixture.backupDir });
  writeFileSync(join(fixture.backupDir, "manifest.json"), JSON.stringify(legacy));
  fixture.calls.length = 0;
  await assert.rejects(fixture.restore(), /backup_manifest_invalid/);
  assert.equal(fixture.calls.length, 0);
});

test("private checksum, inventory and namespace validation reject incomplete or unmanifested archives", async t => {
  for (const [name, mutate, code] of [
    ["missing bytes", fixture => rmSync(join(fixture.backupDir, "room-plugins", "objects", pluginKey)), "missing_artifact_file"],
    ["corrupt checksum", fixture => writeFileSync(join(fixture.backupDir, "room-plugins", "objects", pluginKey), Buffer.alloc(pluginBytes.length)), "artifact_sha256_mismatch"],
    ["missing object manifest entry", (_fixture, manifest) => { manifest.artifacts = manifest.artifacts.filter(artifact => artifact.kind !== "room-plugin-object"); }, "plugin_inventory_missing_or_mismatched_object"],
    ["missing inventory", (_fixture, manifest) => { manifest.artifacts = manifest.artifacts.filter(artifact => artifact.kind !== "room-plugin-inventory"); }, "missing_required_artifact"],
    ["disguised private object", (_fixture, manifest) => { manifest.artifacts.find(artifact => artifact.kind === "room-plugin-object").kind = "minio-object"; }, "plugin_artifact_wrong_kind_or_namespace"],
    ["unmanifested bytes", fixture => writeFileSync(join(fixture.backupDir, "room-plugins", "objects", "extra"), "secret"), "plugin_unmanifested_file"],
    ["symlink bytes", fixture => { const file = join(fixture.backupDir, "room-plugins", "objects", pluginKey); rmSync(file); symlinkSync(join(fixture.backupDir, "postgres.sql"), file); }, "artifact_not_regular_file"],
    ["downgraded version", (_fixture, manifest) => { manifest.schemaVersion = 1; }, "plugin_storage_requires_schema_2"],
    ["missing storage locator", (_fixture, manifest) => { delete manifest.roomPlugins; }, "plugin_storage_requires_schema_2"]
  ]) {
    await t.test(name, async t => {
      const fixture = fakeDeployment(t);
      await fixture.backup();
      const manifest = fixture.manifest(); mutate(fixture, manifest);
      const result = await validateBackupManifest(manifest, { backupDir: fixture.backupDir });
      assert.equal(result.ok, false);
      assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result.issues));
      writeFileSync(join(fixture.backupDir, "manifest.json"), JSON.stringify(manifest));
      fixture.calls.length = 0;
      await assert.rejects(fixture.restore(), /backup_manifest_invalid/);
      assert.equal(fixture.calls.length, 0);
    });
  }
});

test("restore checks immutable locator before changing SQL or objects; credential rotation is accepted", async t => {
  for (const field of ["ROOM_PLUGIN_BUCKET", "MINIO_ENDPOINT", "SCENE_BUNDLE_S3_REGION", "MINIO_BUCKET"]) {
    await t.test(field, async t => {
      const fixture = fakeDeployment(t); await fixture.backup(); fixture.calls.length = 0;
      fixture.api[field] = field === "MINIO_ENDPOINT" ? "http://another-minio:9000/" : "changed-locator";
      fixture.config.services["minio-bootstrap"].environment = { ...fixture.api };
      await assert.rejects(fixture.restore(), /plugin_restore_backend_locator_mismatch/);
      assert.equal(fixture.calls.length, 0);
    });
  }
  await t.test("credential rotation", async t => {
    const fixture = fakeDeployment(t); await fixture.backup();
    fixture.api.MINIO_ROOT_PASSWORD = "rotated-fixture-password";
    fixture.config.services["minio-bootstrap"].environment.MINIO_ROOT_PASSWORD = fixture.api.MINIO_ROOT_PASSWORD;
    await fixture.restore(); assert.equal(fixture.smokeRan, true);
  });
});

test("backup and restore fail on public private-bucket policy or non-exact restored signed reads", async t => {
  const publicPolicy = { Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject" }] };
  await t.test("backup source has anonymous access", async t => {
    const fixture = fakeDeployment(t); fixture.privatePolicy = publicPolicy;
    await assert.rejects(fixture.backup(), /backup_manifest_invalid/);
  });
  await t.test("restore anonymous none was not applied", async t => {
    const fixture = fakeDeployment(t); await fixture.backup(); fixture.calls.length = 0;
    fixture.restorePolicy = publicPolicy;
    await assert.rejects(fixture.restore(), /plugin_bucket_anonymous_policy_not_none/);
    assert.equal(fixture.restoredSql, null); assert.equal(fixture.smokeRan, undefined);
  });
  await t.test("restore signed read is corrupt", async t => {
    const fixture = fakeDeployment(t); await fixture.backup();
    fixture.restoreMutation = objects => objects.set(pluginKey, Buffer.alloc(pluginBytes.length));
    await assert.rejects(fixture.restore(), /plugin_restore_signed_read_mismatch/);
    assert.equal(fixture.restoredSql, null); assert.equal(fixture.smokeRan, undefined);
  });
});

test("resolved namespace alias or bootstrap credential mismatch blocks backup before exporting data", async t => {
  for (const name of ["public alias", "S3 public alias", "credential mismatch"]) {
    await t.test(name, async t => {
      const fixture = fakeDeployment(t);
      if (name === "public alias") fixture.api.ROOM_PLUGIN_BUCKET = fixture.api.MINIO_BUCKET;
      if (name === "S3 public alias") fixture.api.SCENE_BUNDLE_S3_BUCKET = fixture.api.ROOM_PLUGIN_BUCKET;
      if (name === "credential mismatch") fixture.config.services["minio-bootstrap"].environment.MINIO_ROOT_PASSWORD = "wrong-fixture-password";
      await assert.rejects(fixture.backup(), /plugin_storage_/);
      assert.equal(fixture.calls.length, 0);
    });
  }
});

test("private inventory rejects failed listings, duplicate keys, unsafe paths and checksum-valid lost entries", async t => {
  for (const [name, inventory] of [
    ["failed listing", [{ status: "error", error: { message: "list failed" } }]],
    ["duplicate key", [1, 2].map(() => ({ status: "success", type: "file", key: pluginKey, size: pluginBytes.length }))],
    ["unsafe path", [{ status: "success", type: "file", key: "../private-object", size: 1 }]],
    ["missing size", [{ status: "success", type: "file", key: pluginKey }]],
    ["lost inventory entry", []]
  ]) {
    await t.test(name, async t => {
      const fixture = fakeDeployment(t);
      fixture.exportMutation = (root, isPrivate) => {
        if (isPrivate) writeFileSync(join(root, "objects.jsonl"), inventory.map(entry => JSON.stringify(entry)).join("\n"));
      };
      await assert.rejects(fixture.backup(), /backup_manifest_invalid/);
      assert.equal(existsSync(join(fixture.backupDir, "manifest.json")), false);
    });
  }
});

test("plugin metadata in unsupported INSERT or truncated COPY dumps refuses backup", async t => {
  for (const dump of ["INSERT INTO public.room_plugin_packages VALUES ('private');\n", pluginDump({}).replace("\\.\n", "")]) {
    await t.test(dump.startsWith("INSERT") ? "INSERT" : "truncated COPY", async t => {
      const fixture = fakeDeployment(t); fixture.dump = dump;
      await assert.rejects(fixture.backup(), /plugin_metadata_|restore_dump_truncated_sql/);
      assert.equal(existsSync(join(fixture.backupDir, "manifest.json")), false);
    });
  }
});

const emptyPluginCatalog = ["rooms", "room_plugin_bindings", "room_plugin_packages", "room_plugin_state"].map(name => ({ name, kind: "r" }));

async function legacyUpgradeFixture(t) {
  const fixture = fakeDeployment(t, { privateConfigured: false });
  fixture.dump = "DROP TABLE IF EXISTS public.rooms;\nCREATE TABLE public.rooms (room_id text);\n";
  await fixture.backup();
  fixture.api.ROOM_PLUGIN_BUCKET = "private-plugins";
  fixture.targetCatalog = structuredClone(emptyPluginCatalog);
  fixture.calls.length = 0;
  return fixture;
}

test("pre-T04 restore prepares only the three known empty plugin tables and reinstalls current schema in the same transaction", async t => {
  const fixture = await legacyUpgradeFixture(t);
  await fixture.restore();
  const sql = fixture.restoredSql;
  assert.ok(sql.startsWith(`${restorePrefix}LOCK TABLE public.room_plugin_bindings, public.room_plugin_packages, public.room_plugin_state IN ACCESS EXCLUSIVE MODE;`));
  for (const table of ["room_plugin_bindings", "room_plugin_packages", "room_plugin_state"]) {
    assert.ok(sql.includes(`DROP TABLE public.${table};`));
  }
  const recheckIndex = sql.indexOf("legacy_restore_requires_empty_plugin_tables");
  const dropIndex = sql.indexOf("DROP TABLE");
  assert.ok(recheckIndex >= 0 && dropIndex > recheckIndex);
  assert.ok(sql.indexOf(fixture.dump) < sql.indexOf(fixture.schemaQueries[0]));
  assert.ok(sql.indexOf("SET LOCAL search_path TO public, pg_catalog;") < sql.indexOf(fixture.schemaQueries[0]));
  assert.equal(sql.includes("CASCADE"), false);
  assert.equal(fixture.calls.filter(args => args[0] === "exec").length, 1);
  assert.equal(fixture.smokeRan, true);
});

test("legacy unsupported target catalog, nonempty tables or unavailable schema refuse before DDL and policies", async t => {
  for (const [name, mutate, error] of [
    ["live packages/bindings or unknown writer", fixture => { fixture.targetPluginEmpty = false; }, /requires_empty_plugin_tables/],
    ["partial target plugin schema", fixture => { fixture.targetCatalog.pop(); }, /unsupported_target_catalog/],
    ["unknown extra dependent table", fixture => { fixture.targetCatalog.push({ name: "other_dependent_table", kind: "r" }); }, /unsupported_target_catalog/],
    ["plugin view instead of table", fixture => { fixture.targetCatalog[1].kind = "v"; }, /unsupported_target_catalog/],
    ["missing current schema", fixture => { fixture.schemaQueries = []; }, /invalid_current_plugin_schema/],
    ["external database locator", fixture => { fixture.api.POSTGRES_URL = "postgresql://fixture-owner:fixture-password@external:5432/fixture"; }, /matching_bundled_database/]
  ]) {
    await t.test(name, async t => {
      const fixture = await legacyUpgradeFixture(t);
      fixture.privatePolicy = { Statement: [{ Effect: "Allow", Principal: "*" }] };
      fixture.privateObjects.set(pluginKey, pluginBytes);
      const beforePublic = new Map(fixture.publicObjects), beforePrivate = new Map(fixture.privateObjects), policy = structuredClone(fixture.privatePolicy);
      mutate(fixture);
      await assert.rejects(fixture.restore(), error);
      assert.equal(fixture.calls.length, 0);
      assert.deepEqual(fixture.publicObjects, beforePublic); assert.deepEqual(fixture.privateObjects, beforePrivate);
      assert.deepEqual(fixture.privatePolicy, policy);
    });
  }
});

test("legacy SQL failure prevents subsequent public policy/object changes", async t => {
  const fixture = await legacyUpgradeFixture(t); fixture.sqlFailure = true;
  const before = new Map(fixture.publicObjects);
  await assert.rejects(fixture.restore(), /injected_sql_failure/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0][0], "exec");
  assert.deepEqual(fixture.publicObjects, before);
  assert.equal(fixture.smokeRan, undefined);
});

test("dump transaction escapes and psql/program commands are rejected before any state changes", async t => {
  for (const [name, suffix] of [["commit", "COMMIT;\n"], ["begin", "BEGIN;\n"], ["psql shell", "\\! touch /tmp/forbidden\n"],
    ["psql include", "\\i /tmp/forbidden.sql\n"], ["copy program", "COPY public.rooms TO PROGRAM 'forbidden';\n"]]) {
    await t.test(name, async t => {
      const fixture = fakeDeployment(t, { privateConfigured: false });
      await fixture.tamperedArchive("CREATE TABLE public.rooms (room_id text);\n" + suffix);
      await assert.rejects(fixture.restore(), /restore_dump_unsafe_|restore_dump_unsupported_copy/);
      assert.equal(fixture.calls.length, 0);
    });
  }
});

test("SQL function BEGIN/END and COPY data resembling psql commands remain inert dump content", async t => {
  const fixture = fakeDeployment(t, { privateConfigured: false });
  fixture.dump = "CREATE TABLE public.rooms (room_id text);\nCREATE FUNCTION public.fixture() RETURNS void AS $body$ BEGIN RETURN; END; $body$ LANGUAGE plpgsql;\nCOPY public.rooms (room_id) FROM stdin;\n\\! not-a-command\n\\.\n";
  await fixture.backup(); await fixture.restore();
  assert.equal(fixture.restoredSql, `${restorePrefix}${fixture.dump}\n`);
});

test("plain backslash literals cannot hide COMMIT or psql shell commands from restore preflight", async t => {
  for (const [name, payload, error] of [
    ["one plain backslash", String.raw`SET standard_conforming_strings=on; SELECT '\'; COMMIT; --'
SELECT 1/0;`, /restore_dump_unsafe_transaction_or_program/],
    ["two plain backslashes", String.raw`SET standard_conforming_strings=on; SELECT '\\'; COMMIT; --'
SELECT 1/0;`, /restore_dump_unsafe_transaction_or_program/],
    ["psql shell after plain backslash", String.raw`SET standard_conforming_strings=on; SELECT '\';
\! /bin/true
--'
SELECT 1/0;`, /restore_dump_unsafe_psql_command/],
    ["quoted identifier backslash", String.raw`SELECT 1 AS "column\"; COMMIT; --"
SELECT 1/0;`, /restore_dump_unsafe_transaction_or_program/]
  ]) {
    await t.test(name, async t => {
      const fixture = fakeDeployment(t, { privateConfigured: false });
      await fixture.tamperedArchive("CREATE TABLE public.rooms (room_id text);\n" + payload + "\n");
      await assert.rejects(fixture.restore(), error);
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.restoredSql, null);
    });
  }
});

test("unsupported standard string mode switches are rejected before DDL", async t => {
  for (const mode of ["SET standard_conforming_strings=off;", "SET standard_conforming_strings TO 'off';",
    'SET LOCAL "standard_conforming_strings"=DEFAULT;', "RESET standard_conforming_strings;", "RESET ALL;", "DISCARD ALL;",
    "SELECT pg_catalog.set_config('standard_conforming_strings','off',false);",
    "SELECT pg_catalog.set_config(E'standard_conforming_strings','off',false);",
    String.raw`SET U&"standard\005fconforming_strings"=off;`,
    String.raw`SELECT pg_catalog.U&"set\005fconfig"('standard_conforming_strings','off',false);`]) {
    await t.test(mode, async t => {
      const fixture = fakeDeployment(t, { privateConfigured: false });
      await fixture.tamperedArchive(mode + "\n");
      await assert.rejects(fixture.restore(), /restore_dump_unsupported_(?:string|quote)_mode/);
      assert.equal(fixture.calls.length, 0);
    });
  }
});

test("COPY accepts only a fully consumed table/column-list FROM STDIN header", async t => {
  const variants = [
    String.raw`COPY public.t FROM '/dev/null' WHERE "from" = "stdin"; COMMIT;
\.`,
    "COPY public.t FROM '/dev/null';", "COPY public.t TO STDOUT;", "COPY public.t FROM PROGRAM '/bin/true';",
    'COPY public.t FROM "stdin";', "COPY public.t FROM STDIN WHERE true;", "COPY public.t FROM STDIN WITH (FORMAT CSV);",
    "COPY (SELECT 1) TO STDOUT;", "COPY public.t (x,(y)) FROM STDIN;", "COPY public.t (x) FROM STDIN; COMMIT;"
  ];
  for (const [index, sql] of variants.entries()) {
    await t.test(`unsupported COPY ${index + 1}`, async t => {
      const fixture = fakeDeployment(t, { privateConfigured: false }); await fixture.tamperedArchive(sql + "\n");
      await assert.rejects(fixture.restore(), /restore_dump_unsupported_copy/); assert.equal(fixture.calls.length, 0);
    });
  }
  const root = createTempBackupDir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "copy.sql");
  writeFileSync(file, 'CREATE TABLE public."таблица" ("from" text, "stdin" text);\nCOPY public."таблица" ("from", "stdin") FROM STDIN;\nCOMMIT;\t\\! inert\n\\.\n');
  assert.deepEqual([...await inspectRestoreDump(file)], ["таблица"]);
});

test("UTF8 identifiers and numeric boundaries cannot manufacture an E-string prefix", async t => {
  for (const [name, payload, error] of [
    ["UTF8 identifier", String.raw`SELECT ée'\'; COMMIT; --'
SELECT 1/0;`, /restore_dump_unsafe_transaction_or_program/],
    ["NBSP is identifier content", String.raw`SELECT  e'\'; COMMIT; --'
SELECT 1/0;`, /restore_dump_unsafe_transaction_or_program/],
    ["shell after UTF8 identifier", String.raw`SELECT ée'\'
\! /bin/true
--'
;`, /restore_dump_unsafe_psql_command/],
    ["numeric E boundary", String.raw`SELECT 1e'\'
\! /bin/true
--'
;`, /restore_dump_unsupported_numeric_boundary/]
  ]) {
    await t.test(name, async t => {
      const fixture = fakeDeployment(t, { privateConfigured: false }); await fixture.tamperedArchive(payload + "\n");
      await assert.rejects(fixture.restore(), error); assert.equal(fixture.calls.length, 0);
    });
  }
  const root = createTempBackupDir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "identifiers.sql");
  writeFileSync(file, String.raw`CREATE TABLE public.таблица (ée text);
SELECT ée'\', 1 AS  e, 1.25e+06, E'quote\' slash\\', $тег$COMMIT; \! inert$тег$;
`);
  assert.deepEqual([...await inspectRestoreDump(file)], ["таблица"]);
});

test("client encoding changes and invalid UTF8 are rejected before any restore execution", async t => {
  for (const setting of ["SET client_encoding='SJIS';", 'SET "client_encoding"=SQL_ASCII;', "SET NAMES 'SJIS';",
    "SET LOCAL client_encoding=DEFAULT;", "RESET client_encoding;", 'RESET "client_encoding";',
    "SELECT pg_catalog.set_config('client_encoding','SJIS',false);"]) {
    await t.test(setting, async t => {
      const fixture = fakeDeployment(t, { privateConfigured: false });
      await fixture.tamperedArchive(setting + String.raw` SELECT E'ぃ\'; COMMIT; --'
SELECT 1/0;`);
      await assert.rejects(fixture.restore(), /restore_dump_unsupported_encoding|restore_dump_unsupported_string_mode/);
      assert.equal(fixture.calls.length, 0);
    });
  }
  for (const bad of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xe3, 0x81]), Buffer.from([0xed, 0xa0, 0x80])]) {
    await t.test(`invalid UTF8 ${bad.toString("hex")}`, async t => {
      const fixture = fakeDeployment(t, { privateConfigured: false });
      await fixture.tamperedArchive(Buffer.concat([Buffer.from("COPY public.rooms (room_id) FROM STDIN;\n"), bad, Buffer.from("\n\\.\n")]));
      await assert.rejects(fixture.restore(), /restore_dump_invalid_utf8/); assert.equal(fixture.calls.length, 0);
    });
  }
  const root = createTempBackupDir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "utf8.sql");
  writeFileSync(file, "SET client_encoding='UTF8';\nSET NAMES 'UTF8';\nSELECT 'Привет 👋 ぃ\\';\n");
  assert.deepEqual([...await inspectRestoreDump(file)], []);
  // A code point spanning the stream chunk edge must decode, not become replacement characters.
  writeFileSync(file, "--" + " ".repeat(65533) + "👋\nSELECT 1;\n");
  assert.deepEqual([...await inspectRestoreDump(file)], []);
});

test("SQL token/name retention is bounded while large literal contents stay opaque", async t => {
  const root = createTempBackupDir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "bounded.sql");
  writeFileSync(file, `SELECT '${"x".repeat(100000)}';\n`); assert.deepEqual([...await inspectRestoreDump(file)], []);
  writeFileSync(file, `SELECT E'${"x".repeat(100000)}'\n'quote\\\' tail';\n`);
  await assert.rejects(inspectRestoreDump(file), /restore_dump_unsupported_quote_continuation/);
  writeFileSync(file, `SELECT ${"x,".repeat(16384)}x;\n`);
  await assert.rejects(inspectRestoreDump(file), /restore_dump_statement_too_complex/);
  writeFileSync(file, `SELECT ${"é".repeat(1025)};\n`);
  await assert.rejects(inspectRestoreDump(file), /restore_dump_identifier_too_long/);
});

test("physical NUL is rejected before lexer/DDL in every SQL and COPY context", async t => {
  const variants = {
    payload: "SELECT 1;\x00SELECT '\nCOMMIT;\n--';\nSELECT 1/0;\n",
    comment: "-- physical NUL\x00 tail\nSELECT 1;\n",
    literal: "SELECT 'text\x00tail';\n",
    escapedLiteral: "SELECT E'text\x00tail';\n",
    identifier: 'SELECT 1 AS "name\x00tail";\n',
    dollarBody: "CREATE FUNCTION public.f() RETURNS text AS $$ BEGIN RETURN 'text\x00tail'; END; $$ LANGUAGE plpgsql;\n",
    copyData: "COPY public.rooms (room_id) FROM STDIN;\nrow\x00tail\n\\.\n"
  };
  for (const [name, dump] of Object.entries(variants)) {
    await t.test(name, async t => {
      const fixture = fakeDeployment(t, { privateConfigured: false }); await fixture.tamperedArchive(Buffer.from(dump));
      await assert.rejects(fixture.restore(), /restore_dump_nul_byte/);
      assert.equal(fixture.calls.length, 0); assert.equal(fixture.restoredSql, null);
    });
  }
  const root = createTempBackupDir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "nul.sql");
  for (const offset of [65535, 65536, 65537]) {
    writeFileSync(file, Buffer.concat([Buffer.from("--"), Buffer.alloc(offset - 2, 0x61), Buffer.from([0]), Buffer.from("\nSELECT 1;\n")]));
    await assert.rejects(inspectRestoreDump(file), /restore_dump_nul_byte/);
  }
  writeFileSync(file, String.raw`SELECT '\000', E'\\000';
COPY public.rooms (room_id) FROM STDIN;
\\x00
\.
`);
  assert.deepEqual([...await inspectRestoreDump(file)], []);
});

test("backup refuses an unsupported or invalid UTF8 dump before exporting objects or writing success manifest", async t => {
  for (const dump of ["COPY public.t FROM '/dev/null';\n", Buffer.from([0xff]), Buffer.from("--\x00\n")]) {
    await t.test(Buffer.isBuffer(dump) ? dump.includes(0) ? "physical NUL" : "invalid UTF8" : "file COPY", async t => {
      const fixture = fakeDeployment(t, { privateConfigured: false }); fixture.dump = dump;
      await assert.rejects(fixture.backup(), /restore_dump_unsupported_copy|restore_dump_invalid_utf8|restore_dump_nul_byte/);
      assert.equal(fixture.calls.some(args => args[0] === "run"), false);
      assert.equal(existsSync(join(fixture.backupDir, "manifest.json")), false);
    });
  }
});

test("standalone pg_dump lexer preserves plain/E literals, quoted identifiers, nested comments and COPY terminators", async t => {
  const root = createTempBackupDir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sql = String.raw`SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE TABLE public.rooms (room_id text);
SELECT '\', '\\', 'a''b', E'quote\' and slash\\', 1 AS "quote"" and slash\";
SELECT 1 AS "set_config";
/* outer /* COMMIT; */ ROLLBACK; */
CREATE FUNCTION public.fixture() RETURNS text AS $body$
BEGIN RETURN E'quote\' slash\\'; END;
$body$ LANGUAGE plpgsql;
COPY public.rooms (room_id) FROM stdin;
\\.
\! inert COPY value
\.
SELECT '\';
`;
  const file = join(root, "valid.sql"); writeFileSync(file, sql);
  assert.deepEqual([...await inspectRestoreDump(file)], ["rooms"]);
  writeFileSync(file, String.raw`SELECT E'prefix '
'quote\' COMMIT; -- slash\\';`);
  await assert.rejects(inspectRestoreDump(file), /restore_dump_unsupported_quote_continuation/);
  // Two backslashes plus dot are a row, not the one-backslash COPY terminator.
  writeFileSync(file, String.raw`COPY public.rooms (room_id) FROM stdin;
\\.
`);
  await assert.rejects(inspectRestoreDump(file), /restore_dump_truncated_sql/);
  writeFileSync(file, "COPY public.rooms (room_id) FROM STDIN");
  await assert.rejects(inspectRestoreDump(file), /restore_dump_truncated_sql/);
});

test("a package racing read-only preflight is refused by the actual locked DO recheck", async t => {
  const fixture = await legacyUpgradeFixture(t);
  fixture.afterReadOnlyPreflight = () => { fixture.targetPluginEmpty = false; fixture.racingPackagePresent = true; };
  const policy = structuredClone(fixture.privatePolicy);
  await assert.rejects(fixture.restore(), /legacy_restore_requires_empty_plugin_tables/);
  assert.equal(fixture.racingPackagePresent, true); assert.equal(fixture.restoredSql, null);
  assert.deepEqual(fixture.privatePolicy, policy);
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0][0], "exec");
});

test("mutation removing the locked DO recheck fails before DROP even when the earlier preflight was empty", async t => {
  const fixture = await legacyUpgradeFixture(t);
  const run = fixture.operations.runCompose;
  fixture.operations.runCompose = (compose, args, io) => {
    if (io?.stdinFile) {
      const sql = readFileSync(io.stdinFile, "utf8");
      writeFileSync(io.stdinFile, sql.replace(/DO \$vrata_restore\$[\s\S]*?END \$vrata_restore\$;\n/, ""));
    }
    return run(compose, args, io);
  };
  await assert.rejects(fixture.restore(), /actual empty-table DO recheck/);
  assert.equal(fixture.restoredSql, null); assert.equal(fixture.smokeRan, undefined);
});

test("mutation removing private anonymous-none command fails before any private bytes are loaded", async t => {
  const fixture = fakeDeployment(t); await fixture.backup();
  fixture.privateObjects.clear(); fixture.privateObjects.set("existing-private", Buffer.from("existing"));
  fixture.privatePolicy = { Statement: [{ Effect: "Allow", Principal: "*" }] };
  const beforeObjects = new Map(fixture.privateObjects), beforePolicy = structuredClone(fixture.privatePolicy);
  const run = fixture.operations.runCompose;
  fixture.operations.runCompose = (compose, args, io) => {
    if (args[0] === "run" && args.at(-1).includes("$ROOM_PLUGIN_BUCKET") && args.at(-1).includes("--remove")) {
      args = [...args.slice(0, -1), args.at(-1).replace('mc anonymous set none "vrata/$ROOM_PLUGIN_BUCKET" >/dev/null && ', "")];
    }
    return run(compose, args, io);
  };
  await assert.rejects(fixture.restore(), /private policy none must execute before loading private bytes/);
  assert.deepEqual(fixture.privateObjects, beforeObjects); assert.deepEqual(fixture.privatePolicy, beforePolicy);
  assert.equal(fixture.restoredSql, null); assert.equal(fixture.smokeRan, undefined);
});

const realFixtureFile = process.env.VRATA_TEST_BACKUP_FIXTURE_JSON;
test("real fixture backup/restore preserves plugin metadata and bytes, anonymous 403 and public scene 200", {
  skip: !realFixtureFile, timeout: 120_000
}, async () => {
  // Explicitly provisioned disposable fixture only. Never discover or provision a live deployment.
  let fixture;
  try { fixture = JSON.parse(readFileSync(realFixtureFile, "utf8")); }
  catch { throw new Error("real_fixture_invalid_json"); }
  const root = resolve(fixture.fixtureRoot);
  assert.ok(fixture.fixtureOnly === true && root.startsWith(`/tmp/opencode${sep}`), "requires an explicitly disposable fixture root");
  for (const side of [fixture.source, fixture.target]) {
    assert.ok([side.envFile, side.composeFile].every(path => resolve(path).startsWith(`${root}${sep}`)), "fixture files must stay under fixtureRoot");
    let config;
    try {
      config = JSON.parse(execFileSync("docker", ["compose", "--env-file", side.envFile, "-f", side.composeFile, "config", "--format", "json"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch { throw new Error("real_fixture_compose_config_failed"); }
    assert.ok(config.name.startsWith("vrata-backup-fixture-"), "fixture Compose project needs an isolated name");
    assert.ok(Object.values(config.volumes ?? {}).every(volume => !volume.external && volume.name.startsWith("vrata-backup-fixture-")), "no shared/external fixture volumes");
    assert.ok(Object.values(config.services).every(service => (service.volumes ?? []).every(volume =>
      volume.type !== "bind" || resolve(volume.source).startsWith(`${root}${sep}`))), "bind mounts must stay under fixtureRoot");
    assert.equal(config.services.api.environment.MINIO_ENDPOINT, "http://minio:9000", "fixture storage must be internal to its Compose network");
    assert.equal(config.services["minio-bootstrap"].environment.MINIO_ENDPOINT ?? "http://minio:9000", "http://minio:9000");
  }
  for (const url of [fixture.privateAnonymousUrl, fixture.privateSignedReadUrl, fixture.publicSceneUrl, fixture.target.smokeBaseUrl]) {
    let hostname;
    try { hostname = new URL(url).hostname; } catch { throw new Error("real_fixture_invalid_url"); }
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(hostname), "real fixture URLs must be loopback only");
  }
  const fixtureFetch = async url => {
    try { return await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }); }
    catch { throw new Error("real_fixture_read_failed"); }
  };
  const backupDir = join(root, `backup-${Date.now()}`);
  try {
    await main(["backup", "--env-file", fixture.source.envFile, "--compose-file", fixture.source.composeFile, "--backup-dir", backupDir]);
    const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.ok(manifest.roomPlugins.metadataCount > 0);
    assert.ok(manifest.artifacts.some(artifact => artifact.kind === "room-plugin-object" && artifact.sha256 === fixture.privateSha256));
    await main(["restore", "--env-file", fixture.target.envFile, "--compose-file", fixture.target.composeFile, "--backup-dir", backupDir,
      "--smoke-base-url", fixture.target.smokeBaseUrl, "--confirm-restore"]);
    const anonymous = await fixtureFetch(fixture.privateAnonymousUrl);
    assert.equal(anonymous.status, 403); await anonymous.body?.cancel();
    const signed = await fixtureFetch(fixture.privateSignedReadUrl);
    assert.equal(signed.status, 200);
    assert.ok(hash(Buffer.from(await signed.arrayBuffer())) === fixture.privateSha256, "restored signed private bytes must match");
    const publicScene = await fixtureFetch(fixture.publicSceneUrl);
    assert.equal(publicScene.status, 200);
    assert.ok(hash(Buffer.from(await publicScene.arrayBuffer())) === fixture.publicSceneSha256, "restored public scene bytes must match");
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }
});
