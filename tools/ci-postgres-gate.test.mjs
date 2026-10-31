import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");

test("core and every browser shard require healthy PostgreSQL 16 and Node 22", () => {
  for (const name of ["core", "e2e"]) {
    const job = workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0];
    assert.match(job, /services:\n\s+postgres:\n\s+image: postgres:16/);
    assert.match(job, /--health-cmd "pg_isready -U postgres -d vrata_test"/);
    assert.match(job, /node-version: 22/);
    assert.match(job, /VRATA_TEST_POSTGRES_URL: postgres:\/\/postgres:postgres@127\.0\.0\.1:5432\/vrata_test/);
    assert.match(job, name === "core" ? /run: pnpm test\n/ : /pnpm test:e2e/);
  }
});

test("local CI fails before discovery without PG; remote discovery needs no local PG", () => {
  const env = { ...process.env, CI: "1", PLAYWRIGHT_NO_WEB_SERVER: "0" };
  delete env.VRATA_TEST_POSTGRES_URL;
  const list = overrides => spawnSync(process.execPath, [cli, "test", "--list", "tests/e2e/public-demo.spec.ts"], {
    env: { ...env, ...overrides }, encoding: "utf8", timeout: 45_000
  });
  const missing = list({});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /local_ci_requires_VRATA_TEST_POSTGRES_URL/);
  // Discovery does not connect: a non-secret sentinel proves presence gating.
  assert.equal(list({ VRATA_TEST_POSTGRES_URL: "postgres://discovery-only" }).status, 0);
  assert.equal(list({ PLAYWRIGHT_NO_WEB_SERVER: "1" }).status, 0);
});
