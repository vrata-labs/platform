import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PUBLIC_DEMO_LOCAL_ENV_PATH = "infra/docker/.env.demo-local.local";

export const PUBLIC_DEMO_LOCAL_IMAGES = Object.freeze({
  postgres: "postgres:16@sha256:a3b7f434b2dc57ce85a67e171163eb8ab1a1ebcb39d27484661f26b1dfbe30d6",
  livekit: "livekit/livekit-server:v1.13.7@sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3",
  minio: "vrata-demo-minio:5cb1e6309f2bd70e7d0ca77f33782beac1745790deb4c1f94444f1e7dec5fcb6",
  minioBootstrap: "vrata-demo-mc:a92b5f1af200ca25d54d78432ef6b0c47fd4340abf9759ce5d10275cd57e3318",
  caddy: "caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b"
});

const PINNED_LOCAL_BUILDS = Object.freeze({
  minio: {
    dockerfile: "infra/docker/minio.demo-local.Dockerfile",
    checksum: "5cb1e6309f2bd70e7d0ca77f33782beac1745790deb4c1f94444f1e7dec5fcb6",
    releaseAsset: "minio.linux-amd64.RELEASE.2025-02-28T09-55-16Z"
  },
  "minio-bootstrap": {
    dockerfile: "infra/docker/mc.demo-local.Dockerfile",
    checksum: "a92b5f1af200ca25d54d78432ef6b0c47fd4340abf9759ce5d10275cd57e3318",
    releaseAsset: "mc.linux-amd64.RELEASE.2025-03-12T17-29-24Z"
  }
});

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const PROJECT_PATTERN = /^vrata-demo-[0-9a-f]{8}-[0-9a-f]{12}$/;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9_./:@-]*$/;
const FORBIDDEN_CREDENTIALS = new Set([
  "change_me",
  "dev-internal-service-token",
  "dev-remote-browser-internal-token",
  "dev-remote-browser-secret",
  "dev-state-secret",
  "devkey",
  "devsecret",
  "password",
  "secret"
]);
const SECRET_NAMES = [
  "CONTROL_PLANE_ADMIN_TOKEN",
  "LIVEKIT_API_SECRET",
  "STATE_TOKEN_SECRET",
  "REMOTE_BROWSER_TOKEN_SECRET",
  "REMOTE_BROWSER_INTERNAL_TOKEN",
  "VRATA_INTERNAL_SERVICE_TOKEN",
  "POSTGRES_PASSWORD",
  "MINIO_ROOT_PASSWORD"
];

function fail(code) {
  throw new Error(code);
}

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`public_demo_local_env_missing:${name}`);
  }
  return value;
}

function randomHex(randomBytesFn, size) {
  const value = randomBytesFn(size);
  if (!Buffer.isBuffer(value) || value.length !== size) {
    fail("public_demo_local_random_source_invalid");
  }
  return value.toString("hex");
}

export function generatePublicDemoLocalEnv({ sourceSha, randomBytesFn = randomBytes } = {}) {
  if (!SOURCE_SHA_PATTERN.test(sourceSha ?? "")) {
    fail("public_demo_local_source_sha_invalid");
  }

  const projectSuffix = randomHex(randomBytesFn, 6);
  const postgresPassword = `postgres_${randomHex(randomBytesFn, 32)}`;

  const env = {
    COMPOSE_PROJECT_NAME: `vrata-demo-${sourceSha.slice(0, 8)}-${projectSuffix}`,
    API_IMAGE_REPO: "vrata-demo-api",
    ROOM_STATE_IMAGE_REPO: "vrata-demo-room-state",
    REMOTE_BROWSER_IMAGE_REPO: "vrata-demo-remote-browser",
    IMAGE_TAG: sourceSha,
    VRATA_DEPLOY_SHA: sourceSha,

    VRATA_APP_BASE_URL: "http://127.0.0.1:4000",
    ROOM_STATE_PUBLIC_URL: "ws://127.0.0.1:2567",
    LIVEKIT_URL: "ws://127.0.0.1:7880",
    REMOTE_BROWSER_PUBLIC_URL: "http://127.0.0.1:4000",
    REMOTE_BROWSER_ENABLED: "false",
    VRATA_LIVEKIT_DOMAIN: "127.0.0.1",
    LIVEKIT_NODE_IP: "127.0.0.1",

    VRATA_HTTP_PORT: "4000",
    VRATA_API_DIRECT_PORT: "4001",
    VRATA_ROOM_STATE_PORT: "2567",
    VRATA_LIVEKIT_PORT: "7880",
    VRATA_LIVEKIT_TCP_PORT: "7881",
    VRATA_LIVEKIT_UDP_PORT: "7881",
    MINIO_API_PORT: "9000",
    MINIO_CONSOLE_PORT: "9001",

    API_PORT: "4000",
    API_CORS_ORIGIN: "http://127.0.0.1:4000",
    ROOM_TEMPLATE_ASSET_BASE_URL: "",
    CONTROL_PLANE_ADMIN_TOKEN: `admin_${randomHex(randomBytesFn, 32)}`,
    LIVEKIT_API_KEY: `lk_${randomHex(randomBytesFn, 16)}`,
    LIVEKIT_API_SECRET: `livekit_${randomHex(randomBytesFn, 32)}`,
    LIVEKIT_ROOM_PREFIX: `demo-${projectSuffix}-`,
    LIVEKIT_TURN_ENABLED: "false",
    STATE_TOKEN_TTL_SECONDS: "900",
    STATE_TOKEN_SECRET: `state_${randomHex(randomBytesFn, 32)}`,
    REMOTE_BROWSER_TOKEN_SECRET: `browser_${randomHex(randomBytesFn, 32)}`,
    REMOTE_BROWSER_INTERNAL_TOKEN: `browser_internal_${randomHex(randomBytesFn, 32)}`,
    REMOTE_BROWSER_TOKEN_TTL_SECONDS: "300",
    VRATA_INTERNAL_SERVICE_TOKEN: `internal_${randomHex(randomBytesFn, 32)}`,
    VRATA_DEV_ROLE_QUERY: "false",
    MEDIA_TOKEN_TTL_SECONDS: "900",
    REMOTE_BROWSER_ALLOWED_ORIGINS: "http://127.0.0.1:4000",
    REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS: "false",
    REMOTE_BROWSER_FRAME_INTERVAL_MS: "250",
    REMOTE_BROWSER_MAX_SESSIONS: "2",
    REMOTE_BROWSER_SESSION_TTL_SECONDS: "900",
    REMOTE_BROWSER_CPU_LIMIT: "2.0",
    REMOTE_BROWSER_MEMORY_LIMIT: "2g",
    REMOTE_BROWSER_PIDS_LIMIT: "512",

    POSTGRES_DB: "vrata",
    POSTGRES_USER: "vrata",
    POSTGRES_PASSWORD: postgresPassword,
    POSTGRES_URL: `postgres://vrata:${postgresPassword}@postgres:5432/vrata`,

    MINIO_ROOT_USER: `vrata${randomHex(randomBytesFn, 8)}`,
    MINIO_ROOT_PASSWORD: `minio_${randomHex(randomBytesFn, 32)}`,
    MINIO_BUCKET: "vrata-scene-bundles",
    MINIO_PUBLIC_BASE_URL: "http://127.0.0.1:9000",
    MINIO_SCENE_PREFIX: "scenes/",
    SCENE_BUNDLE_PROVIDER: "minio-default",
    FEATURE_SCENE_BUNDLE_UPLOAD: "true",
    FEATURE_DOCUMENTS: "true",
    PDF_PRESENTATION_MAX_PAGES: "250",
    SCENE_BUNDLE_S3_ENDPOINT: "",
    SCENE_BUNDLE_S3_REGION: "",
    SCENE_BUNDLE_S3_BUCKET: "",
    SCENE_BUNDLE_S3_PUBLIC_BASE_URL: "",
    SCENE_BUNDLE_S3_ACCESS_KEY_ID: "",
    SCENE_BUNDLE_S3_SECRET_ACCESS_KEY: "",
    FEATURE_AVATAR_POSE_BINARY: "true",

    CADDY_CONFIG_FILE: "./Caddyfile.selfhost"
  };

  assertPublicDemoLocalEnv(env);
  return env;
}

export function serializePublicDemoLocalEnv(env) {
  assertPublicDemoLocalEnv(env);
  return `${Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}

export function parsePublicDemoLocalEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      fail("public_demo_local_env_line_invalid");
    }
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      fail("public_demo_local_env_name_invalid");
    }
    if (Object.hasOwn(env, name)) {
      fail(`public_demo_local_env_duplicate:${name}`);
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[name] = value;
  }
  return env;
}

export function assertPublicDemoLocalEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    fail("public_demo_local_env_invalid");
  }

  const sourceSha = requireValue(env, "IMAGE_TAG");
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    fail("public_demo_local_image_tag_invalid");
  }
  if (requireValue(env, "VRATA_DEPLOY_SHA") !== sourceSha) {
    fail("public_demo_local_deploy_sha_mismatch");
  }
  if (!PROJECT_PATTERN.test(requireValue(env, "COMPOSE_PROJECT_NAME"))) {
    fail("public_demo_local_project_invalid");
  }

  const exactValues = {
    VRATA_APP_BASE_URL: "http://127.0.0.1:4000",
    ROOM_STATE_PUBLIC_URL: "ws://127.0.0.1:2567",
    LIVEKIT_URL: "ws://127.0.0.1:7880",
    LIVEKIT_NODE_IP: "127.0.0.1",
    VRATA_LIVEKIT_PORT: "7880",
    VRATA_LIVEKIT_TCP_PORT: "7881",
    VRATA_LIVEKIT_UDP_PORT: "7881",
    REMOTE_BROWSER_ENABLED: "false",
    VRATA_DEV_ROLE_QUERY: "false",
    LIVEKIT_TURN_ENABLED: "false"
  };
  for (const [name, expected] of Object.entries(exactValues)) {
    if (requireValue(env, name) !== expected) {
      fail(`public_demo_local_env_value_invalid:${name}`);
    }
  }
  if (Object.hasOwn(env, "VRATA_ALLOW_INSECURE_PRODUCTION_URLS")) {
    fail("public_demo_local_insecure_override_must_be_api_only");
  }

  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !SAFE_VALUE_PATTERN.test(value)) {
      fail(`public_demo_local_env_unsafe_value:${name}`);
    }
  }

  const credentials = [requireValue(env, "LIVEKIT_API_KEY"), requireValue(env, "MINIO_ROOT_USER")];
  const secrets = SECRET_NAMES.map((name) => {
    const value = requireValue(env, name);
    if (value.length < 32) {
      fail(`public_demo_local_secret_too_short:${name}`);
    }
    return value;
  });
  for (const value of [...credentials, ...secrets]) {
    if (FORBIDDEN_CREDENTIALS.has(value.toLowerCase()) || /change[_-]?me/i.test(value)) {
      fail("public_demo_local_dev_credential_forbidden");
    }
  }
  if (new Set([...credentials, ...secrets]).size !== credentials.length + secrets.length) {
    fail("public_demo_local_credentials_not_unique");
  }

  const expectedPostgresUrl = `postgres://${requireValue(env, "POSTGRES_USER")}:${requireValue(env, "POSTGRES_PASSWORD")}@postgres:5432/${requireValue(env, "POSTGRES_DB")}`;
  if (requireValue(env, "POSTGRES_URL") !== expectedPostgresUrl) {
    fail("public_demo_local_postgres_url_mismatch");
  }
  return true;
}

function serviceEnvironment(service) {
  const environment = service?.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    return {};
  }
  return environment;
}

function assertPinnedImage(services, serviceName, expected) {
  if (services[serviceName]?.image !== expected) {
    fail(`public_demo_local_image_mismatch:${serviceName}`);
  }
}

function normalizePort(port) {
  if (!port || typeof port !== "object") {
    fail("public_demo_local_port_invalid");
  }
  return {
    hostIp: port.host_ip ?? port.hostIp ?? "",
    published: String(port.published ?? ""),
    target: Number(port.target),
    protocol: port.protocol ?? "tcp"
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertPublicDemoLocalComposeModel(model, env) {
  assertPublicDemoLocalEnv(env);
  const services = model?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    fail("public_demo_local_compose_services_invalid");
  }

  assertPinnedImage(services, "postgres", PUBLIC_DEMO_LOCAL_IMAGES.postgres);
  assertPinnedImage(services, "livekit", PUBLIC_DEMO_LOCAL_IMAGES.livekit);
  assertPinnedImage(services, "minio", PUBLIC_DEMO_LOCAL_IMAGES.minio);
  assertPinnedImage(services, "minio-bootstrap", PUBLIC_DEMO_LOCAL_IMAGES.minioBootstrap);
  assertPinnedImage(services, "caddy", PUBLIC_DEMO_LOCAL_IMAGES.caddy);
  for (const [serviceName, pinned] of Object.entries(PINNED_LOCAL_BUILDS)) {
    const service = services[serviceName];
    if (service.pull_policy !== "build" || service.build?.dockerfile !== pinned.dockerfile) {
      fail(`public_demo_local_pinned_build_invalid:${serviceName}`);
    }
  }

  for (const [name, service] of Object.entries(services)) {
    if (typeof service.image === "string" && /(^|:)latest(?:@|$)/i.test(service.image)) {
      fail(`public_demo_local_floating_image:${name}`);
    }
    for (const [environmentName, value] of Object.entries(serviceEnvironment(service))) {
      if (FORBIDDEN_CREDENTIALS.has(String(value).trim().toLowerCase()) || /change[_-]?me/i.test(String(value))) {
        fail(`public_demo_local_dev_credential:${name}:${environmentName}`);
      }
    }
    for (const port of service.ports ?? []) {
      const normalized = normalizePort(port);
      if (normalized.hostIp !== "127.0.0.1") {
        fail(`public_demo_local_non_loopback_port:${name}`);
      }
    }
  }

  if (Object.hasOwn(services, "remote-browser")) {
    fail("public_demo_local_remote_browser_present");
  }
  if (Object.hasOwn(model.networks ?? {}, "remote-browser-internal")) {
    fail("public_demo_local_remote_browser_network_present");
  }

  const api = services.api;
  const roomState = services["room-state"];
  if (!api || !roomState) {
    fail("public_demo_local_app_services_missing");
  }
  if (Object.hasOwn(api.depends_on ?? {}, "remote-browser")) {
    fail("public_demo_local_remote_browser_dependency_present");
  }
  if ((api.ports ?? []).length !== 0) {
    fail("public_demo_local_api_direct_port_present");
  }
  if ((services.minio.ports ?? []).some((port) => normalizePort(port).target === 9001)) {
    fail("public_demo_local_minio_console_port_present");
  }

  const apiEnv = serviceEnvironment(api);
  const roomStateEnv = serviceEnvironment(roomState);
  if (apiEnv.NODE_ENV !== "production") {
    fail("public_demo_local_api_not_production");
  }
  if (apiEnv.VRATA_ALLOW_INSECURE_PRODUCTION_URLS !== "true") {
    fail("public_demo_local_api_insecure_override_missing");
  }
  for (const [name, service] of Object.entries(services)) {
    if (name !== "api" && Object.hasOwn(serviceEnvironment(service), "VRATA_ALLOW_INSECURE_PRODUCTION_URLS")) {
      fail(`public_demo_local_insecure_override_scope:${name}`);
    }
  }
  if (apiEnv.VRATA_DEV_ROLE_QUERY !== "false" || roomStateEnv.VRATA_DEV_ROLE_QUERY !== "false") {
    fail("public_demo_local_dev_role_query_enabled");
  }
  if (apiEnv.REMOTE_BROWSER_ENABLED !== "false" || roomStateEnv.REMOTE_BROWSER_ENABLED !== "false") {
    fail("public_demo_local_remote_browser_enabled");
  }
  if (apiEnv.VRATA_DEPLOY_SHA !== env.VRATA_DEPLOY_SHA
    || !String(api.image ?? "").endsWith(`:${env.IMAGE_TAG}`)
    || !String(roomState.image ?? "").endsWith(`:${env.IMAGE_TAG}`)) {
    fail("public_demo_local_source_sha_contract_mismatch");
  }
  const postgresEnv = serviceEnvironment(services.postgres);
  const minioEnv = serviceEnvironment(services.minio);
  const minioBootstrapEnv = serviceEnvironment(services["minio-bootstrap"]);
  const matchingValues = [
    [postgresEnv.POSTGRES_DB, env.POSTGRES_DB],
    [postgresEnv.POSTGRES_USER, env.POSTGRES_USER],
    [postgresEnv.POSTGRES_PASSWORD, env.POSTGRES_PASSWORD],
    [apiEnv.POSTGRES_URL, env.POSTGRES_URL],
    [minioEnv.MINIO_ROOT_USER, env.MINIO_ROOT_USER],
    [minioEnv.MINIO_ROOT_PASSWORD, env.MINIO_ROOT_PASSWORD],
    [minioBootstrapEnv.MINIO_ROOT_USER, env.MINIO_ROOT_USER],
    [minioBootstrapEnv.MINIO_ROOT_PASSWORD, env.MINIO_ROOT_PASSWORD],
    [minioBootstrapEnv.MINIO_BUCKET, env.MINIO_BUCKET],
    [apiEnv.MINIO_ROOT_USER, env.MINIO_ROOT_USER],
    [apiEnv.MINIO_ROOT_PASSWORD, env.MINIO_ROOT_PASSWORD],
    [apiEnv.MINIO_BUCKET, env.MINIO_BUCKET],
    [apiEnv.STATE_TOKEN_SECRET, env.STATE_TOKEN_SECRET],
    [roomStateEnv.STATE_TOKEN_SECRET, env.STATE_TOKEN_SECRET],
    [apiEnv.VRATA_INTERNAL_SERVICE_TOKEN, env.VRATA_INTERNAL_SERVICE_TOKEN],
    [roomStateEnv.VRATA_INTERNAL_SERVICE_TOKEN, env.VRATA_INTERNAL_SERVICE_TOKEN]
  ];
  if (matchingValues.some(([actual, expected]) => actual !== expected)) {
    fail("public_demo_local_service_credentials_mismatch");
  }

  const livekitEnv = serviceEnvironment(services.livekit);
  const livekitConfig = livekitEnv.LIVEKIT_CONFIG;
  if (typeof livekitConfig !== "string") {
    fail("public_demo_local_livekit_config_missing");
  }
  const requiredLivekitConfig = [
    /^port:\s*7880$/m,
    /^\s*tcp_port:\s*7881$/m,
    /^\s*udp_port:\s*7881$/m,
    /^\s*node_ip:\s*127\.0\.0\.1$/m,
    /^\s*enabled:\s*false$/m,
    new RegExp(`^\\s*["']?${escapeRegExp(env.LIVEKIT_API_KEY)}["']?:\\s*["']?${escapeRegExp(env.LIVEKIT_API_SECRET)}["']?$`, "m")
  ];
  if (requiredLivekitConfig.some((pattern) => !pattern.test(livekitConfig))) {
    fail("public_demo_local_livekit_config_invalid");
  }
  if (apiEnv.LIVEKIT_API_KEY !== env.LIVEKIT_API_KEY || apiEnv.LIVEKIT_API_SECRET !== env.LIVEKIT_API_SECRET) {
    fail("public_demo_local_livekit_credentials_mismatch");
  }
  const command = Array.isArray(services.livekit.command) ? services.livekit.command : [services.livekit.command];
  if (command.some((part) => String(part).trim() === "--dev")) {
    fail("public_demo_local_livekit_dev_mode");
  }

  const expectedPorts = new Set([
    "caddy:127.0.0.1:4000:80:tcp",
    "livekit:127.0.0.1:7880:7880:tcp",
    "livekit:127.0.0.1:7881:7881:tcp",
    "livekit:127.0.0.1:7881:7881:udp",
    "minio:127.0.0.1:9000:9000:tcp",
    "room-state:127.0.0.1:2567:2567:tcp"
  ]);
  const actualPorts = new Set();
  for (const [name, service] of Object.entries(services)) {
    for (const port of service.ports ?? []) {
      const normalized = normalizePort(port);
      actualPorts.add(`${name}:${normalized.hostIp}:${normalized.published}:${normalized.target}:${normalized.protocol}`);
    }
  }
  if (actualPorts.size !== expectedPorts.size || [...actualPorts].some((port) => !expectedPorts.has(port))) {
    fail("public_demo_local_published_ports_invalid");
  }
  return true;
}

export function parsePublicDemoLocalEnvArgs(argv) {
  const options = { outputPath: DEFAULT_PUBLIC_DEMO_LOCAL_ENV_PATH, sourceSha: null, help: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (argument === "--output" || argument === "--source-sha") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`public_demo_local_argument_missing:${argument}`);
      }
      if (argument === "--output") options.outputPath = value;
      if (argument === "--source-sha") options.sourceSha = value;
      index += 1;
      continue;
    }
    fail(`public_demo_local_argument_unknown:${argument}`);
  }
  return options;
}

export function checkPublicDemoLocalCompose(outputPath = DEFAULT_PUBLIC_DEMO_LOCAL_ENV_PATH, cwd = process.cwd()) {
  const absolute = resolve(cwd, outputPath);
  if ((statSync(absolute).mode & 0o077) !== 0) fail("public_demo_local_env_not_private");
  const env = parsePublicDemoLocalEnv(readFileSync(absolute, "utf8"));
  assertPublicDemoLocalEnv(env);
  for (const [serviceName, pinned] of Object.entries(PINNED_LOCAL_BUILDS)) {
    const dockerfile = readFileSync(resolve(cwd, pinned.dockerfile), "utf8");
    if (!dockerfile.includes(`ADD --checksum=sha256:${pinned.checksum}`)
      || !dockerfile.includes(`/releases/download/RELEASE.`)
      || !dockerfile.includes(`/${pinned.releaseAsset}`)) {
      fail(`public_demo_local_pinned_build_invalid:${serviceName}`);
    }
  }
  const model = JSON.parse(execFileSync("docker", [
    "compose", "--env-file", absolute,
    "-f", "infra/docker/compose.selfhost.yml",
    "-f", "infra/docker/compose.demo-local.yml",
    "config", "--format", "json"
  ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assertPublicDemoLocalComposeModel(model, env);
  return { project: env.COMPOSE_PROJECT_NAME, imageSha: env.IMAGE_TAG };
}

export function resolvePublicDemoLocalSourceSha(cwd = process.cwd()) {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    fail("public_demo_local_source_sha_invalid");
  }
  return sourceSha;
}

export function inspectPublicDemoLocalCheckout(cwd = process.cwd()) {
  const sourceSha = resolvePublicDemoLocalSourceSha(cwd);
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return { sourceSha, clean: status.trim().length === 0 };
}

export function writePublicDemoLocalEnv({
  outputPath,
  sourceSha,
  cwd = process.cwd(),
  randomBytesFn = randomBytes,
  inspectCheckout = inspectPublicDemoLocalCheckout
}) {
  const absoluteOutputPath = resolve(cwd, outputPath ?? DEFAULT_PUBLIC_DEMO_LOCAL_ENV_PATH);
  const checkout = inspectCheckout(cwd);
  if (!checkout.clean) fail("public_demo_local_checkout_dirty");
  if (sourceSha !== undefined && sourceSha !== checkout.sourceSha) fail("public_demo_local_source_sha_mismatch");
  const env = generatePublicDemoLocalEnv({ sourceSha: sourceSha ?? checkout.sourceSha, randomBytesFn });
  const contents = serializePublicDemoLocalEnv(env);
  mkdirSync(dirname(absoluteOutputPath), { recursive: true, mode: 0o700 });

  let descriptor;
  let created = false;
  try {
    descriptor = openSync(absoluteOutputPath, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(absoluteOutputPath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (created) {
      try { unlinkSync(absoluteOutputPath); } catch { /* Preserve the original error. */ }
    }
    throw error;
  }
  return { outputPath: absoluteOutputPath, env };
}

function printUsage() {
  process.stdout.write(`Usage: node tools/public-demo-local-env.mjs [--output ${DEFAULT_PUBLIC_DEMO_LOCAL_ENV_PATH}] [--source-sha <40-char-sha>] [--check]\n`);
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  try {
    const options = parsePublicDemoLocalEnvArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else if (options.check) {
      const result = checkPublicDemoLocalCompose(options.outputPath);
      process.stdout.write(`[public-demo-local-env] compose validated for ${result.imageSha}\n`);
    } else {
      const result = writePublicDemoLocalEnv(options);
      process.stdout.write(`[public-demo-local-env] created ${result.outputPath}\n`);
    }
  } catch (error) {
    const code = error instanceof Error && error.code === "EEXIST"
      ? "public_demo_local_env_exists"
      : error instanceof Error && /^public_demo_local_[a-z_:]+$/.test(error.message)
        ? error.message : "public_demo_local_env_failed";
    process.stderr.write(`[public-demo-local-env] ${code}\n`);
    process.exitCode = 1;
  }
}
