import test from "node:test";
import assert from "node:assert/strict";

import { getLivekitCredentials, getMediaTokenConfigError, getLivekitDeploymentDiagnostics } from "./livekit-config.js";

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  LIVEKIT_URL: "wss://media.example.test",
  LIVEKIT_API_KEY: "test-key",
  LIVEKIT_API_SECRET: "test-secret"
};

test("credentials default independently when values are absent", () => {
  assert.deepEqual(getLivekitCredentials({}), { apiKey: "devkey", apiSecret: "secret" });
  assert.deepEqual(getLivekitCredentials({ LIVEKIT_API_KEY: "key" }), { apiKey: "key", apiSecret: "secret" });
  assert.deepEqual(getLivekitCredentials({ LIVEKIT_API_SECRET: "value" }), { apiKey: "devkey", apiSecret: "value" });
});

test("credentials preserve explicit empty values and whitespace", () => {
  assert.deepEqual(getLivekitCredentials({ LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: " " }), { apiKey: "", apiSecret: " " });
  assert.deepEqual(getLivekitCredentials({ LIVEKIT_API_KEY: " key ", LIVEKIT_API_SECRET: " value " }), { apiKey: " key ", apiSecret: " value " });
});

test("credential results are independent objects", () => {
  const first = getLivekitCredentials(productionEnv);
  first.apiKey = "changed";
  assert.equal(getLivekitCredentials(productionEnv).apiKey, "test-key");
});

test("configuration checks apply only to the exact production environment", () => {
  for (const NODE_ENV of [undefined, "", "development", "test", "Production", "production "]) {
    assert.equal(getMediaTokenConfigError({ NODE_ENV }), null);
  }
});

test("production missing settings are reported in the existing order", () => {
  assert.equal(getMediaTokenConfigError({ NODE_ENV: "production" }), "missing_required_livekit_env:LIVEKIT_URL,LIVEKIT_API_KEY,LIVEKIT_API_SECRET");
  assert.equal(getMediaTokenConfigError({ NODE_ENV: "production", LIVEKIT_API_KEY: "key" }), "missing_required_livekit_env:LIVEKIT_URL,LIVEKIT_API_SECRET");
});

test("production treats absent, empty and whitespace-only settings as missing", () => {
  for (const name of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
    for (const value of [undefined, "", " \t\n"]) {
      assert.equal(getMediaTokenConfigError({ ...productionEnv, [name]: value }), `missing_required_livekit_env:${name}`);
    }
  }
});

test("configured secure signaling is accepted in production", () => {
  assert.equal(getMediaTokenConfigError(productionEnv), null);
});

test("production preserves case-sensitive untrimmed secure URL prefix checks", () => {
  for (const LIVEKIT_URL of ["ws://media.example.test", "https://media.example.test", "WSS://media.example.test", " wss://media.example.test", "not-a-url"]) {
    assert.equal(getMediaTokenConfigError({ ...productionEnv, LIVEKIT_URL }), "livekit_url_must_use_wss");
  }
  // Characterize the existing prefix check; this module is not a general URL validator.
  assert.equal(getMediaTokenConfigError({ ...productionEnv, LIVEKIT_URL: "wss://" }), null);
});

test("all existing development credentials are forbidden in production", () => {
  for (const override of [{ LIVEKIT_API_KEY: "devkey" }, { LIVEKIT_API_SECRET: "secret" }, { LIVEKIT_API_SECRET: "devsecret" }]) {
    assert.equal(getMediaTokenConfigError({ ...productionEnv, ...override }), "livekit_dev_credentials_forbidden");
  }
});

test("development credential matching remains exact without trimming or case folding", () => {
  for (const override of [{ LIVEKIT_API_KEY: "DEVKEY" }, { LIVEKIT_API_KEY: " devkey " }, { LIVEKIT_API_SECRET: " secret " }]) {
    assert.equal(getMediaTokenConfigError({ ...productionEnv, ...override }), null);
  }
});

test("configuration errors retain missing, protocol, credentials precedence", () => {
  const env = { ...productionEnv, LIVEKIT_URL: "ws://media.example.test", LIVEKIT_API_KEY: "devkey" };
  assert.equal(getMediaTokenConfigError({ ...env, LIVEKIT_API_SECRET: "" }), "missing_required_livekit_env:LIVEKIT_API_SECRET");
  assert.equal(getMediaTokenConfigError(env), "livekit_url_must_use_wss");
  assert.equal(getMediaTokenConfigError({ ...env, LIVEKIT_URL: productionEnv.LIVEKIT_URL }), "livekit_dev_credentials_forbidden");
});

test("explicit affirmative overrides allow existing loopback websocket forms", () => {
  for (const flag of ["1", "true", "yes", "on", " TRUE "]) {
    for (const LIVEKIT_URL of ["ws://localhost:7880", "ws://LOCALHOST:7880", "ws://127.0.0.1:7880", "ws://127.0.0.2", " ws://localhost:7880 "]) {
      assert.equal(getMediaTokenConfigError({ ...productionEnv, LIVEKIT_URL, VRATA_ALLOW_INSECURE_PRODUCTION_URLS: flag }), null);
    }
  }
});

test("insecure loopback URLs are rejected without an affirmative override", () => {
  for (const flag of [undefined, "", " ", "0", "false", "no", "off", "unknown"]) {
    assert.equal(getMediaTokenConfigError({ ...productionEnv, LIVEKIT_URL: "ws://localhost:7880", VRATA_ALLOW_INSECURE_PRODUCTION_URLS: flag }), "livekit_url_must_use_wss");
  }
});

test("insecure overrides preserve host and protocol restrictions", () => {
  for (const LIVEKIT_URL of ["ws://media.example.test", "ws://localhost.example.test", "ws://0.0.0.0", "http://localhost:7880", "https://localhost:7880", "invalid", "ws://[::1]:7880"]) {
    assert.equal(getMediaTokenConfigError({ ...productionEnv, LIVEKIT_URL, VRATA_ALLOW_INSECURE_PRODUCTION_URLS: "true" }), "livekit_url_must_use_wss");
  }
});

test("insecure loopback override does not bypass development credential rejection", () => {
  assert.equal(getMediaTokenConfigError({ ...productionEnv, LIVEKIT_URL: "ws://localhost:7880", LIVEKIT_API_KEY: "devkey", VRATA_ALLOW_INSECURE_PRODUCTION_URLS: "true" }), "livekit_dev_credentials_forbidden");
});

test("empty diagnostics retain their full public shape", () => {
  assert.deepEqual(getLivekitDeploymentDiagnostics({}), {
    configured: false, signalingTls: false, urlProtocol: null, urlHost: null,
    turn: { enabled: false, domain: null, tlsPort: null, udpPort: null, externalTls: false, relayRange: null }
  });
});

test("diagnostics trim the URL and report parsed protocol and host", () => {
  const result = getLivekitDeploymentDiagnostics({ ...productionEnv, LIVEKIT_URL: "  wss://MEDIA.example.test:7880/path?mode=1#part  " });
  assert.equal(result.configured, true);
  assert.equal(result.signalingTls, true);
  assert.equal(result.urlProtocol, "wss");
  assert.equal(result.urlHost, "media.example.test:7880");
});

test("diagnostics distinguish missing, malformed and differently cased URLs", () => {
  for (const LIVEKIT_URL of [undefined, "", " \n"]) {
    const result = getLivekitDeploymentDiagnostics({ ...productionEnv, LIVEKIT_URL });
    assert.equal(result.urlProtocol, null);
    assert.equal(result.urlHost, null);
    assert.equal(result.configured, false);
  }
  const malformed = getLivekitDeploymentDiagnostics({ ...productionEnv, LIVEKIT_URL: "wss://" });
  assert.equal(malformed.configured, true);
  assert.equal(malformed.signalingTls, true);
  assert.equal(malformed.urlProtocol, "invalid");
  assert.equal(malformed.urlHost, null);
  const uppercase = getLivekitDeploymentDiagnostics({ ...productionEnv, LIVEKIT_URL: "WSS://media.example.test" });
  assert.equal(uppercase.urlProtocol, "wss");
  assert.equal(uppercase.signalingTls, false);
});

test("diagnostics do not include credentials, userinfo, URL paths or query values", () => {
  const result = getLivekitDeploymentDiagnostics({ ...productionEnv, LIVEKIT_URL: "wss://test-user:test-password@media.example.test/private-path?token=test-token#private-fragment" });
  assert.equal(result.urlHost, "media.example.test");
  for (const value of ["test-key", "test-secret", "test-user", "test-password", "private-path", "test-token", "private-fragment"]) {
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test("configured diagnostics preserve credential truthiness rather than validation semantics", () => {
  assert.equal(getLivekitDeploymentDiagnostics({ ...productionEnv, LIVEKIT_API_KEY: "" }).configured, false);
  assert.equal(getLivekitDeploymentDiagnostics({ ...productionEnv, LIVEKIT_API_SECRET: "" }).configured, false);
  assert.equal(getLivekitDeploymentDiagnostics({ ...productionEnv, LIVEKIT_API_KEY: " ", LIVEKIT_API_SECRET: " " }).configured, true);
});

test("TURN boolean flags use the existing environment-value parser", () => {
  for (const value of ["1", "true", "yes", "on", " YES ", "0", "false", "no", "off", "unknown", "", undefined]) {
    const result = getLivekitDeploymentDiagnostics({ LIVEKIT_TURN_ENABLED: value, LIVEKIT_TURN_EXTERNAL_TLS: value });
    const expected = ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
    assert.equal(result.turn.enabled, expected);
    assert.equal(result.turn.externalTls, expected);
  }
});

test("TURN domain whitespace and missing values retain existing handling", () => {
  assert.equal(getLivekitDeploymentDiagnostics({ LIVEKIT_TURN_DOMAIN: " relay.example.test " }).turn.domain, "relay.example.test");
  for (const value of [undefined, "", " \t"]) assert.equal(getLivekitDeploymentDiagnostics({ LIVEKIT_TURN_DOMAIN: value }).turn.domain, null);
});

test("TURN ports accept only canonical integers in the current range", () => {
  for (const [value, expected] of [["1", 1], ["65535", 65535], [" 5349 ", 5349], ["3478", 3478]] as const) {
    const result = getLivekitDeploymentDiagnostics({ LIVEKIT_TURN_TLS_PORT: value, LIVEKIT_TURN_UDP_PORT: value });
    assert.equal(result.turn.tlsPort, expected);
    assert.equal(result.turn.udpPort, expected);
  }
  for (const value of [undefined, "", " ", "0", "65536", "-1", "+1", "01", "1.0", "1e3", "3478x", "Infinity"]) {
    const result = getLivekitDeploymentDiagnostics({ LIVEKIT_TURN_TLS_PORT: value, LIVEKIT_TURN_UDP_PORT: value });
    assert.equal(result.turn.tlsPort, null);
    assert.equal(result.turn.udpPort, null);
  }
});

test("relay ranges require both raw values and preserve independent endpoint parsing", () => {
  for (const env of [{}, { LIVEKIT_TURN_RELAY_RANGE_START: "50000" }, { LIVEKIT_TURN_RELAY_RANGE_END: "50100" }, { LIVEKIT_TURN_RELAY_RANGE_START: "", LIVEKIT_TURN_RELAY_RANGE_END: "50100" }]) {
    assert.equal(getLivekitDeploymentDiagnostics(env).turn.relayRange, null);
  }
  assert.deepEqual(getLivekitDeploymentDiagnostics({ LIVEKIT_TURN_RELAY_RANGE_START: "50000", LIVEKIT_TURN_RELAY_RANGE_END: "50100" }).turn.relayRange, { start: 50000, end: 50100 });
  assert.deepEqual(getLivekitDeploymentDiagnostics({ LIVEKIT_TURN_RELAY_RANGE_START: " ", LIVEKIT_TURN_RELAY_RANGE_END: "invalid" }).turn.relayRange, { start: null, end: null });
  assert.deepEqual(getLivekitDeploymentDiagnostics({ LIVEKIT_TURN_RELAY_RANGE_START: "50100", LIVEKIT_TURN_RELAY_RANGE_END: "50000" }).turn.relayRange, { start: 50100, end: 50000 });
});

test("helpers neither mutate explicit environments nor share nested diagnostic state", () => {
  const env = Object.freeze({ ...productionEnv, LIVEKIT_TURN_ENABLED: "true" });
  getLivekitCredentials(env);
  getMediaTokenConfigError(env);
  const result = getLivekitDeploymentDiagnostics(env);
  result.turn.enabled = false;
  assert.equal(getLivekitDeploymentDiagnostics(env).turn.enabled, true);
});

test("default parameters read process.env at call time while explicit env takes precedence", () => {
  const keys = ["NODE_ENV", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(getLivekitCredentials(), { apiKey: "devkey", apiSecret: "secret" });
    assert.equal(getMediaTokenConfigError(), null);
    assert.equal(getLivekitDeploymentDiagnostics().configured, false);
    for (const key of keys) process.env[key] = productionEnv[key];
    assert.deepEqual(getLivekitCredentials(), { apiKey: "test-key", apiSecret: "test-secret" });
    assert.equal(getMediaTokenConfigError(), null);
    assert.equal(getLivekitDeploymentDiagnostics().configured, true);
    process.env.LIVEKIT_API_SECRET = "devsecret";
    assert.equal(getMediaTokenConfigError(), "livekit_dev_credentials_forbidden");
    assert.equal(getMediaTokenConfigError(productionEnv), null);
    assert.equal(getLivekitCredentials(productionEnv).apiSecret, "test-secret");
    assert.equal(getLivekitDeploymentDiagnostics({}).configured, false);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
