import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { parseEnvFile } from "./validate-production-config.mjs";

const BACKUP_SCHEMA_VERSION = 1;
const DEFAULT_ENV_FILE = "infra/docker/.env.selfhost";
const DEFAULT_COMPOSE_FILE = "infra/docker/compose.selfhost.yml";
const DEFAULT_OUTPUT_DIR = "backups";
const DEFAULT_SMOKE_ROOM_ID = "demo-room";
const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|PRIVATE|KEY)$/i;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function usage() {
  return `usage:
  node tools/backup-restore.mjs backup [--env-file path] [--compose-file path] [--output-dir path]
  node tools/backup-restore.mjs validate --backup-dir path
  node tools/backup-restore.mjs restore --backup-dir path --confirm-restore [--env-file path] [--compose-file path] [--smoke-base-url url] [--smoke-room-id id]
  node tools/backup-restore.mjs rollback --previous-image-tag tag --confirm-rollback [--env-file path] [--compose-file path] [--smoke-base-url url] [--smoke-room-id id]
  node tools/backup-restore.mjs smoke --smoke-base-url url [--smoke-room-id id]
  node tools/backup-restore.mjs prune [--output-dir path] [--retention-days days] [--confirm-prune]
`;
}

export function parseBackupRestoreArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  const booleanOptions = new Set(["confirm-restore", "confirm-rollback", "confirm-prune"]);

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }

    const name = arg.slice(2);
    if (booleanOptions.has(name)) {
      options[name] = true;
      continue;
    }

    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing_option_value:${name}`);
    }
    options[name] = value;
    index += 1;
  }

  return { command, options };
}

function timestampForName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sanitizeTagForPath(tag) {
  return String(tag || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(text, env = {}) {
  let redacted = String(text ?? "");
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME_PATTERN.test(name)) {
      continue;
    }
    if (typeof value !== "string" || value.length < 4) {
      continue;
    }
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "g"), "[redacted]");
  }
  return redacted;
}

function envFromFile(envFile) {
  if (!existsSync(envFile)) {
    throw new Error(`missing_env_file:${envFile}`);
  }
  return parseEnvFile(readFileSync(envFile, "utf8"));
}

function resolveComposeOptions(options) {
  const envFile = resolve(options["env-file"] || DEFAULT_ENV_FILE);
  const composeFile = resolve(options["compose-file"] || DEFAULT_COMPOSE_FILE);
  const env = envFromFile(envFile);
  return { envFile, composeFile, env };
}

function runProcess(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const envRedactions = options.envRedactions || {};
  const stdin = options.stdinFile ? openSync(options.stdinFile, "r") : "ignore";
  const stdout = options.stdoutFile ? openSync(options.stdoutFile, "w", 0o600) : "inherit";

  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: [stdin, stdout, "pipe"]
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = redactText(result.stderr || "", envRedactions).trim();
      if (stderr) {
        process.stderr.write(`${stderr}\n`);
      }
      throw new Error(`command_failed:${command}:${result.status}`);
    }
  } finally {
    if (typeof stdin === "number") {
      closeSync(stdin);
    }
    if (typeof stdout === "number") {
      closeSync(stdout);
    }
  }
}

function captureProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = redactText(result.stderr || "", options.envRedactions || {}).trim();
    if (stderr) {
      process.stderr.write(`${stderr}\n`);
    }
    throw new Error(`command_failed:${command}:${result.status}`);
  }
  return result.stdout;
}

function dockerComposeArgs(envFile, composeFile, args) {
  return ["compose", "--env-file", envFile, "-f", composeFile, ...args];
}

function runDockerCompose(compose, args, options = {}) {
  runProcess("docker", dockerComposeArgs(compose.envFile, compose.composeFile, args), {
    ...options,
    envRedactions: compose.env
  });
}

function captureDockerCompose(compose, args) {
  return captureProcess("docker", dockerComposeArgs(compose.envFile, compose.composeFile, args), {
    envRedactions: compose.env
  });
}

function listComposeServices(compose) {
  try {
    return captureDockerCompose(compose, ["config", "--services"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return ["api", "room-state", "remote-browser"];
  }
}

function gitCommit(cwd = process.cwd()) {
  try {
    return captureProcess("git", ["rev-parse", "HEAD"], { cwd }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function platformVersion(cwd = process.cwd()) {
  try {
    const packageJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeArtifactPath(backupDir, filePath) {
  const artifactPath = relative(backupDir, filePath).split(sep).join("/");
  if (!artifactPath || artifactPath.startsWith("../") || artifactPath === ".." || artifactPath.startsWith("/")) {
    throw new Error(`invalid_artifact_path:${artifactPath}`);
  }
  return artifactPath;
}

function isSafeArtifactPath(artifactPath) {
  if (typeof artifactPath !== "string" || !artifactPath) {
    return false;
  }
  if (artifactPath.includes("\\") || artifactPath.startsWith("/") || artifactPath.includes("\0")) {
    return false;
  }
  return artifactPath.split("/").every((part) => part && part !== "." && part !== "..");
}

function listFilesRecursive(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

async function sha256File(filePath) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function artifactFromFile(backupDir, filePath, kind) {
  const stats = statSync(filePath);
  return {
    path: normalizeArtifactPath(backupDir, filePath),
    kind,
    bytes: stats.size,
    sha256: await sha256File(filePath)
  };
}

export async function createBackupManifest({ backupDir, source, smoke, createdAt = new Date().toISOString() }) {
  const artifacts = [];
  const postgresDump = join(backupDir, "postgres.sql");
  const minioInventory = join(backupDir, "minio", "objects.jsonl");
  const minioPolicy = join(backupDir, "minio", "bucket-policy.json");
  const composeImages = join(backupDir, "compose-images.txt");

  if (existsSync(postgresDump)) {
    artifacts.push(await artifactFromFile(backupDir, postgresDump, "postgres-dump"));
  }
  if (existsSync(minioInventory)) {
    artifacts.push(await artifactFromFile(backupDir, minioInventory, "minio-inventory"));
  }
  if (existsSync(minioPolicy)) {
    artifacts.push(await artifactFromFile(backupDir, minioPolicy, "minio-policy"));
  }
  for (const objectFile of listFilesRecursive(join(backupDir, "minio", "objects"))) {
    artifacts.push(await artifactFromFile(backupDir, objectFile, "minio-object"));
  }
  if (existsSync(composeImages)) {
    artifacts.push(await artifactFromFile(backupDir, composeImages, "compose-images"));
  }

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt,
    source: {
      imageTag: source?.imageTag || "unknown",
      platformVersion: source?.platformVersion || "unknown",
      gitCommit: source?.gitCommit || "unknown",
      profile: source?.profile || "compose",
      composeFile: source?.composeFile || "unknown",
      envFile: source?.envFile || "unknown"
    },
    smoke: {
      roomId: smoke?.roomId || DEFAULT_SMOKE_ROOM_ID
    },
    artifacts
  };
}

function addIssue(issues, code, path, detail = "") {
  issues.push({ code, path, detail });
}

export async function validateBackupManifest(manifest, options = {}) {
  const issues = [];
  const backupDir = options.backupDir ? resolve(options.backupDir) : null;
  const checkFiles = options.checkFiles !== false;

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, issues: [{ code: "invalid_manifest", path: "manifest", detail: "expected_object" }] };
  }

  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    addIssue(issues, "invalid_schema_version", "schemaVersion", `expected_${BACKUP_SCHEMA_VERSION}`);
  }
  if (!manifest.createdAt || Number.isNaN(Date.parse(manifest.createdAt))) {
    addIssue(issues, "invalid_created_at", "createdAt", "expected_iso_timestamp");
  }
  if (!manifest.source || typeof manifest.source !== "object") {
    addIssue(issues, "missing_source", "source");
  } else {
    for (const name of ["imageTag", "gitCommit", "profile", "composeFile", "envFile"]) {
      if (typeof manifest.source[name] !== "string" || !manifest.source[name].trim()) {
        addIssue(issues, "missing_source_field", `source.${name}`);
      }
    }
  }
  if (!Array.isArray(manifest.artifacts)) {
    addIssue(issues, "invalid_artifacts", "artifacts", "expected_array");
    return { ok: issues.length === 0, issues };
  }

  const kinds = new Set();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const basePath = `artifacts.${index}`;
    if (!artifact || typeof artifact !== "object") {
      addIssue(issues, "invalid_artifact", basePath, "expected_object");
      continue;
    }
    kinds.add(artifact.kind);
    if (!isSafeArtifactPath(artifact.path)) {
      addIssue(issues, "invalid_artifact_path", `${basePath}.path`);
      continue;
    }
    if (typeof artifact.kind !== "string" || !artifact.kind) {
      addIssue(issues, "invalid_artifact_kind", `${basePath}.kind`);
    }
    if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) {
      addIssue(issues, "invalid_artifact_bytes", `${basePath}.bytes`);
    }
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      addIssue(issues, "invalid_artifact_sha256", `${basePath}.sha256`);
    }
    if (checkFiles && backupDir) {
      const artifactFile = resolve(backupDir, artifact.path);
      if (!artifactFile.startsWith(`${backupDir}${sep}`)) {
        addIssue(issues, "artifact_escapes_backup_dir", `${basePath}.path`);
        continue;
      }
      if (!existsSync(artifactFile)) {
        addIssue(issues, "missing_artifact_file", artifact.path);
        continue;
      }
      const stats = statSync(artifactFile);
      if (stats.size !== artifact.bytes) {
        addIssue(issues, "artifact_size_mismatch", artifact.path);
      }
      const actualHash = await sha256File(artifactFile);
      if (actualHash !== artifact.sha256) {
        addIssue(issues, "artifact_sha256_mismatch", artifact.path);
      }
    }
  }

  for (const requiredKind of ["postgres-dump", "minio-inventory"]) {
    if (!kinds.has(requiredKind)) {
      addIssue(issues, "missing_required_artifact", requiredKind);
    }
  }

  return { ok: issues.length === 0, issues };
}

export function formatBackupManifestIssues(issues) {
  return issues.map((issue) => {
    const detail = issue.detail ? ` ${issue.detail}` : "";
    return `[backup] FAIL ${issue.code} ${issue.path}${detail}`;
  });
}

function writeManifest(backupDir, manifest) {
  const manifestPath = join(backupDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifestPath;
}

async function loadManifestFromBackupDir(backupDir) {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`missing_manifest:${manifestPath}`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function findArtifactPath(manifest, kind) {
  const artifact = manifest.artifacts.find((candidate) => candidate.kind === kind);
  if (!artifact) {
    throw new Error(`missing_required_artifact:${kind}`);
  }
  return artifact.path;
}

function profileFromComposeFile(composeFile) {
  const name = basename(composeFile);
  if (name.includes("production")) {
    return "production";
  }
  if (name.includes("staging")) {
    return "staging";
  }
  if (name.includes("selfhost")) {
    return "selfhost";
  }
  return "compose";
}

async function runBackup(options) {
  const compose = resolveComposeOptions(options);
  const imageTag = options["image-tag"] || compose.env.IMAGE_TAG || "unknown";
  const backupDir = options["backup-dir"]
    ? resolve(options["backup-dir"])
    : resolve(options["output-dir"] || DEFAULT_OUTPUT_DIR, `vrata-${timestampForName()}-${sanitizeTagForPath(imageTag)}`);
  const outputRoot = dirname(backupDir);

  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  if (existsSync(backupDir)) {
    throw new Error(`backup_dir_exists:${backupDir}`);
  }
  mkdirSync(join(backupDir, "minio", "objects"), { recursive: true, mode: 0o700 });

  process.stdout.write(`[backup] start backupDir=${backupDir}\n`);
  runDockerCompose(compose, [
    "exec",
    "-T",
    "postgres",
    "sh",
    "-lc",
    "pg_dump --clean --if-exists --no-owner --no-privileges -U \"$POSTGRES_USER\" \"$POSTGRES_DB\""
  ], { stdoutFile: join(backupDir, "postgres.sql") });

  runDockerCompose(compose, [
    "run",
    "--rm",
    "--no-deps",
    "-v",
    `${join(backupDir, "minio")}:/backup`,
    "--entrypoint",
    "/bin/sh",
    "minio-bootstrap",
    "-lc",
    "mc alias set vrata http://minio:9000 \"$MINIO_ROOT_USER\" \"$MINIO_ROOT_PASSWORD\" >/dev/null && mc mb --ignore-existing \"vrata/$MINIO_BUCKET\" >/dev/null && mc mirror --overwrite \"vrata/$MINIO_BUCKET\" /backup/objects && mc ls --json --recursive \"vrata/$MINIO_BUCKET\" > /backup/objects.jsonl && (mc anonymous get-json \"vrata/$MINIO_BUCKET\" > /backup/bucket-policy.json || printf '{}\\n' > /backup/bucket-policy.json)"
  ]);

  runDockerCompose(compose, ["images"], { stdoutFile: join(backupDir, "compose-images.txt") });

  const manifest = await createBackupManifest({
    backupDir,
    source: {
      imageTag,
      platformVersion: platformVersion(),
      gitCommit: gitCommit(),
      profile: profileFromComposeFile(compose.composeFile),
      composeFile: basename(compose.composeFile),
      envFile: basename(compose.envFile)
    },
    smoke: {
      roomId: options["smoke-room-id"] || DEFAULT_SMOKE_ROOM_ID
    }
  });
  const manifestPath = writeManifest(backupDir, manifest);
  process.stdout.write(`[backup] ok backupDir=${backupDir} manifest=${manifestPath}\n`);
}

async function validateBackupDir(backupDir) {
  const manifest = await loadManifestFromBackupDir(backupDir);
  const result = await validateBackupManifest(manifest, { backupDir });
  return { manifest, result };
}

async function runValidate(options) {
  const backupDir = resolve(options["backup-dir"] || "");
  if (!options["backup-dir"]) {
    throw new Error("missing_backup_dir");
  }
  const { result } = await validateBackupDir(backupDir);
  if (!result.ok) {
    for (const line of formatBackupManifestIssues(result.issues)) {
      process.stderr.write(`${line}\n`);
    }
    throw new Error("backup_manifest_invalid");
  }
  process.stdout.write(`[backup] manifest_ok backupDir=${backupDir}\n`);
}

async function runRestore(options) {
  if (options["confirm-restore"] !== true) {
    throw new Error("restore_requires_--confirm-restore");
  }
  if (!options["backup-dir"]) {
    throw new Error("missing_backup_dir");
  }

  const backupDir = resolve(options["backup-dir"]);
  const compose = resolveComposeOptions(options);
  const { manifest, result } = await validateBackupDir(backupDir);
  if (!result.ok) {
    for (const line of formatBackupManifestIssues(result.issues)) {
      process.stderr.write(`${line}\n`);
    }
    throw new Error("backup_manifest_invalid");
  }

  const smokeBaseUrl = options["smoke-base-url"] || compose.env.VRATA_APP_BASE_URL;
  if (!smokeBaseUrl) {
    throw new Error("restore_requires_smoke_base_url");
  }

  process.stdout.write("[backup] restore_warning=will_apply_postgres_dump_and_replace_minio_bucket_objects\n");
  runDockerCompose(compose, [
    "exec",
    "-T",
    "postgres",
    "sh",
    "-lc",
    "psql -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" \"$POSTGRES_DB\""
  ], { stdinFile: join(backupDir, findArtifactPath(manifest, "postgres-dump")) });

  runDockerCompose(compose, [
    "run",
    "--rm",
    "--no-deps",
    "-v",
    `${join(backupDir, "minio")}:/backup:ro`,
    "--entrypoint",
    "/bin/sh",
    "minio-bootstrap",
    "-lc",
    "mc alias set vrata http://minio:9000 \"$MINIO_ROOT_USER\" \"$MINIO_ROOT_PASSWORD\" >/dev/null && mc mb --ignore-existing \"vrata/$MINIO_BUCKET\" >/dev/null && mc anonymous set download \"vrata/$MINIO_BUCKET\" >/dev/null && mc mirror --overwrite --remove /backup/objects \"vrata/$MINIO_BUCKET\""
  ]);

  await runSmokeChecks({
    baseUrl: smokeBaseUrl,
    roomId: options["smoke-room-id"] || manifest.smoke?.roomId || DEFAULT_SMOKE_ROOM_ID
  });
  process.stdout.write(`[backup] restore_ok backupDir=${backupDir}\n`);
}

export function isSafeImageTag(tag) {
  return typeof tag === "string" && tag !== "latest" && IMAGE_TAG_PATTERN.test(tag);
}

export function updateImageTagInEnvText(text, imageTag) {
  if (!isSafeImageTag(imageTag)) {
    throw new Error("invalid_image_tag");
  }

  const lines = text.split(/\r?\n/);
  let updated = false;
  const rendered = lines.map((line) => {
    if (line.startsWith("IMAGE_TAG=")) {
      updated = true;
      return `IMAGE_TAG=${imageTag}`;
    }
    return line;
  });
  if (!updated) {
    rendered.push(`IMAGE_TAG=${imageTag}`);
  }
  return rendered.join("\n");
}

async function runRollback(options) {
  if (options["confirm-rollback"] !== true) {
    throw new Error("rollback_requires_--confirm-rollback");
  }
  const imageTag = options["previous-image-tag"];
  if (!isSafeImageTag(imageTag)) {
    throw new Error("invalid_image_tag");
  }

  const compose = resolveComposeOptions(options);
  const rollbackEnvDir = resolve(options["rollback-env-dir"] || join(DEFAULT_OUTPUT_DIR, "rollback-env"));
  mkdirSync(rollbackEnvDir, { recursive: true, mode: 0o700 });
  const envBackupPath = join(rollbackEnvDir, `${basename(compose.envFile)}.${timestampForName()}`);
  copyFileSync(compose.envFile, envBackupPath);
  writeFileSync(compose.envFile, updateImageTagInEnvText(readFileSync(compose.envFile, "utf8"), imageTag), { mode: 0o600 });

  const services = listComposeServices(compose).filter((service) => ["api", "room-state", "remote-browser"].includes(service));
  if (services.length > 0) {
    runDockerCompose(compose, ["pull", ...services]);
  }
  runDockerCompose(compose, ["up", "-d", "--no-build"]);

  const smokeBaseUrl = options["smoke-base-url"] || compose.env.VRATA_APP_BASE_URL;
  if (!smokeBaseUrl) {
    throw new Error("rollback_requires_smoke_base_url");
  }
  await runSmokeChecks({
    baseUrl: smokeBaseUrl,
    roomId: options["smoke-room-id"] || DEFAULT_SMOKE_ROOM_ID
  });
  process.stdout.write(`[backup] rollback_ok imageTag=${imageTag} envBackup=${envBackupPath}\n`);
}

function absoluteUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function fetchOk(url, label, attempts = 10) {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) {
        return response;
      }
      lastError = `http_${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) {
      await sleep(1000);
    }
  }
  throw new Error(`smoke_failed:${label}:${lastError}`);
}

async function fetchJson(url, label) {
  const response = await fetchOk(url, label);
  try {
    return await response.json();
  } catch {
    throw new Error(`smoke_failed:${label}:invalid_json`);
  }
}

export async function runSmokeChecks({ baseUrl, roomId = DEFAULT_SMOKE_ROOM_ID }) {
  if (!baseUrl) {
    throw new Error("missing_smoke_base_url");
  }
  const healthUrl = absoluteUrl(baseUrl, "/health");
  const roomUrl = absoluteUrl(baseUrl, `/rooms/${encodeURIComponent(roomId)}`);
  const manifestUrl = absoluteUrl(baseUrl, `/api/rooms/${encodeURIComponent(roomId)}/manifest`);

  await fetchOk(healthUrl, "health");
  await fetchOk(roomUrl, "room");
  const manifest = await fetchJson(manifestUrl, "room_manifest");
  const sceneBundleUrl = manifest?.sceneBundle?.url || manifest?.sceneBundleUrl || manifest?.manifest?.sceneBundle?.url;
  if (sceneBundleUrl) {
    await fetchOk(new URL(sceneBundleUrl, baseUrl).toString(), "scene_bundle");
  }
  process.stdout.write(`[backup] smoke_ok baseUrl=${baseUrl} roomId=${roomId}\n`);
  return { ok: true, baseUrl, roomId, sceneBundleUrl: sceneBundleUrl || null };
}

function runSmoke(options) {
  return runSmokeChecks({
    baseUrl: options["smoke-base-url"],
    roomId: options["smoke-room-id"] || DEFAULT_SMOKE_ROOM_ID
  });
}

export function findPruneCandidates(outputDir, retentionDays, now = Date.now()) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("invalid_retention_days");
  }
  if (!existsSync(outputDir)) {
    return [];
  }
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  return readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("vrata-"))
    .map((entry) => join(outputDir, entry.name))
    .filter((path) => statSync(path).mtimeMs < cutoffMs)
    .sort();
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid_${name}`);
  }
  return parsed;
}

function runPrune(options) {
  const outputDir = resolve(options["output-dir"] || DEFAULT_OUTPUT_DIR);
  const retentionDays = parsePositiveInteger(options["retention-days"] || process.env.VRATA_BACKUP_RETENTION_DAYS || "14", "retention_days");
  const candidates = findPruneCandidates(outputDir, retentionDays);
  for (const candidate of candidates) {
    process.stdout.write(`[backup] prune_candidate path=${candidate}\n`);
  }
  if (options["confirm-prune"] !== true) {
    process.stdout.write(`[backup] prune_dry_run count=${candidates.length} retentionDays=${retentionDays}\n`);
    return;
  }
  for (const candidate of candidates) {
    rmSync(candidate, { recursive: true, force: false });
  }
  process.stdout.write(`[backup] prune_ok count=${candidates.length} retentionDays=${retentionDays}\n`);
}

async function main(argv) {
  const { command, options } = parseBackupRestoreArgs(argv);
  switch (command) {
    case "backup":
      await runBackup(options);
      return;
    case "validate":
      await runValidate(options);
      return;
    case "restore":
      await runRestore(options);
      return;
    case "rollback":
      await runRollback(options);
      return;
    case "smoke":
      await runSmoke(options);
      return;
    case "prune":
      runPrune(options);
      return;
    default:
      process.stderr.write(usage());
      throw new Error("unknown_command");
  }
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[backup] ERROR ${redactText(error instanceof Error ? error.message : String(error), process.env)}\n`);
    process.exit(1);
  });
}

export function createTempBackupDir() {
  return mkdtempSync(join(tmpdir(), "vrata-backup-"));
}
