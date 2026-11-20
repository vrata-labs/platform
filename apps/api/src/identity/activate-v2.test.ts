import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { identitySessionSecretReady } from "./activate-v2.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("./activate-v2.js", import.meta.url));

test("identity v2 secret readiness follows the session codec: at least 32 bytes of the API's resolved secret", () => {
  assert.equal(identitySessionSecretReady({ STATE_TOKEN_SECRET: "x".repeat(31) }), false);
  assert.equal(identitySessionSecretReady({ STATE_TOKEN_SECRET: "x".repeat(32) }), true);
  assert.equal(identitySessionSecretReady({ STATE_TOKEN_SECRET: "я".repeat(16) }), true, "the rule counts bytes, not characters");
  assert.equal(identitySessionSecretReady({}), false, "the development fallback secret is too short for v2");
  assert.equal(identitySessionSecretReady({ NODE_ENV: "production" }), false);
  assert.equal(identitySessionSecretReady({ NODE_ENV: "production", STATE_TOKEN_SECRET: `REPLACE_WITH_${"x".repeat(32)}` }), false);
});

test("the irreversible raise is refused before connecting when the state token secret is too short; the secret is never printed", async () => {
  const secret = "short-operator-secret";
  // An unreachable database: the refusal must come before any connection attempt.
  const env = { ...process.env, NODE_ENV: "production", STATE_TOKEN_SECRET: secret, POSTGRES_URL: "postgres://127.0.0.1:9/unreachable" };
  const refused = await run(process.execPath, [cli, "--confirm-irreversible"], { env, timeout: 15_000 })
    .then(() => ({ stdout: "", stderr: "", code: 0 }), error => error as { stdout: string; stderr: string; code: number });
  assert.equal(refused.code, 1);
  assert.deepEqual(JSON.parse(refused.stdout), { ok: false, error: "identity_activation_secret_too_short" });
  assert.equal(`${refused.stdout}${refused.stderr}`.includes(secret), false);

  const missing = await run(process.execPath, [cli, "--confirm-irreversible"], { env: { ...env, STATE_TOKEN_SECRET: "" }, timeout: 15_000 })
    .then(() => ({ stdout: "", code: 0 }), error => error as { stdout: string; code: number });
  assert.equal(missing.code, 1);
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, error: "identity_activation_secret_too_short" });
});
