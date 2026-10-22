import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { loadIntegrationKeyring, parseIntegrationKeys, verifyIntegrationAssertion } from "./integration-auth.js";
import { createIntegrationTestKey, integrationKeysEnv, signIntegrationAssertion } from "./testing/integration-assertions.js";

const current = createIntegrationTestKey("portal-stage-2", "portal:stage");
const previous = createIntegrationTestKey("portal-stage-1", "portal:stage");
const prod = createIntegrationTestKey("portal-prod-1", "portal:prod");
const keyring = parseIntegrationKeys(integrationKeysEnv([current, previous, prod]));

test("integration assertion accepts both rotated keys of one issuer and returns its principal and scopes", () => {
  for (const key of [current, previous]) {
    const result = verifyIntegrationAssertion(signIntegrationAssertion(key, { scope: ["createRoom", "getRoom"] }), keyring);
    assert.equal(result.ok, true);
    assert(result.ok);
    assert.equal(result.value.principal, "portal:stage");
    assert.equal(result.value.kid, key.kid);
    assert.deepEqual([...result.value.scopes].sort(), ["createRoom", "getRoom"]);
  }
  const spaced = verifyIntegrationAssertion(signIntegrationAssertion(current, { scope: "getRoom findOperation" }), keyring);
  assert(spaced.ok);
  assert.deepEqual([...spaced.value.scopes].sort(), ["findOperation", "getRoom"]);
});

test("integration assertion rejects forged, foreign and malformed tokens", () => {
  const now = Math.floor(Date.now() / 1000);
  const stranger = createIntegrationTestKey(current.kid, "portal:stage");
  const cases: Array<[string | null, string]> = [
    [null, "missing_assertion"],
    ["not-a-jws", "malformed_assertion"],
    [signIntegrationAssertion(stranger), "invalid_signature"],
    [signIntegrationAssertion(current, {}, { alg: "HS256" }), "unsupported_header"],
    [signIntegrationAssertion(current, {}, { crit: ["exp"] }), "unsupported_header"],
    [signIntegrationAssertion(createIntegrationTestKey("unknown-kid")), "unknown_key"],
    [signIntegrationAssertion(current, { iss: "portal:prod" }), "issuer_mismatch"],
    [signIntegrationAssertion(prod, { iss: "portal:stage" }), "issuer_mismatch"],
    [signIntegrationAssertion(current, { aud: "platform-integration-v2" }), "audience_mismatch"],
    [signIntegrationAssertion(current, { iat: now, exp: now + 61 }), "invalid_lifetime"],
    [signIntegrationAssertion(current, { iat: now, exp: now }), "invalid_lifetime"],
    [signIntegrationAssertion(current, { iat: now + 0.5 }), "invalid_lifetime"],
    [signIntegrationAssertion(current, { iat: now - 120, exp: now - 70 }), "expired"],
    [signIntegrationAssertion(current, { iat: now + 60, exp: now + 90 }), "not_yet_valid"],
    [signIntegrationAssertion(current, { jti: "short" }), "invalid_jti"],
    [signIntegrationAssertion(current, { scope: [1] }), "invalid_scope"]
  ];
  for (const [token, reason] of cases) {
    assert.deepEqual(verifyIntegrationAssertion(token, keyring), { ok: false, reason }, reason);
  }
  const tampered = signIntegrationAssertion(current).split(".");
  tampered[1] = Buffer.from(JSON.stringify({ iss: "portal:stage", aud: "platform-integration-v1", iat: now, exp: now + 30, jti: "x".repeat(20), scope: ["createRoom"] })).toString("base64url");
  assert.deepEqual(verifyIntegrationAssertion(tampered.join("."), keyring), { ok: false, reason: "invalid_signature" });
});

test("integration assertion drops scopes the key does not grant and keeps a replay window past exp", () => {
  const limited = createIntegrationTestKey("portal-limited", "portal:stage");
  const limitedKeyring = parseIntegrationKeys(integrationKeysEnv([limited], ["getRoom"]));
  const now = Math.floor(Date.now() / 1000);
  const result = verifyIntegrationAssertion(signIntegrationAssertion(limited, { scope: ["getRoom", "createRoom", "deleteEverything"], iat: now, exp: now + 20 }), limitedKeyring, now);
  assert(result.ok);
  assert.deepEqual([...result.value.scopes], ["getRoom"]);
  assert(result.value.replayUntilSeconds > now + 20);
});

test("integration keyring accepts only Ed25519 public keys with known issuers and scopes", () => {
  assert.equal(parseIntegrationKeys(undefined).size, 0);
  assert.equal(parseIntegrationKeys(" ").size, 0);
  const privateJwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const rsaJwk = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
  const entry = { kid: "k1", issuer: "portal:stage", scopes: ["getRoom"], publicKey: current.publicJwk };
  const invalid: Array<[unknown, RegExp]> = [
    ["{", /json/],
    [{}, /not_array/],
    [[{ ...entry, kid: "bad kid" }], /kid/],
    [[entry, entry], /duplicate_kid/],
    [[{ ...entry, issuer: "portal-demo:stage" }], /issuer/],
    [[{ ...entry, scopes: [] }], /scopes/],
    [[{ ...entry, scopes: ["admin"] }], /scopes/],
    [[{ ...entry, publicKey: privateJwk }], /private_key_material/],
    [[{ ...entry, publicKey: rsaJwk }], /public_key/],
    [[{ ...entry, publicKey: { kty: "OKP", crv: "Ed25519", x: "AA" } }], /public_key/]
  ];
  for (const [value, pattern] of invalid) {
    assert.throws(() => parseIntegrationKeys(typeof value === "string" ? value : JSON.stringify(value)), pattern);
  }
  const env = { VRATA_INTEGRATION_KEYS: JSON.stringify([entry]) };
  assert.equal(loadIntegrationKeyring(env), loadIntegrationKeyring(env));
  assert.equal(loadIntegrationKeyring(env).get("k1")?.issuer, "portal:stage");
});
