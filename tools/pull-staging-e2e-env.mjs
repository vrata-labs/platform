#!/usr/bin/env node

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const defaultHost = "158.160.10.234";
const defaultBaseUrl = `https://${defaultHost}.sslip.io`;
const defaultStateBaseUrl = `https://state.${defaultHost}.sslip.io`;
const managedKeys = [
  "BASE_URL",
  "STAGING_ASSET_BASE_URL",
  "STAGING_ADMIN_TOKEN",
  "STAGING_SCENE_BUNDLE_VERSION"
];

function parseArgs(argv) {
  const options = {
    output: ".env.staging.local",
    ssh: process.env.STAGING_SSH_TARGET ?? null,
    host: process.env.STAGING_SSH_HOST ?? defaultHost,
    user: process.env.STAGING_SSH_USER ?? process.env.USER ?? null,
    baseUrl: process.env.BASE_URL ?? defaultBaseUrl,
    appDirs: process.env.STAGING_APP_DIR ? [process.env.STAGING_APP_DIR] : ["/opt/noah", "/opt/vrata"]
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === "--output") options.output = next();
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
    else if (arg === "--ssh") options.ssh = next();
    else if (arg.startsWith("--ssh=")) options.ssh = arg.slice("--ssh=".length);
    else if (arg === "--host") options.host = next();
    else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
    else if (arg === "--user") options.user = next();
    else if (arg.startsWith("--user=")) options.user = arg.slice("--user=".length);
    else if (arg === "--base-url") options.baseUrl = next();
    else if (arg.startsWith("--base-url=")) options.baseUrl = arg.slice("--base-url=".length);
    else if (arg === "--app-dir") options.appDirs = [next()];
    else if (arg.startsWith("--app-dir=")) options.appDirs = [arg.slice("--app-dir=".length)];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.ssh) {
    if (!options.user) throw new Error("Missing SSH user. Pass --ssh <user>@<host> or --user <user>.");
    options.ssh = `${options.user}@${options.host}`;
  }

  return options;
}

function parseDotenv(content) {
  const values = new Map();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values.set(key, normalized.slice(equalsIndex + 1).trim());
  }

  return values;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function readRemoteEnv(options) {
  const remoteScript = String.raw`
set -euo pipefail
env_file=""
app_dir=""
for candidate in "$@"; do
  if [ -f "$candidate/infra/docker/.env.staging" ]; then
    env_file="$candidate/infra/docker/.env.staging"
    app_dir="$candidate"
    break
  fi
done
if [ -z "$env_file" ]; then
  echo "missing_remote_staging_env" >&2
  exit 1
fi
awk -F= '
  /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
  {
    key=$1
    sub(/^export[[:space:]]+/, "", key)
    gsub(/[[:space:]]/, "", key)
    if (key == "CONTROL_PLANE_ADMIN_TOKEN" || key == "STAGING_ADMIN_TOKEN" || key == "VRATA_APP_DOMAIN" || key == "VRATA_STATE_DOMAIN") {
      print key "=" substr($0, index($0, "=") + 1)
    }
  }
' "$env_file"
sha_file="$app_dir/infra/docker/.staging-successful-image-tag"
if [ -f "$sha_file" ]; then
  printf 'STAGING_SCENE_BUNDLE_VERSION='
  tr -d '\n\r' < "$sha_file"
  printf '\n'
fi
`;

  const result = spawnSync("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    options.ssh,
    "sudo", "bash", "-s", "--",
    ...options.appDirs
  ], {
    input: remoteScript,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });

  if (result.status !== 0) {
    const stderr = result.stderr.trim() || `ssh exited with ${result.status ?? "unknown status"}`;
    throw new Error(`Could not read staging env over SSH: ${stderr}`);
  }

  return parseDotenv(result.stdout);
}

function buildLocalEnv(remoteEnv, options) {
  const adminToken = remoteEnv.get("STAGING_ADMIN_TOKEN") ?? remoteEnv.get("CONTROL_PLANE_ADMIN_TOKEN");
  if (!adminToken) {
    throw new Error("Remote staging env does not contain CONTROL_PLANE_ADMIN_TOKEN/STAGING_ADMIN_TOKEN");
  }

  const appDomain = remoteEnv.get("VRATA_APP_DOMAIN");
  const stateDomain = remoteEnv.get("VRATA_STATE_DOMAIN");
  const baseUrl = options.baseUrl ?? (appDomain ? `https://${appDomain}` : defaultBaseUrl);
  const assetBaseUrl = stateDomain ? `https://${stateDomain}` : defaultStateBaseUrl;

  const env = new Map([
    ["BASE_URL", baseUrl],
    ["STAGING_ASSET_BASE_URL", assetBaseUrl],
    ["STAGING_ADMIN_TOKEN", adminToken]
  ]);

  const bundleVersion = remoteEnv.get("STAGING_SCENE_BUNDLE_VERSION");
  if (bundleVersion && /^[0-9a-f]{40}$/.test(bundleVersion)) {
    env.set("STAGING_SCENE_BUNDLE_VERSION", bundleVersion);
  }

  return env;
}

function renderEnvLine(key, value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return `${key}=${value}`;
  }
  return `${key}=${shellQuote(value)}`;
}

function upsertEnvFile(outputPath, values) {
  const absolutePath = resolve(outputPath);
  const existingLines = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8").split(/\r?\n/) : [];
  const written = new Set();
  const resultLines = [];

  for (const rawLine of existingLines) {
    const line = rawLine.trim();
    const equalsIndex = line.indexOf("=");
    const key = equalsIndex > 0 ? line.slice(0, equalsIndex).replace(/^export\s+/, "").trim() : "";
    if (managedKeys.includes(key) && values.has(key)) {
      resultLines.push(renderEnvLine(key, values.get(key)));
      written.add(key);
    } else if (rawLine !== "" || resultLines.length > 0) {
      resultLines.push(rawLine);
    }
  }

  if (resultLines.length === 0) {
    resultLines.push("# Local staging e2e secrets. Do not commit.");
  }

  for (const key of managedKeys) {
    if (values.has(key) && !written.has(key)) {
      resultLines.push(renderEnvLine(key, values.get(key)));
    }
  }

  writeFileSync(absolutePath, `${resultLines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  chmodSync(absolutePath, 0o600);
  return absolutePath;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const remoteEnv = readRemoteEnv(options);
  const localEnv = buildLocalEnv(remoteEnv, options);
  const outputPath = upsertEnvFile(options.output, localEnv);
  console.log(`Wrote ${options.output} from ${options.ssh}`);
  console.log(`Updated keys: ${Array.from(localEnv.keys()).join(", ")}`);
  console.log(`File permissions set to 0600: ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
