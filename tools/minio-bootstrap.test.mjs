import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bootstrap = fileURLToPath(new URL("../infra/docker/minio-bootstrap.sh", import.meta.url));
const client = "pgsty/mc:RELEASE.2026-10-18T00-00-00Z@sha256:6ecdaec70bc5e8cf9d0e9a70c190f3beb1c83f11617ff4333f1fcd71ab1daf18";

function run(t, password, failure = false) {
  const dir = mkdtempSync(join(tmpdir(), "vrata-bootstrap-argv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "argv.jsonl");
  // The pinned mc accepts -- at alias-set scope, before positional arguments. Assert exact argv, not shell text.
  writeFileSync(join(dir, "mc"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "alias") {
  const expected = ["alias", "set", "--", "vrata", "http://minio:9000", process.env.MINIO_ROOT_USER, process.env.MINIO_ROOT_PASSWORD];
  if (JSON.stringify(args) !== JSON.stringify(expected)) {
    console.error("alias positional argument contract violated");
    process.exit(9);
  }
  if (process.env.FAIL_ALIAS === "true") {
    console.error("Unable to initialize new alias: synthetic connection refused");
    process.exit(1);
  }
} else if (JSON.stringify(args) === JSON.stringify(["anonymous", "get-json", "vrata/private-plugins"])) {
  console.log("{}");
}
`, { mode: 0o700 });
  const result = spawnSync("sh", [bootstrap], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ARGV_LOG: log,
      MINIO_ENDPOINT: "http://minio:9000", MINIO_ROOT_USER: "-synthetic-access-key", MINIO_ROOT_PASSWORD: password,
      MINIO_BUCKET: "public-assets", ROOM_PLUGIN_BUCKET: "private-plugins", MINIO_SCENE_PREFIX: "",
      STORAGE_BOOTSTRAP_ATTEMPTS: "2", STORAGE_BOOTSTRAP_DELAY: "0", FAIL_ALIAS: String(failure) },
    encoding: "utf8", timeout: 5000
  });
  return { result, calls: readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

for (const [label, password] of [
  ["generated leading dash", `-${"a".repeat(63)}`], ["single dash", "-"], ["double dash", "--"],
  ["flag-shaped", "--help"], ["whitespace", " synthetic white\tspace "],
  ["shell metacharacters", '-special $`"\'\\;&=!?*[]']
]) {
  test(`bootstrap passes ${label} literally after end-of-options`, t => {
    const { result, calls } = run(t, password);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(calls[0].at(-1), password);
    assert.deepEqual(calls.slice(1), [
      ["mb", "--ignore-existing", "vrata/private-plugins"],
      ["anonymous", "get-json", "vrata/private-plugins"],
      ["mb", "--ignore-existing", "vrata/public-assets"],
      ["anonymous", "set", "download", "vrata/public-assets"]
    ]);
  });
}

test("alias failures retain diagnostics, retry budget and fail closed before bucket changes", t => {
  const password = "-synthetic-secret-must-not-be-logged";
  const { result, calls } = run(t, password, true);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Unable to initialize new alias: synthetic connection refused\n".repeat(2));
  assert.ok(!result.stderr.includes(password));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(args => args[0] === "alias"));
});

test("staging, self-host and production use the same bootstrap and verified client", () => {
  for (const name of ["staging", "selfhost", "production"]) {
    const source = readFileSync(new URL(`../infra/docker/compose.${name}.yml`, import.meta.url), "utf8");
    const block = source.split("\n  minio-bootstrap:\n")[1].split(/\n  [a-z]/)[0];
    assert.ok(block.includes(`    image: ${client}\n`), name);
    assert.ok(block.includes("./minio-bootstrap.sh:/bootstrap.sh:ro"), name);
    assert.ok(block.includes('entrypoint: ["/bin/sh", "/bootstrap.sh"]'), name);
  }
});
