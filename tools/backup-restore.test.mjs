import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createBackupManifest,
  createTempBackupDir,
  findPruneCandidates,
  parseBackupRestoreArgs,
  formatBackupManifestIssues,
  isSafeImageTag,
  redactText,
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
  const redacted = redactText("failed with password postgres_password_123", {
    POSTGRES_PASSWORD: "postgres_password_123"
  });
  assert.equal(redacted.includes("postgres_password_123"), false);
  assert.equal(redacted.includes("[redacted]"), true);
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
