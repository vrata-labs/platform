import { readFileSync } from "node:fs";
import { isIP } from "node:net";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

const PLACEHOLDER_PATTERN = /(^|[_\-\s])(change[_\-\s]?me|replace[_\-\s]?with|placeholder|example|sample|changeme)([_\-\s]|$)/i;
const EXACT_BLOCKED_VALUES = new Set([
  "admin",
  "change_me",
  "changeme",
  "dev",
  "dev-internal-service-token",
  "dev-remote-browser-secret",
  "dev-state-secret",
  "devkey",
  "devsecret",
  "example",
  "password",
  "secret",
  "test",
  "token"
]);

const SECRET_RULES = [
  { name: "CONTROL_PLANE_ADMIN_TOKEN", minLength: 32 },
  { name: "LIVEKIT_API_SECRET", minLength: 32 },
  { name: "STATE_TOKEN_SECRET", minLength: 32 },
  { name: "REMOTE_BROWSER_TOKEN_SECRET", minLength: 32 },
  { name: "VRATA_INTERNAL_SERVICE_TOKEN", minLength: 32 },
  { name: "POSTGRES_PASSWORD", minLength: 16 },
  { name: "MINIO_ROOT_PASSWORD", minLength: 16 }
];

const REQUIRED_ENV_VARS = [
  "VRATA_DEPLOYMENT_MODE",
  "VRATA_APP_DOMAIN",
  "VRATA_STATE_DOMAIN",
  "VRATA_LIVEKIT_DOMAIN",
  "VRATA_STORAGE_DOMAIN",
  "LIVEKIT_NODE_IP",
  "VRATA_APP_BASE_URL",
  "CONTROL_PLANE_PUBLIC_URL",
  "ROOM_STATE_PUBLIC_URL",
  "LIVEKIT_URL",
  "API_CORS_ORIGIN",
  "VRATA_LIVEKIT_TCP_PORT",
  "VRATA_LIVEKIT_UDP_PORT",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "CONTROL_PLANE_ADMIN_TOKEN",
  "STATE_TOKEN_SECRET",
  "VRATA_INTERNAL_SERVICE_TOKEN",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_URL",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "MINIO_BUCKET",
  "LIVEKIT_TURN_ENABLED"
];

const URL_RULES = [
  { name: "VRATA_APP_BASE_URL", protocols: ["https:"] },
  { name: "CONTROL_PLANE_PUBLIC_URL", protocols: ["https:"] },
  { name: "ROOM_STATE_PUBLIC_URL", protocols: ["wss:"] },
  { name: "LIVEKIT_URL", protocols: ["wss:"] }
];

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBool(value) {
  const normalized = trimmed(value).toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return null;
}

function addIssue(issues, code, name, detail = "") {
  issues.push({ code, name, detail });
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function isPlaceholderHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "example.com"
    || normalized.endsWith(".example.com")
    || normalized === "example.org"
    || normalized.endsWith(".example.org")
    || normalized === "example.net"
    || normalized.endsWith(".example.net")
    || normalized === "test"
    || normalized.endsWith(".test")
    || normalized === "invalid"
    || normalized.endsWith(".invalid");
}

function validateDomain(issues, env, name) {
  const value = trimmed(env[name]);
  if (!value) {
    return;
  }
  if (isLoopbackHostname(value) || isPlaceholderHostname(value) || PLACEHOLDER_PATTERN.test(value)) {
    addIssue(issues, "placeholder_domain", name, "replace_with_public_domain");
  }
}

function parsePort(value) {
  const parsed = Number.parseInt(trimmed(value), 10);
  return Number.isInteger(parsed) && String(parsed) === trimmed(value) ? parsed : null;
}

function validatePort(issues, env, name) {
  const value = trimmed(env[name]);
  if (!value) {
    return null;
  }
  const port = parsePort(value);
  if (port === null || port < 1 || port > 65535) {
    addIssue(issues, "invalid_port", name, "expected_1_to_65535");
    return null;
  }
  return port;
}

function isPrivateOrReservedIpv4(value) {
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 2)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateOrReservedIpv6(value) {
  const normalized = value.toLowerCase();
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:");
}

function validatePublicIp(issues, env, name) {
  const value = trimmed(env[name]);
  if (!value) {
    return;
  }
  const version = isIP(value);
  if (!version || isBlockedValue(value) || (version === 4 ? isPrivateOrReservedIpv4(value) : isPrivateOrReservedIpv6(value))) {
    addIssue(issues, "invalid_public_ip", name, "replace_with_public_ip");
  }
}

function validateUrl(issues, env, rule) {
  const value = trimmed(env[rule.name]);
  if (!value) {
    return;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    addIssue(issues, "invalid_public_url", rule.name, "parse_failed");
    return;
  }

  if (rule.protocols.includes(url.protocol)) {
    const insecureOverride = parseBool(env.VRATA_ALLOW_INSECURE_PRODUCTION_URLS) === true;
    if (!insecureOverride && (isLoopbackHostname(url.hostname) || isPlaceholderHostname(url.hostname))) {
      addIssue(issues, "placeholder_public_url_host", rule.name, "replace_with_public_domain");
    }
    return;
  }

  const insecureOverride = parseBool(env.VRATA_ALLOW_INSECURE_PRODUCTION_URLS) === true;
  if (insecureOverride && isLoopbackHostname(url.hostname) && ["http:", "ws:"].includes(url.protocol)) {
    return;
  }

  addIssue(issues, "insecure_public_url", rule.name, `expected_${rule.protocols.join("_or_").replaceAll(":", "")}`);
}

function isBlockedValue(value) {
  const normalized = value.trim().toLowerCase();
  return EXACT_BLOCKED_VALUES.has(normalized) || PLACEHOLDER_PATTERN.test(value);
}

function validateNamedSecret(issues, env, rule) {
  const value = trimmed(env[rule.name]);
  if (!value) {
    return;
  }
  if (value.length < rule.minLength) {
    addIssue(issues, "weak_secret", rule.name, `min_length_${rule.minLength}`);
  }
  if (isBlockedValue(value)) {
    addIssue(issues, "blocked_secret_value", rule.name, "placeholder_or_dev_value");
  }
}

function validateNonSecretValue(issues, env, name) {
  const value = trimmed(env[name]);
  if (value && isBlockedValue(value)) {
    addIssue(issues, "blocked_config_value", name, "placeholder_or_dev_value");
  }
}

function validateDuplicateSecrets(issues, env) {
  const seen = new Map();
  for (const rule of SECRET_RULES) {
    const value = trimmed(env[rule.name]);
    if (!value) {
      continue;
    }
    const previous = seen.get(value);
    if (previous) {
      addIssue(issues, "duplicate_secret", `${previous},${rule.name}`, "same_value");
      continue;
    }
    seen.set(value, rule.name);
  }
}

function storagePublicUrlRule(env) {
  const provider = trimmed(env.SCENE_BUNDLE_PROVIDER) || "minio-default";
  if (provider === "s3-compatible") {
    return { name: "SCENE_BUNDLE_S3_PUBLIC_BASE_URL", protocols: ["https:"] };
  }
  return { name: "MINIO_PUBLIC_BASE_URL", protocols: ["https:"] };
}

function validateStorageConfig(issues, env) {
  const provider = trimmed(env.SCENE_BUNDLE_PROVIDER) || "minio-default";
  if (provider === "minio-default") {
    for (const name of ["MINIO_PUBLIC_BASE_URL", "MINIO_SCENE_PREFIX"]) {
      if (!trimmed(env[name])) {
        addIssue(issues, "missing_required_env", name);
      }
    }
    validateUrl(issues, env, storagePublicUrlRule(env));
    return;
  }

  if (provider === "s3-compatible") {
    for (const name of ["SCENE_BUNDLE_S3_ENDPOINT", "SCENE_BUNDLE_S3_REGION", "SCENE_BUNDLE_S3_BUCKET", "SCENE_BUNDLE_S3_PUBLIC_BASE_URL"]) {
      if (!trimmed(env[name])) {
        addIssue(issues, "missing_required_env", name);
      }
    }
    validateUrl(issues, env, storagePublicUrlRule(env));
    return;
  }

  addIssue(issues, "invalid_storage_provider", "SCENE_BUNDLE_PROVIDER", "expected_minio-default_or_s3-compatible");
}

function validateRemoteBrowserConfig(issues, env) {
  const remoteBrowserEnabled = parseBool(env.REMOTE_BROWSER_ENABLED) === true;
  if (!remoteBrowserEnabled) {
    return;
  }

  if (parseBool(env.VRATA_ALLOW_EXPERIMENTAL_SERVICES) !== true) {
    addIssue(issues, "experimental_service_requires_override", "REMOTE_BROWSER_ENABLED", "set_VRATA_ALLOW_EXPERIMENTAL_SERVICES_true");
  }

  for (const name of ["REMOTE_BROWSER_PUBLIC_URL", "REMOTE_BROWSER_ALLOWED_ORIGINS", "REMOTE_BROWSER_TOKEN_SECRET"]) {
    if (!trimmed(env[name])) {
      addIssue(issues, "missing_required_env", name);
    }
  }

  validateUrl(issues, env, { name: "REMOTE_BROWSER_PUBLIC_URL", protocols: ["wss:"] });
  validateNamedSecret(issues, env, { name: "REMOTE_BROWSER_TOKEN_SECRET", minLength: 32 });
}

function validateLiveKitConfig(issues, env) {
  validatePublicIp(issues, env, "LIVEKIT_NODE_IP");
  validatePort(issues, env, "VRATA_LIVEKIT_TCP_PORT");
  validatePort(issues, env, "VRATA_LIVEKIT_UDP_PORT");

  const livekitDomain = trimmed(env.VRATA_LIVEKIT_DOMAIN).toLowerCase();
  const livekitUrl = trimmed(env.LIVEKIT_URL);
  if (livekitDomain && livekitUrl) {
    try {
      const url = new URL(livekitUrl);
      const insecureLoopbackOverride = parseBool(env.VRATA_ALLOW_INSECURE_PRODUCTION_URLS) === true && isLoopbackHostname(url.hostname);
      if (!insecureLoopbackOverride && url.hostname.toLowerCase() !== livekitDomain) {
        addIssue(issues, "livekit_url_domain_mismatch", "LIVEKIT_URL", "host_must_match_VRATA_LIVEKIT_DOMAIN");
      }
    } catch {
      // validateUrl reports parse failures.
    }
  }

  const turnEnabled = parseBool(env.LIVEKIT_TURN_ENABLED);
  if (turnEnabled === null) {
    addIssue(issues, "invalid_boolean", "LIVEKIT_TURN_ENABLED", "expected_true_or_false");
    return;
  }
  if (!turnEnabled) {
    return;
  }

  for (const name of ["LIVEKIT_TURN_DOMAIN", "LIVEKIT_TURN_TLS_PORT", "LIVEKIT_TURN_UDP_PORT", "LIVEKIT_TURN_RELAY_RANGE_START", "LIVEKIT_TURN_RELAY_RANGE_END", "LIVEKIT_TURN_EXTERNAL_TLS"]) {
    if (!trimmed(env[name])) {
      addIssue(issues, "missing_required_env", name);
    }
  }

  validateDomain(issues, env, "LIVEKIT_TURN_DOMAIN");
  if (trimmed(env.LIVEKIT_TURN_DOMAIN).toLowerCase() === livekitDomain) {
    addIssue(issues, "turn_domain_reuses_livekit_domain", "LIVEKIT_TURN_DOMAIN", "use_separate_turn_domain");
  }
  validatePort(issues, env, "LIVEKIT_TURN_TLS_PORT");
  validatePort(issues, env, "LIVEKIT_TURN_UDP_PORT");
  const relayStart = validatePort(issues, env, "LIVEKIT_TURN_RELAY_RANGE_START");
  const relayEnd = validatePort(issues, env, "LIVEKIT_TURN_RELAY_RANGE_END");
  if (relayStart !== null && relayEnd !== null && relayStart > relayEnd) {
    addIssue(issues, "invalid_port_range", "LIVEKIT_TURN_RELAY_RANGE_START,LIVEKIT_TURN_RELAY_RANGE_END", "start_must_be_less_or_equal_end");
  }

  const externalTls = parseBool(env.LIVEKIT_TURN_EXTERNAL_TLS);
  if (externalTls === null) {
    addIssue(issues, "invalid_boolean", "LIVEKIT_TURN_EXTERNAL_TLS", "expected_true_or_false");
  }
  if (externalTls === false) {
    for (const name of ["LIVEKIT_TURN_CERT_FILE", "LIVEKIT_TURN_KEY_FILE"]) {
      if (!trimmed(env[name])) {
        addIssue(issues, "missing_required_env", name);
      }
    }
  }
}

export function validateProductionConfig(env = process.env) {
  const issues = [];

  for (const name of REQUIRED_ENV_VARS) {
    if (!trimmed(env[name])) {
      addIssue(issues, "missing_required_env", name);
    }
  }

  if (trimmed(env.VRATA_DEPLOYMENT_MODE) !== "production") {
    addIssue(issues, "invalid_deployment_mode", "VRATA_DEPLOYMENT_MODE", "expected_production");
  }

  for (const rule of URL_RULES) {
    validateUrl(issues, env, rule);
  }
  for (const name of ["VRATA_APP_DOMAIN", "VRATA_STATE_DOMAIN", "VRATA_LIVEKIT_DOMAIN", "VRATA_STORAGE_DOMAIN"]) {
    validateDomain(issues, env, name);
  }
  validateStorageConfig(issues, env);
  validateLiveKitConfig(issues, env);

  for (const rule of SECRET_RULES) {
    validateNamedSecret(issues, env, rule);
  }
  validateDuplicateSecrets(issues, env);

  validateNonSecretValue(issues, env, "LIVEKIT_API_KEY");
  validateNonSecretValue(issues, env, "LIVEKIT_NODE_IP");
  validateNonSecretValue(issues, env, "MINIO_ROOT_USER");

  if (trimmed(env.API_CORS_ORIGIN) === "*") {
    addIssue(issues, "unsafe_cors_origin", "API_CORS_ORIGIN", "wildcard_not_allowed_in_production");
  }

  if (parseBool(env.VRATA_DEV_ROLE_QUERY) === true || parseBool(env.NOAH_DEV_ROLE_QUERY) === true || parseBool(env.FEATURE_DEV_ROLE_QUERY) === true) {
    addIssue(issues, "dev_role_query_enabled", "VRATA_DEV_ROLE_QUERY", "must_be_false_in_production");
  }

  validateRemoteBrowserConfig(issues, env);

  return { ok: issues.length === 0, issues };
}

export function formatProductionConfigIssues(issues) {
  return issues.map((issue) => {
    const suffix = issue.detail ? ` ${issue.detail}` : "";
    return `[preflight] FAIL ${issue.code} ${issue.name}${suffix}`;
  });
}

export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }
    const separator = trimmedLine.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = trimmedLine.slice(0, separator).trim();
    let value = trimmedLine.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function envFromArgs(argv) {
  const envFileIndex = argv.indexOf("--env-file");
  if (envFileIndex === -1) {
    return process.env;
  }
  const envFile = argv[envFileIndex + 1];
  if (!envFile) {
    throw new Error("missing_env_file_path");
  }
  return parseEnvFile(readFileSync(envFile, "utf8"));
}

function isMainModule() {
  return process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
}

if (isMainModule()) {
  const result = validateProductionConfig(envFromArgs(process.argv.slice(2)));
  if (!result.ok) {
    for (const line of formatProductionConfigIssues(result.issues)) {
      process.stderr.write(`${line}\n`);
    }
    process.stderr.write("[preflight] production_config_invalid\n");
    process.exit(1);
  }
  process.stdout.write("[preflight] production_config_ok\n");
}
