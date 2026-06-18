import assert from "node:assert/strict";
import test from "node:test";

import {
  formatProductionConfigIssues,
  parseEnvFile,
  validateProductionConfig
} from "./validate-production-config.mjs";

function validProductionEnv(overrides = {}) {
  return {
    VRATA_DEPLOYMENT_MODE: "production",
    VRATA_APP_DOMAIN: "app.vrata-prod.com",
    VRATA_STATE_DOMAIN: "state.vrata-prod.com",
    VRATA_LIVEKIT_DOMAIN: "livekit.vrata-prod.com",
    VRATA_STORAGE_DOMAIN: "storage.vrata-prod.com",
    LIVEKIT_NODE_IP: "203.0.113.10",
    VRATA_APP_BASE_URL: "https://app.vrata-prod.com",
    CONTROL_PLANE_PUBLIC_URL: "https://app.vrata-prod.com/control-plane",
    ROOM_STATE_PUBLIC_URL: "wss://state.vrata-prod.com",
    LIVEKIT_URL: "wss://livekit.vrata-prod.com",
    API_CORS_ORIGIN: "https://app.vrata-prod.com",
    LIVEKIT_API_KEY: "vrata_livekit_key_20260618",
    LIVEKIT_API_SECRET: "livekit_secret_0123456789abcdef0123456789abcdef",
    CONTROL_PLANE_ADMIN_TOKEN: "admin_token_0123456789abcdef0123456789abcdef",
    STATE_TOKEN_SECRET: "state_token_0123456789abcdef0123456789abcdef",
    VRATA_INTERNAL_SERVICE_TOKEN: "internal_token_0123456789abcdef0123456789abcdef",
    POSTGRES_DB: "vrata",
    POSTGRES_USER: "vrata",
    POSTGRES_PASSWORD: "postgres_password_0123456789abcdef",
    POSTGRES_URL: "postgres://vrata:postgres_password_0123456789abcdef@postgres:5432/vrata",
    MINIO_ROOT_USER: "vrata_minio_root",
    MINIO_ROOT_PASSWORD: "minio_password_0123456789abcdef",
    MINIO_BUCKET: "vrata-scene-bundles",
    MINIO_PUBLIC_BASE_URL: "https://storage.vrata-prod.com",
    MINIO_SCENE_PREFIX: "scenes/",
    SCENE_BUNDLE_PROVIDER: "minio-default",
    VRATA_DEV_ROLE_QUERY: "false",
    REMOTE_BROWSER_ENABLED: "false",
    VRATA_ALLOW_EXPERIMENTAL_SERVICES: "false",
    ...overrides
  };
}

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

test("production config validator accepts a complete production env", () => {
  const result = validateProductionConfig(validProductionEnv());
  assert.deepEqual(result, { ok: true, issues: [] });
});

test("production config validator rejects dev secrets and insecure public urls", () => {
  const result = validateProductionConfig(validProductionEnv({
    LIVEKIT_API_KEY: "devkey",
    LIVEKIT_API_SECRET: "secret",
    VRATA_APP_BASE_URL: "http://app.vrata-prod.com",
    ROOM_STATE_PUBLIC_URL: "ws://state.vrata-prod.com",
    API_CORS_ORIGIN: "*",
    VRATA_DEV_ROLE_QUERY: "true"
  }));

  assert.equal(result.ok, false);
  assert.equal(issueCodes(result).includes("blocked_config_value"), true);
  assert.equal(issueCodes(result).includes("blocked_secret_value"), true);
  assert.equal(issueCodes(result).includes("insecure_public_url"), true);
  assert.equal(issueCodes(result).includes("unsafe_cors_origin"), true);
  assert.equal(issueCodes(result).includes("dev_role_query_enabled"), true);
});

test("production config validator permits only explicit loopback insecure override", () => {
  const loopback = validateProductionConfig(validProductionEnv({
    VRATA_ALLOW_INSECURE_PRODUCTION_URLS: "true",
    VRATA_APP_BASE_URL: "http://127.0.0.1:4000",
    CONTROL_PLANE_PUBLIC_URL: "http://127.0.0.1:4000/control-plane",
    ROOM_STATE_PUBLIC_URL: "ws://127.0.0.1:2567",
    LIVEKIT_URL: "ws://127.0.0.1:7880",
    MINIO_PUBLIC_BASE_URL: "http://127.0.0.1:9000"
  }));
  assert.equal(loopback.ok, true);

  const publicHttp = validateProductionConfig(validProductionEnv({
    VRATA_ALLOW_INSECURE_PRODUCTION_URLS: "true",
    VRATA_APP_BASE_URL: "http://app.vrata-prod.com"
  }));
  assert.equal(publicHttp.ok, false);
  assert.equal(issueCodes(publicHttp).includes("insecure_public_url"), true);
});

test("production config validator rejects duplicate secret values without leaking them", () => {
  const repeatedSecret = "shared_secret_0123456789abcdef0123456789abcdef";
  const result = validateProductionConfig(validProductionEnv({
    STATE_TOKEN_SECRET: repeatedSecret,
    VRATA_INTERNAL_SERVICE_TOKEN: repeatedSecret
  }));
  const formatted = formatProductionConfigIssues(result.issues).join("\n");

  assert.equal(result.ok, false);
  assert.equal(issueCodes(result).includes("duplicate_secret"), true);
  assert.equal(formatted.includes(repeatedSecret), false);
  assert.equal(formatted.includes("STATE_TOKEN_SECRET"), true);
  assert.equal(formatted.includes("VRATA_INTERNAL_SERVICE_TOKEN"), true);
});

test("production config validator requires explicit remote browser override", () => {
  const result = validateProductionConfig(validProductionEnv({
    REMOTE_BROWSER_ENABLED: "true",
    REMOTE_BROWSER_PUBLIC_URL: "wss://browser.vrata-prod.com",
    REMOTE_BROWSER_ALLOWED_ORIGINS: "https://app.vrata-prod.com",
    REMOTE_BROWSER_TOKEN_SECRET: "remote_browser_0123456789abcdef0123456789abcdef"
  }));

  assert.equal(result.ok, false);
  assert.equal(issueCodes(result).includes("experimental_service_requires_override"), true);
});

test("production config validator rejects example domains", () => {
  const result = validateProductionConfig(validProductionEnv({
    VRATA_APP_DOMAIN: "app.example.com",
    VRATA_APP_BASE_URL: "https://app.example.com"
  }));

  assert.equal(result.ok, false);
  assert.equal(issueCodes(result).includes("placeholder_domain"), true);
  assert.equal(issueCodes(result).includes("placeholder_public_url_host"), true);
});

test("parseEnvFile parses simple dotenv files", () => {
  assert.deepEqual(parseEnvFile("# comment\nA=1\nB=\"two\"\nC='three'\n"), {
    A: "1",
    B: "two",
    C: "three"
  });
});
