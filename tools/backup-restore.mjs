import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { parseEnvFile } from "./validate-production-config.mjs";
import { assertIdentityRollbackTarget } from "./identity-rollback-guard.mjs";

const BACKUP_SCHEMA_VERSION = 2;
const PLUGIN_ROOT = "room-plugins";
const PLUGIN_OBJECT_KIND = "room-plugin-object";
const PLUGIN_TABLES = ["room_plugin_bindings", "room_plugin_packages", "room_plugin_state"];
const DEFAULT_ENV_FILE = "infra/docker/.env.selfhost";
const DEFAULT_COMPOSE_FILE = "infra/docker/compose.selfhost.yml";
const DEFAULT_OUTPUT_DIR = "backups";
const DEFAULT_SMOKE_ROOM_ID = "demo-room";
const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|PRIVATE|KEY|ACCESS_KEY_ID|ROOT_USER)$/i;
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
  if (lstatSync(rootDir).isSymbolicLink()) throw new Error("backup_symlink_not_supported");
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("backup_symlink_not_supported");
    }
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

function validBucket(bucket) {
  return typeof bucket === "string" && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && !bucket.includes("..");
}

function normalizedEndpoint(value) {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("plugin_storage_invalid_endpoint");
  }
  return url.href;
}

function pluginFingerprint({ endpoint, region, bucket }) {
  // Same credential-free locator as the API. This is not a physical backend ID.
  return createHash("sha256").update(JSON.stringify(["s3-v1", normalizedEndpoint(endpoint), region, bucket])).digest("hex");
}

function composeStorageConfig(compose, captureCompose, requirePrivate = true) {
  const config = JSON.parse(captureCompose(compose, ["config", "--format", "json"]));
  compose.model = config;
  const api = config.services?.api?.environment || {};
  const bootstrap = config.services?.["minio-bootstrap"]?.environment || {};
  // Resolved Compose environment includes defaults and only variables actually forwarded to the API.
  const provider = api.DOCUMENT_PROVIDER ?? api.SCENE_BUNDLE_PROVIDER ?? "minio-default";
  const bucket = api.ROOM_PLUGIN_BUCKET;
  if (!bucket) return null;
  const publicBucket = bootstrap.MINIO_BUCKET;
  if (!validBucket(bucket) || !validBucket(publicBucket) || bucket === publicBucket ||
      [api.MINIO_BUCKET, api.SCENE_BUNDLE_S3_BUCKET].some(value => value?.trim().replace(/^\/+|\/+$/g, "") === bucket)) {
    throw new Error("plugin_storage_requires_separate_private_bucket");
  }
  if (!requirePrivate) return null;
  if (provider !== "minio-default") throw new Error("plugin_storage_provider_not_supported_by_compose_backup");
  if (api.MINIO_BUCKET !== publicBucket || !api.MINIO_ROOT_USER || !api.MINIO_ROOT_PASSWORD ||
      api.MINIO_ROOT_USER !== bootstrap.MINIO_ROOT_USER || api.MINIO_ROOT_PASSWORD !== bootstrap.MINIO_ROOT_PASSWORD) {
    throw new Error("plugin_storage_compose_credentials_or_public_bucket_mismatch");
  }
  // Redact effective credentials too (they may come from shell overrides rather than --env-file).
  compose.env = { ...compose.env, ...bootstrap, ...api };
  const storage = { provider, endpoint: normalizedEndpoint(api.MINIO_ENDPOINT ?? "http://minio:9000"),
    region: api.SCENE_BUNDLE_S3_REGION || "us-east-1", bucket, publicBucket, anonymousPolicy: "none" };
  return { ...storage, backendFingerprint: pluginFingerprint(storage) };
}

function decodeCopyValue(value) {
  if (value === "\\N") return null;
  return value.replace(/\\([0-7]{1,3}|x[0-9a-f]{1,2}|.)/gi, (_, escaped) => {
    if (/^[0-7]/.test(escaped)) return String.fromCharCode(Number.parseInt(escaped, 8));
    if (/^x[0-9a-f]/i.test(escaped)) return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
    return ({ t: "\t", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v" })[escaped] ?? escaped;
  });
}

async function pluginPackagesFromDump(filePath) {
  const packages = [];
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let copyColumns = null;
  let inOtherCopy = false;
  for await (const line of lines) {
    if (line === "\\.") { copyColumns = null; inOtherCopy = false; continue; }
    if (copyColumns) {
      const values = line.split("\t").map(decodeCopyValue);
      if (values.length !== copyColumns.length) throw new Error("plugin_metadata_invalid_copy_row");
      const row = Object.fromEntries(copyColumns.map((column, index) => [column, values[index]]));
      if (!isSafeArtifactPath(row.storage_key) || !["reserved", "ready", "cleanup-pending", "deleted"].includes(row.state) ||
          !/^[a-f0-9]{64}$/.test(row.artifact_sha256) || !/^[1-9][0-9]*$/.test(row.byte_length)) {
        throw new Error("plugin_metadata_invalid_package");
      }
      packages.push({ key: row.storage_key, state: row.state, bytes: Number(row.byte_length),
        sha256: row.artifact_sha256, backendFingerprint: row.backend_fingerprint ?? null });
      continue;
    }
    if (inOtherCopy) continue;
    if (/^COPY\s/.test(line)) {
      const match = /^COPY\s+(?:"[^"]+"|[\w]+)\."?room_plugin_packages"?\s+\(([^)]+)\) FROM stdin;$/.exec(line);
      if (match) {
        copyColumns = match[1].split(/,\s*/).map(column => column.replaceAll('"', "").trim());
      } else {
        if (/room_plugin_packages/.test(line)) throw new Error("plugin_metadata_unsupported_dump_format");
        inOtherCopy = true;
      }
    } else if (/^INSERT INTO\s+.*\broom_plugin_packages\b/.test(line)) {
      throw new Error("plugin_metadata_unsupported_dump_format");
    }
  }
  if (copyColumns) throw new Error("plugin_metadata_truncated_copy");
  return packages;
}

function assertPluginMetadataStorage(packages, storage) {
  if (packages.length && !storage) throw new Error("plugin_storage_not_captured");
  for (const pkg of packages) {
    if (pkg.state !== "deleted" && pkg.backendFingerprint !== storage.backendFingerprint) {
      throw new Error("plugin_metadata_backend_not_captured");
    }
  }
}

function readPrivateInventory(filePath) {
  const objects = new Map();
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.status !== "success" || !["file", "folder"].includes(entry.type)) throw new Error("plugin_inventory_invalid_entry");
    if (entry.type === "folder") continue;
    if (!isSafeArtifactPath(entry.key) || !Number.isSafeInteger(entry.size) || entry.size < 0 || objects.has(entry.key)) {
      throw new Error("plugin_inventory_invalid_object");
    }
    objects.set(entry.key, entry.size);
  }
  return objects;
}

function assertPrivatePolicy(filePath) {
  const policy = JSON.parse(readFileSync(filePath, "utf8"));
  // anonymous none on MinIO has no policy/Statement. Fail closed on any custom policy.
  if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
      Object.keys(policy).some(key => !["Version", "Statement"].includes(key)) ||
      (policy.Statement !== undefined && (!Array.isArray(policy.Statement) || policy.Statement.length))) {
    throw new Error("plugin_bucket_anonymous_policy_not_none");
  }
}

async function verifyRestoredPrivateObjects(verifyDir, manifest) {
  assertPrivatePolicy(join(verifyDir, "bucket-policy.json"));
  const inventory = readPrivateInventory(join(verifyDir, "objects.jsonl"));
  const expected = manifest.artifacts.filter(artifact => artifact.kind === PLUGIN_OBJECT_KIND);
  const files = listFilesRecursive(join(verifyDir, "objects"));
  if (inventory.size !== expected.length || files.length !== expected.length) throw new Error("plugin_restore_object_set_mismatch");
  for (const artifact of expected) {
    const key = artifact.path.slice(`${PLUGIN_ROOT}/objects/`.length);
    const file = join(verifyDir, "objects", key);
    if (inventory.get(key) !== artifact.bytes || !existsSync(file) || statSync(file).size !== artifact.bytes ||
        await sha256File(file) !== artifact.sha256) throw new Error("plugin_restore_signed_read_mismatch");
  }
}

function mcEnvironment() {
  return ["--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, "-e", "MC_CONFIG_DIR=/tmp/vrata-backup-mc"];
}

function privateMcEnvironment(storage) {
  return [...mcEnvironment(), "-e", `ROOM_PLUGIN_BUCKET=${storage.bucket}`,
    "-e", `MINIO_ENDPOINT=${storage.endpoint}`];
}

const SQL_IDENTIFIER = /^[A-Za-z_\u0080-\u{10ffff}][A-Za-z_0-9$\u0080-\u{10ffff}]*/u;
const SQL_DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\u{10ffff}][A-Za-z_0-9\u0080-\u{10ffff}]*)?\$/u;
const SQL_NUMBER = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?/;
const MAX_SQL_TOKENS = 16384;
const MAX_SQL_NAME_CHARS = 1024;
const MAX_SQL_LITERAL_PREFIX = 256;
const asciiUpper = value => value.replace(/[a-z]/g, character => character.toUpperCase());
const sqlName = item => item?.kind === "identifier" ? item.raw : item?.kind === "word" ? item.raw.replace(/[A-Z]/g, character => character.toLowerCase()) : null;
const keyword = (item, value) => item?.kind === "word" && item.value === value;

async function* strictUtf8(filePath) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for await (const chunk of createReadStream(filePath)) {
    if (chunk.includes(0x00)) throw new Error("restore_dump_nul_byte");
    let text;
    try { text = decoder.decode(chunk, { stream: true }); } catch { throw new Error("restore_dump_invalid_utf8"); }
    if (text) yield text;
  }
  let tail;
  try { tail = decoder.decode(); } catch { throw new Error("restore_dump_invalid_utf8"); }
  if (tail) yield tail;
}

function readSqlName(tokens, start) {
  const first = sqlName(tokens[start]);
  if (first === null) return null;
  if (tokens[start + 1]?.value === ".") {
    const second = sqlName(tokens[start + 2]);
    return second === null ? null : { schema: first, name: second, end: start + 3 };
  }
  return { schema: null, name: first, end: start + 1 };
}

function isDumpCopy(tokens) {
  // COPY qualified-table [(identifier [, identifier ...])] FROM STDIN, and nothing else.
  const table = readSqlName(tokens, 1);
  if (!table) return false;
  let index = table.end;
  if (tokens[index]?.value === "(") {
    index++;
    if (sqlName(tokens[index++]) === null) return false;
    while (tokens[index]?.value === ",") {
      if (sqlName(tokens[++index]) === null) return false;
      index++;
    }
    if (tokens[index++]?.value !== ")") return false;
  }
  return keyword(tokens[index], "FROM") && keyword(tokens[index + 1], "STDIN") && index + 2 === tokens.length;
}

export async function inspectRestoreDump(filePath) {
  const tables = new Set();
  let copy = false, dollar = null, quote = null, escapeString = false, quotedValue = "", quotedTruncated = false, commentDepth = 0, tokens = [];
  let lineNumber = 0, quotedEndLine = -1;
  const token = (kind, value, raw = value) => {
    if (tokens.length >= MAX_SQL_TOKENS) throw new Error("restore_dump_statement_too_complex");
    tokens.push({ kind, value, raw });
  };
  const quotedText = value => {
    if (quote === '"' && quotedValue.length + value.length > MAX_SQL_NAME_CHARS) throw new Error("restore_dump_identifier_too_long");
    const available = (quote === '"' ? MAX_SQL_NAME_CHARS : MAX_SQL_LITERAL_PREFIX) - quotedValue.length;
    quotedValue += value.slice(0, Math.max(0, available));
    if (value.length > available) quotedTruncated = true;
  };
  const checkStatement = () => {
    const words = tokens.filter(item => ["word", "identifier"].includes(item.kind)).map(item => item.value);
    const root = tokens[0]?.kind === "word" ? tokens[0].value : null;
    if (["BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT", "START", "SAVEPOINT", "RELEASE"].includes(root) ||
        root === "PREPARE" && words[1] === "TRANSACTION") {
      throw new Error("restore_dump_unsafe_transaction_or_program");
    }
    if (root === "SET") {
      const offset = ["LOCAL", "SESSION"].includes(tokens[1]?.value) ? 2 : 1;
      const parameter = tokens[offset]?.value;
      if (["STANDARD_CONFORMING_STRINGS", "CLIENT_ENCODING"].includes(parameter)) {
        const assignment = tokens.slice(offset + 1);
        if (assignment.length !== 2 || !["=", "TO"].includes(assignment[0].value) ||
            !["word", "identifier", "string"].includes(assignment[1].kind) || asciiUpper(assignment[1].value) !== (parameter === "CLIENT_ENCODING" ? "UTF8" : "ON")) {
          throw new Error(parameter === "CLIENT_ENCODING" ? "restore_dump_unsupported_encoding" : "restore_dump_unsupported_string_mode");
        }
      }
      if (parameter === "NAMES" && (tokens.length !== offset + 2 || !["word", "identifier", "string"].includes(tokens[offset + 1]?.kind) || asciiUpper(tokens[offset + 1].value) !== "UTF8")) {
        throw new Error("restore_dump_unsupported_encoding");
      }
    }
    if (root === "RESET" && words[1] === "CLIENT_ENCODING") throw new Error("restore_dump_unsupported_encoding");
    if (root === "RESET" && ["ALL", "STANDARD_CONFORMING_STRINGS"].includes(words[1]) || root === "DISCARD" && words[1] === "ALL") {
      throw new Error("restore_dump_unsupported_string_mode");
    }
    if (tokens.some((item, index) => ["word", "identifier"].includes(item.kind) && item.value === "SET_CONFIG" && tokens[index + 1]?.value === "(")) {
      // The only set_config emitted by our pg_dump profile is this fixed search_path reset.
      const expected = ["SELECT", "PG_CATALOG", ".", "SET_CONFIG", "(", "search_path", ",", "", ",", "FALSE", ")"];
      if (tokens.length !== expected.length || tokens.some((item, index) => item.value !== expected[index]) ||
          tokens[5].kind !== "string" || tokens[7].kind !== "string") {
        throw new Error("restore_dump_unsupported_string_mode");
      }
    }
    if (keyword(tokens[0], "CREATE") && keyword(tokens[1], "TABLE")) {
      const table = readSqlName(tokens, 2);
      if (table?.schema === "public") tables.add(table.name);
    }
    let fromStdin = false;
    if (root === "COPY") {
      if (!isDumpCopy(tokens)) throw new Error("restore_dump_unsupported_copy");
      fromStdin = true;
    }
    tokens = [];
    return fromStdin;
  };
  // pg_dump SQL, including function bodies and COPY rows, never becomes a shell/Node program.
  for await (const line of createInterface({ input: Readable.from(strictUtf8(filePath)), crlfDelay: Infinity })) {
    lineNumber++;
    if (copy) { if (line === "\\.") copy = false; continue; }
    if (!quote && !dollar && !commentDepth) {
      if (/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line)) continue;
    }
    for (let index = 0; index < line.length;) {
      if (dollar) {
        const end = line.indexOf(dollar, index);
        if (end < 0) break;
        index = end + dollar.length; dollar = null; continue;
      }
      if (quote) {
        if (line[index] === "\\" && escapeString) { quotedText(line.slice(index, index + 2)); index += 2; continue; }
        if (line[index] === quote) {
          if (line[index + 1] === quote) { quotedText(quote); index += 2; continue; }
          token(quote === '"' ? "identifier" : quotedTruncated ? escapeString ? "long-escape-string" : "long-string" : escapeString ? "escape-string" : "string", quote === '"' ? asciiUpper(quotedValue) : quotedValue, quotedValue);
          quotedEndLine = lineNumber;
          quote = null;
        } else quotedText(line[index]);
        index++; continue;
      }
      if (line.startsWith("/*", index)) { commentDepth++; index += 2; continue; }
      if (commentDepth) {
        if (line.startsWith("*/", index)) { commentDepth--; index += 2; } else index++;
        continue;
      }
      if (line.startsWith("--", index)) break;
      const character = line[index];
      if (character === "\\") throw new Error("restore_dump_unsafe_psql_command");
      if (character === "'" || character === '"') {
        quote = character;
        // Server and psql disagree on E-mode continuation; pg_dump does not emit this form.
        if (quote === "'" && ["escape-string", "long-escape-string"].includes(tokens.at(-1)?.kind) && quotedEndLine < lineNumber) {
          throw new Error("restore_dump_unsupported_quote_continuation");
        }
        escapeString = false;
        quotedValue = ""; quotedTruncated = false; index++; continue;
      }
      const tag = SQL_DOLLAR_TAG.exec(line.slice(index));
      if (tag) {
        if (tag[0].length > MAX_SQL_NAME_CHARS) throw new Error("restore_dump_identifier_too_long");
        dollar = tag[0]; token("dollar-string", "<body>"); index += dollar.length; continue;
      }
      const number = SQL_NUMBER.exec(line.slice(index));
      if (number) {
        const next = line[index + number[0].length];
        if (next && (SQL_IDENTIFIER.test(next) || next === "$" || next === "'")) throw new Error("restore_dump_unsupported_numeric_boundary");
        token("number", "<number>"); index += number[0].length; continue;
      }
      const word = SQL_IDENTIFIER.exec(line.slice(index));
      if (word) {
        if (word[0].length > MAX_SQL_NAME_CHARS) throw new Error("restore_dump_identifier_too_long");
        // pg_dump emits UTF-8 literals/identifiers, not Unicode-escape spellings of GUC names/calls.
        if (word[0].toUpperCase() === "U" && line[index + 1] === "&" && ["'", '"'].includes(line[index + 2])) {
          throw new Error("restore_dump_unsupported_quote_mode");
        }
        if (word[0].toUpperCase() === "E" && line[index + 1] === "'") {
          quote = "'"; escapeString = true; quotedValue = ""; quotedTruncated = false; index += 2; continue;
        }
        token("word", asciiUpper(word[0]), word[0]); index += word[0].length; continue;
      }
      if (character === ";") {
        copy = checkStatement();
        if (copy) {
          if (!/^[ \t\r\f\v]*$/.test(line.slice(index + 1))) throw new Error("restore_dump_unsupported_copy");
          break;
        }
      } else if (!/[ \t\r\n\f\v]/.test(character)) token("symbol", character);
      index++;
    }
    if (quote) quotedText("\n");
  }
  if (tokens.length) {
    checkStatement();
    throw new Error("restore_dump_truncated_sql");
  }
  if (copy || quote || dollar || commentDepth) throw new Error("restore_dump_truncated_sql");
  return tables;
}

function postgresReadArgs(sql) {
  return ["exec", "-T", "postgres", "sh", "-c",
    'psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', "sh", sql];
}

const RESTORE_CATALOG_SQL = "select coalesce(json_agg(json_build_object('name', c.relname, 'kind', c.relkind) order by c.relname), '[]'::json) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f')";

function assertBundledRestoreDatabase(compose) {
  const api = compose.model.services?.api?.environment || {};
  const postgres = compose.model.services?.postgres?.environment || {};
  let matches = false;
  try {
    const url = new URL(api.POSTGRES_URL);
    matches = ["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === "postgres" && (!url.port || url.port === "5432") &&
      !url.search && !api.PGOPTIONS && decodeURIComponent(url.username) === postgres.POSTGRES_USER &&
      decodeURIComponent(url.pathname.slice(1)) === postgres.POSTGRES_DB &&
      !["PGHOST", "PGHOSTADDR", "PGPORT", "PGOPTIONS", "PGSERVICE", "PGSERVICEFILE"].some(key => postgres[key]);
  } catch { /* Never echo a configured database URL. */ }
  if (!matches) throw new Error("legacy_restore_requires_matching_bundled_database");
}

async function legacyRestorePreparation(compose, manifest, dumpTables, captureCompose) {
  if (manifest.roomPlugins) return { before: "", after: "" };
  let catalog;
  try { catalog = JSON.parse(captureCompose(compose, postgresReadArgs(RESTORE_CATALOG_SQL))); }
  catch { throw new Error("legacy_restore_catalog_preflight_failed"); }
  if (!Array.isArray(catalog) || catalog.some(row => typeof row.name !== "string" || !["r", "p", "v", "m", "f"].includes(row.kind))) {
    throw new Error("legacy_restore_invalid_catalog");
  }
  const targetPlugins = catalog.filter(row => PLUGIN_TABLES.includes(row.name));
  if (!targetPlugins.length) return { before: "", after: "" };
  if (targetPlugins.length !== 3 || targetPlugins.some(row => row.kind !== "r") ||
      catalog.some(row => !dumpTables.has(row.name) && !PLUGIN_TABLES.includes(row.name))) {
    throw new Error("legacy_restore_unsupported_target_catalog");
  }
  const sourcePlugins = PLUGIN_TABLES.filter(name => dumpTables.has(name));
  if (sourcePlugins.length && sourcePlugins.length !== 3) throw new Error("legacy_restore_partial_source_plugin_schema");
  assertBundledRestoreDatabase(compose);
  const emptySql = `select not (${PLUGIN_TABLES.map(name => `exists(select 1 from public.${name})`).join(" or ")})`;
  if (captureCompose(compose, postgresReadArgs(emptySql)).trim() !== "t") throw new Error("legacy_restore_requires_empty_plugin_tables");
  // Execute only this fixed, trusted image module with a recording executor, never dump-supplied code.
  const recordSchema = 'const {installRoomPluginSchema}=await import("./apps/api/dist/plugins/postgres-schema.js"); const statements=[]; await installRoomPluginSchema({query:async text=>{if(typeof text!=="string")throw new Error("unsupported_schema_query");statements.push(text);return {};}}); process.stdout.write(JSON.stringify(statements));';
  let statements;
  try { statements = JSON.parse(captureCompose(compose, ["exec", "-T", "api", "node", "--input-type=module", "-e", recordSchema])); }
  catch { throw new Error("legacy_restore_current_plugin_schema_unavailable"); }
  if (!Array.isArray(statements) || !statements.length || statements.some(sql => typeof sql !== "string" || !sql.trim())) {
    throw new Error("legacy_restore_invalid_current_plugin_schema");
  }
  // Recheck after taking locks: a reservation racing the read-only preflight cannot be dropped.
  const before = `LOCK TABLE ${PLUGIN_TABLES.map(name => `public.${name}`).join(", ")} IN ACCESS EXCLUSIVE MODE;
DO $vrata_restore$ BEGIN IF NOT (${emptySql.replace(/^select /, "")}) THEN
  RAISE EXCEPTION 'legacy_restore_requires_empty_plugin_tables'; END IF; END $vrata_restore$;
${sourcePlugins.length ? "" : PLUGIN_TABLES.map(name => `DROP TABLE public.${name};`).join("\n")}
`;
  // pg_dump leaves search_path empty; the trusted API installer uses the public application schema.
  return { before, after: "SET LOCAL search_path TO public, pg_catalog;\n" + statements.join("\n") + "\n" };
}

async function writeRestoreTransaction(filePath, dumpPath, preparation) {
  const fd = openSync(filePath, "w", 0o600);
  const writeAll = value => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    for (let offset = 0; offset < buffer.length;) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (!written) throw new Error("restore_transaction_write_incomplete");
      offset += written;
    }
  };
  try {
    // The lexer and PostgreSQL must agree even when the target server's default is off.
    writeAll("SET LOCAL client_encoding TO 'UTF8';\nSET LOCAL standard_conforming_strings TO on;\n" + preparation.before);
    for await (const chunk of createReadStream(dumpPath)) writeAll(chunk);
    writeAll(`\n${preparation.after}`);
  } finally { closeSync(fd); }
}

export async function createBackupManifest({ backupDir, source, smoke, roomPlugins, createdAt = new Date().toISOString() }) {
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
  if (roomPlugins) {
    for (const [file, kind] of [["objects.jsonl", "room-plugin-inventory"], ["bucket-policy.json", "room-plugin-policy"]]) {
      const filePath = join(backupDir, PLUGIN_ROOT, file);
      if (existsSync(filePath)) artifacts.push(await artifactFromFile(backupDir, filePath, kind));
    }
    for (const objectFile of listFilesRecursive(join(backupDir, PLUGIN_ROOT, "objects"))) {
      artifacts.push(await artifactFromFile(backupDir, objectFile, PLUGIN_OBJECT_KIND));
    }
  }

  return {
    schemaVersion: roomPlugins ? BACKUP_SCHEMA_VERSION : 1,
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
    ...(roomPlugins ? { roomPlugins } : {}),
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

  if (![1, BACKUP_SCHEMA_VERSION].includes(manifest.schemaVersion)) {
    addIssue(issues, "invalid_schema_version", "schemaVersion", "expected_1_or_2");
  }
  if (!manifest.createdAt || Number.isNaN(Date.parse(manifest.createdAt))) {
    addIssue(issues, "invalid_created_at", "createdAt", "expected_iso_timestamp");
  }
  if (!manifest.source || typeof manifest.source !== "object") {
    addIssue(issues, "missing_source", "source");
  } else {
    for (const name of ["imageTag", "platformVersion", "gitCommit", "profile", "composeFile", "envFile"]) {
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
  const artifactPaths = new Map();
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
    if (artifactPaths.has(artifact.path)) addIssue(issues, "duplicate_artifact_path", artifact.path);
    artifactPaths.set(artifact.path, artifact);
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
      let ancestor = artifactFile;
      let symlink = false;
      while (ancestor !== backupDir) {
        if (lstatSync(ancestor).isSymbolicLink()) { symlink = true; break; }
        ancestor = dirname(ancestor);
      }
      if (symlink || !statSync(artifactFile).isFile()) {
        addIssue(issues, "artifact_not_regular_file", artifact.path);
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

  const storage = manifest.roomPlugins;
  const hasPrivateArtifacts = manifest.artifacts.some(artifact =>
    typeof artifact?.kind === "string" && artifact.kind.startsWith("room-plugin-") ||
    typeof artifact?.path === "string" && artifact.path.startsWith(`${PLUGIN_ROOT}/`));
  if (manifest.schemaVersion === 2 && !storage || (storage || hasPrivateArtifacts) && manifest.schemaVersion !== 2) {
    addIssue(issues, "plugin_storage_requires_schema_2", "roomPlugins");
  }
  if (storage) {
    try {
      if (storage.provider !== "minio-default" || !validBucket(storage.bucket) || !validBucket(storage.publicBucket) ||
          storage.bucket === storage.publicBucket || typeof storage.region !== "string" || !storage.region ||
          storage.endpoint !== normalizedEndpoint(storage.endpoint) || storage.anonymousPolicy !== "none" ||
          storage.backendFingerprint !== pluginFingerprint(storage) || !Number.isSafeInteger(storage.metadataCount) || storage.metadataCount < 0) {
        throw new Error("plugin_storage_invalid_config");
      }
    } catch {
      addIssue(issues, "plugin_storage_invalid_config", "roomPlugins");
    }
    for (const [path, kind] of [[`${PLUGIN_ROOT}/objects.jsonl`, "room-plugin-inventory"], [`${PLUGIN_ROOT}/bucket-policy.json`, "room-plugin-policy"]]) {
      if (artifactPaths.get(path)?.kind !== kind) addIssue(issues, "missing_required_artifact", path);
    }
    for (const artifact of manifest.artifacts) {
      if (artifact?.kind === PLUGIN_OBJECT_KIND && (typeof artifact.path !== "string" || !artifact.path.startsWith(`${PLUGIN_ROOT}/objects/`))) {
        addIssue(issues, "plugin_object_wrong_namespace", artifact.path);
      }
      if (typeof artifact?.path === "string" && artifact.path.startsWith(`${PLUGIN_ROOT}/`) &&
          ![`${PLUGIN_ROOT}/objects.jsonl`, `${PLUGIN_ROOT}/bucket-policy.json`].includes(artifact.path) &&
          (!artifact.path.startsWith(`${PLUGIN_ROOT}/objects/`) || artifact.kind !== PLUGIN_OBJECT_KIND)) {
        addIssue(issues, "plugin_artifact_wrong_kind_or_namespace", artifact.path);
      }
    }
  }

  // Validate the exact SQL snapshot, not a separate live query that could race pg_dump.
  if (checkFiles && backupDir && issues.length === 0) {
    try {
      const packages = await pluginPackagesFromDump(join(backupDir, findArtifactPath(manifest, "postgres-dump")));
      assertPluginMetadataStorage(packages, storage);
      if (storage && storage.metadataCount !== packages.length) throw new Error("plugin_metadata_count_mismatch");
      if (!storage && existsSync(join(backupDir, PLUGIN_ROOT))) throw new Error("plugin_storage_not_captured");
      if (storage) {
        assertPrivatePolicy(join(backupDir, PLUGIN_ROOT, "bucket-policy.json"));
        const objects = readPrivateInventory(join(backupDir, PLUGIN_ROOT, "objects.jsonl"));
        for (const [key, size] of objects) {
          const artifact = artifactPaths.get(`${PLUGIN_ROOT}/objects/${key}`);
          if (artifact?.kind !== PLUGIN_OBJECT_KIND || artifact.bytes !== size) throw new Error("plugin_inventory_missing_or_mismatched_object");
        }
        for (const artifact of manifest.artifacts.filter(artifact => artifact.kind === PLUGIN_OBJECT_KIND)) {
          if (!objects.has(artifact.path.slice(`${PLUGIN_ROOT}/objects/`.length))) throw new Error("plugin_object_missing_from_inventory");
        }
        for (const file of listFilesRecursive(join(backupDir, PLUGIN_ROOT))) {
          if (!artifactPaths.has(normalizeArtifactPath(backupDir, file))) throw new Error("plugin_unmanifested_file");
        }
        for (const pkg of packages) {
          const artifact = artifactPaths.get(`${PLUGIN_ROOT}/objects/${pkg.key}`);
          // Pending uploads/deletes can legitimately have no object. Ready packages cannot.
          if (!artifact && pkg.state === "ready") throw new Error("plugin_ready_object_missing");
          if (artifact && (artifact.bytes !== pkg.bytes || artifact.sha256 !== pkg.sha256)) throw new Error("plugin_metadata_object_mismatch");
        }
      }
    } catch (error) {
      addIssue(issues, error instanceof SyntaxError ? "plugin_storage_invalid_json" : error.message, "roomPlugins");
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

async function runBackup(options, operations = {}) {
  const runCompose = operations.runCompose || runDockerCompose;
  const captureCompose = operations.captureCompose || captureDockerCompose;
  const compose = resolveComposeOptions(options);
  const storage = composeStorageConfig(compose, captureCompose);
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
  runCompose(compose, [
    "exec",
    "-T",
    "postgres",
    "sh",
    "-lc",
    "PGCLIENTENCODING=UTF8 pg_dump --clean --if-exists --no-owner --no-privileges -U \"$POSTGRES_USER\" \"$POSTGRES_DB\""
  ], { stdoutFile: join(backupDir, "postgres.sql") });
  await inspectRestoreDump(join(backupDir, "postgres.sql"));
  const packages = await pluginPackagesFromDump(join(backupDir, "postgres.sql"));
  assertPluginMetadataStorage(packages, storage);

  runCompose(compose, [
    "run",
    "--rm",
    "--no-deps",
    "-v",
    `${join(backupDir, "minio")}:/backup`,
    ...mcEnvironment(),
    "--entrypoint",
    "/bin/sh",
    "minio-bootstrap",
    "-lc",
    "mc alias set vrata \"${MINIO_ENDPOINT:-http://minio:9000}\" \"$MINIO_ROOT_USER\" \"$MINIO_ROOT_PASSWORD\" >/dev/null && mc stat \"vrata/$MINIO_BUCKET\" >/dev/null && mc mirror --overwrite \"vrata/$MINIO_BUCKET\" /backup/objects >/dev/null && mc ls --json --recursive \"vrata/$MINIO_BUCKET\" > /backup/objects.jsonl && (mc anonymous get-json \"vrata/$MINIO_BUCKET\" > /backup/bucket-policy.json || printf '{}\\n' > /backup/bucket-policy.json)"
  ]);

  if (storage) {
    mkdirSync(join(backupDir, PLUGIN_ROOT, "objects"), { recursive: true, mode: 0o700 });
    runCompose(compose, [
      "run", "--rm", "--no-deps", "-v", `${join(backupDir, PLUGIN_ROOT)}:/backup`,
      ...privateMcEnvironment(storage),
      "--entrypoint", "/bin/sh", "minio-bootstrap", "-lc",
      "mc alias set vrata \"$MINIO_ENDPOINT\" \"$MINIO_ROOT_USER\" \"$MINIO_ROOT_PASSWORD\" >/dev/null && mc stat \"vrata/$ROOM_PLUGIN_BUCKET\" >/dev/null && mc anonymous get-json \"vrata/$ROOM_PLUGIN_BUCKET\" > /backup/bucket-policy.json && mc mirror --overwrite \"vrata/$ROOM_PLUGIN_BUCKET\" /backup/objects >/dev/null && mc ls --json --recursive \"vrata/$ROOM_PLUGIN_BUCKET\" > /backup/objects.jsonl"
    ]);
  }

  runCompose(compose, ["images"], { stdoutFile: join(backupDir, "compose-images.txt") });

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
    },
    roomPlugins: storage ? { ...storage, metadataCount: packages.length } : undefined
  });
  const validation = await validateBackupManifest(manifest, { backupDir });
  if (!validation.ok) {
    for (const line of formatBackupManifestIssues(validation.issues)) process.stderr.write(`${line}\n`);
    throw new Error("backup_manifest_invalid");
  }
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

async function runRestore(options, operations = {}) {
  const runCompose = operations.runCompose || runDockerCompose;
  const captureCompose = operations.captureCompose || captureDockerCompose;
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

  const storage = composeStorageConfig(compose, captureCompose, Boolean(manifest.roomPlugins));
  if (manifest.roomPlugins) {
    if (!storage || ["provider", "endpoint", "region", "bucket", "publicBucket", "backendFingerprint"].some(field => storage[field] !== manifest.roomPlugins[field])) {
      throw new Error("plugin_restore_backend_locator_mismatch");
    }
  }

  const dumpPath = join(backupDir, findArtifactPath(manifest, "postgres-dump"));
  const dumpTables = await inspectRestoreDump(dumpPath);
  const preparation = await legacyRestorePreparation(compose, manifest, dumpTables, captureCompose);

  process.stdout.write("[backup] restore_warning=will_apply_postgres_dump_and_replace_minio_bucket_objects\n");
  // Remove anonymous policy before uploading private bytes, even on a previously public target.
  if (manifest.roomPlugins) {
    const verifyDir = createTempBackupDir();
    mkdirSync(join(verifyDir, "objects"), { mode: 0o700 });
    try {
      runCompose(compose, [
        "run", "--rm", "--no-deps", "-v", `${join(backupDir, PLUGIN_ROOT)}:/backup:ro`, "-v", `${verifyDir}:/verify`,
        ...privateMcEnvironment(storage),
        "--entrypoint", "/bin/sh", "minio-bootstrap", "-lc",
        "mc alias set vrata \"$MINIO_ENDPOINT\" \"$MINIO_ROOT_USER\" \"$MINIO_ROOT_PASSWORD\" >/dev/null && mc mb --ignore-existing \"vrata/$ROOM_PLUGIN_BUCKET\" >/dev/null && mc anonymous set none \"vrata/$ROOM_PLUGIN_BUCKET\" >/dev/null && mc mirror --overwrite --remove /backup/objects \"vrata/$ROOM_PLUGIN_BUCKET\" >/dev/null && mc anonymous get-json \"vrata/$ROOM_PLUGIN_BUCKET\" > /verify/bucket-policy.json && mc mirror --overwrite \"vrata/$ROOM_PLUGIN_BUCKET\" /verify/objects >/dev/null && mc ls --json --recursive \"vrata/$ROOM_PLUGIN_BUCKET\" > /verify/objects.jsonl"
      ]);
      await verifyRestoredPrivateObjects(verifyDir, manifest);
    } finally {
      rmSync(verifyDir, { recursive: true, force: true });
    }
  }

  const transactionDir = createTempBackupDir();
  try {
    const transactionFile = join(transactionDir, "restore.sql");
    await writeRestoreTransaction(transactionFile, dumpPath, preparation);
    runCompose(compose, ["exec", "-T", "postgres", "sh", "-lc",
      "PGCLIENTENCODING=UTF8 PGOPTIONS=\"${PGOPTIONS:-} -c client_encoding=UTF8 -c standard_conforming_strings=on\" psql -X --single-transaction -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" \"$POSTGRES_DB\""
    ], { stdinFile: transactionFile });
  } finally { rmSync(transactionDir, { recursive: true, force: true }); }

  runCompose(compose, [
    "run",
    "--rm",
    "--no-deps",
    "-v",
    `${join(backupDir, "minio")}:/backup:ro`,
    ...mcEnvironment(),
    "--entrypoint",
    "/bin/sh",
    "minio-bootstrap",
    "-lc",
    "mc alias set vrata \"${MINIO_ENDPOINT:-http://minio:9000}\" \"$MINIO_ROOT_USER\" \"$MINIO_ROOT_PASSWORD\" >/dev/null && mc mb --ignore-existing \"vrata/$MINIO_BUCKET\" >/dev/null && mc anonymous set download \"vrata/$MINIO_BUCKET\" >/dev/null && mc mirror --overwrite --remove /backup/objects \"vrata/$MINIO_BUCKET\" >/dev/null"
  ]);

  await (operations.smoke || runSmokeChecks)({
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
  const smokeBaseUrl = options["smoke-base-url"] || compose.env.VRATA_APP_BASE_URL;
  if (!smokeBaseUrl) {
    throw new Error("rollback_requires_smoke_base_url");
  }

  assertIdentityRollbackTarget({ envFile: compose.envFile, composeFile: compose.composeFile, imageTag });

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

export async function main(argv, operations = {}) {
  const { command, options } = parseBackupRestoreArgs(argv);
  switch (command) {
    case "backup":
      await runBackup(options, operations);
      return;
    case "validate":
      await runValidate(options);
      return;
    case "restore":
      await runRestore(options, operations);
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
