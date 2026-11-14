import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Keep the ordinary tools/*.test.mjs gate browser-free and explicitly scoped.
const suites = [
  "tests/e2e/functional-diagnostics.unit.ts",
  "tests/e2e/hardware-rendering.unit.ts",
  "tests/e2e/seat-marker-proof.unit.ts",
  "tests/e2e/seat-occupied-observation.unit.ts",
  "tests/e2e/seat-release-observation.unit.ts"
];

for (const suite of suites) test(suite, context => {
  const env = { ...process.env };
  // A nested runner must not inherit the parent's child-v8 IPC protocol.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types", // Supported by CI's Node 22; preserve .ts imports.
    "--test", "--experimental-test-isolation=none", "--test-concurrency=1",
    "--test-timeout=30000", "--test-reporter=tap", suite
  ], {
    cwd: root, env, encoding: "utf8", timeout: 45000, killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024
  });
  // No reporter parsing: expose every child result and trust the process status.
  // Isolation=none leaves no runner grandchildren behind on a hard timeout.
  if (result.stdout) context.diagnostic(result.stdout);
  if (result.stderr) context.diagnostic(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${suite} terminated by ${result.signal}`);
  assert.equal(result.status, 0, `${suite} failed with exit code ${result.status}`);
});
