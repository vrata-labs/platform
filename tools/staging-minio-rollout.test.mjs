import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

const helper = new URL("./staging-minio-rollout.py", import.meta.url).pathname;
const sha = "a".repeat(40);
const minio = "minio/minio:RELEASE.2025-02-28T09-55-16Z";
const mc = "minio/mc:RELEASE.2025-03-12T17-29-24Z";
const pinnedMinio = `quay.io/${minio}@sha256:a929054ae025fa7997857cd0e2a2e3029238e31ad89877326dc032f4c1a14259`;
const pinnedMc = `quay.io/${mc}@sha256:470f5546b596e16c7816b9c3fa7a78ce4076bb73c2c73f7faeec0c8043923123`;
const legacy = `services:\n  minio:\n    image: ${minio}\n    volumes: [minio-data:/data]\n  minio-bootstrap:\n    image: ${mc}\n  api:\n    image: \${API_IMAGE_REPO}:\${IMAGE_TAG}\n`;
const translated = legacy.replace(`image: ${minio}`, `image: ${pinnedMinio}`).replace(`image: ${mc}`, `image: ${pinnedMc}`);

function fixture(t, content = legacy, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), "vrata-minio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const compose = join(dir, "compose.staging.yml");
  const script = join(dir, "rollout-staging-images.sh");
  writeFileSync(compose, content);
  chmodSync(compose, 0o640);
  writeFileSync(script, `#!/bin/bash\nset -eu\ncd -- "$(dirname "$0")"\ncp compose.staging.yml observed.yml\nprintf '%s' "$1" > observed-sha\nexit ${exitCode}\n`);
  return { dir, compose, script, content };
}

function run(f, args = [f.script, sha]) {
  return spawnSync("python3", [helper, ...args], { encoding: "utf8", timeout: 5000 });
}

for (const exitCode of [0, 7]) {
  test(`legacy rollout uses pinned images and restores exact source on exit ${exitCode}`, (t) => {
    const f = fixture(t, legacy, exitCode);
    const result = run(f);
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(readFileSync(join(f.dir, "observed.yml"), "utf8"), translated);
    assert.equal(readFileSync(join(f.dir, "observed-sha"), "utf8"), sha);
    assert.equal(readFileSync(f.compose, "utf8"), legacy);
    assert.equal(statSync(f.compose).mode & 0o777, 0o640);
    assert.match(result.stdout, /staging_minio_registry_compat:restored/);
  });
}

test("already pinned checkouts are not rewritten", (t) => {
  const f = fixture(t, translated);
  const before = statSync(f.compose);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(f.compose).ino, before.ino);
  assert.equal(statSync(f.compose).mtimeMs, before.mtimeMs);
  assert.doesNotMatch(result.stdout, /compat:applied/);
  assert.equal(readFileSync(join(f.dir, "observed.yml"), "utf8"), translated);
});

test("custom releases, comments, environment values and application image tags are untouched", (t) => {
  const content = `services:\n  minio:\n    image: custom/minio:release\n    environment:\n      ORIGINAL: ${minio}\n#    image: ${mc}\n  api:\n    image: app:${sha}\n`;
  const f = fixture(t, content);
  assert.equal(run(f).status, 0);
  assert.equal(readFileSync(join(f.dir, "observed.yml"), "utf8"), content);
});

test("translation preserves CRLF, spacing and inline comments", (t) => {
  const content = legacy.replaceAll("\n", "\r\n").replace(`image: ${mc}`, `image:   ${mc}  # keep`);
  const expected = translated.replaceAll("\n", "\r\n").replace(`image: ${pinnedMc}`, `image:   ${pinnedMc}  # keep`);
  const f = fixture(t, content);
  assert.equal(run(f).status, 0);
  assert.equal(readFileSync(join(f.dir, "observed.yml"), "utf8"), expected);
  assert.equal(readFileSync(f.compose, "utf8"), content);
});

test("invalid image SHAs are rejected before any mutation or rollout", (t) => {
  for (const input of ["", "main", "b5b2331", "a".repeat(39), "A".repeat(40), `${sha};echo unsafe`]) {
    const f = fixture(t);
    assert.notEqual(run(f, [f.script, input]).status, 0);
    assert.equal(readFileSync(f.compose, "utf8"), legacy);
    assert.equal(existsSync(join(f.dir, "observed.yml")), false);
  }
});

test("missing rollout script fails before mutating Compose", (t) => {
  const f = fixture(t);
  rmSync(f.script);
  assert.notEqual(run(f).status, 0);
  assert.equal(readFileSync(f.compose, "utf8"), legacy);
});

test("SIGTERM is forwarded and the old Compose source is restored", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(f.script, '#!/bin/bash\nprintf "ready\\n"\nsleep 30\n');
  const child = spawn("python3", [helper, f.script, sha], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  let output = "";
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("ready")) resolve();
    });
  });
  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 143);
  assert.equal(readFileSync(f.compose, "utf8"), legacy);
});

test("staging Compose pins both official multi-platform manifests", () => {
  const compose = readFileSync(new URL("../infra/docker/compose.staging.yml", import.meta.url), "utf8");
  assert.ok(compose.includes(`    image: ${pinnedMinio}\n`));
  assert.ok(compose.includes(`    image: ${pinnedMc}\n`));
  assert.doesNotMatch(compose, /image: minio\//);
});

test("workflow snapshots compatibility helper before old checkout and uses it for deploy and rollback", () => {
  const workflow = readFileSync(new URL("../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
  const copy = workflow.indexOf('cp tools/staging-minio-rollout.py "$RUNNER_TEMP/vrata-scene-rollback/"');
  assert.ok(copy > 0 && copy < workflow.indexOf("name: Sync workspace to deploy SHA"));
  assert.equal(workflow.match(/python3 "\\\$ROLLOUT_HELPER" \.\/infra\/docker\/rollout-staging-images.sh/g)?.length, 2);
  assert.match(workflow, /rollout-staging-images.sh "\$ROLLBACK_SHA"/);
  assert.match(workflow, /pnpm test:e2e:staging/);
  assert.match(workflow, /PLAYWRIGHT_REPORT_NAME=staging-rutube-blocking pnpm test:e2e:rutube/);
});
