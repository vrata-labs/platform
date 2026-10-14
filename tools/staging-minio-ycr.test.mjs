import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const helper = new URL("./staging-minio-rollout.py", import.meta.url).pathname;
const sha = "b".repeat(40);
const server = "cr.yandex/crp9cm29k6p76hqo8lti/vrata-minio@sha256:c83dd50c5efe2e3a962711a7c9fc77acfc55c3dad229da2146489f604afba387";
const client = "cr.yandex/crp9cm29k6p76hqo8lti/vrata-mc@sha256:d535999f5c4eb01c9c06bd0c068d4bb8f7366a8469fe57e394907190f7feb550";
const hubServer = "minio/minio:RELEASE.2025-02-28T09-55-16Z";
const hubClient = "minio/mc:RELEASE.2025-03-12T17-29-24Z";
const quayServer = `quay.io/${hubServer}@sha256:a929054ae025fa7997857cd0e2a2e3029238e31ad89877326dc032f4c1a14259`;
const quayClient = `quay.io/${hubClient}@sha256:470f5546b596e16c7816b9c3fa7a78ce4076bb73c2c73f7faeec0c8043923123`;

function run(t, content, code = 0) {
  const dir = mkdtempSync(join(tmpdir(), "vrata-minio-ycr-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const compose = join(dir, "compose.staging.yml");
  const script = join(dir, "rollout-staging-images.sh");
  writeFileSync(compose, content);
  chmodSync(compose, 0o640);
  writeFileSync(script, `#!/bin/bash\nset -eu\ncd -- "$(dirname "$0")"\ncp compose.staging.yml observed.yml\nprintf '%s' "$1" > sha\nexit ${code}\n`);
  const result = spawnSync("python3", [helper, script, sha], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, code, result.stderr);
  assert.equal(readFileSync(compose, "utf8"), content, "restore exact source");
  assert.equal(statSync(compose).mode & 0o777, 0o640, "restore permissions");
  assert.equal(readFileSync(join(dir, "sha"), "utf8"), sha, "keep application SHA");
  return readFileSync(join(dir, "observed.yml"), "utf8");
}

for (const [label, old, pinned] of [
  ["Hub server", hubServer, server], ["Hub client", hubClient, client],
  ["Quay server", quayServer, server], ["Quay client", quayClient, client],
]) {
  for (const code of [0, 19]) {
    test(`${label} keeps comments, CRLF and source on exit ${code}`, (t) => {
      const content = `services:\r\n  dependency:\r\n    image:   ${old} # keep\r\n    environment:\r\n      ORIGINAL: ${old}\r\n# image: ${old}\r\n  api:\r\n    image: custom/app:${sha}\r\n`;
      const expected = content.replace(`image:   ${old} # keep`, `image:   ${pinned} # keep`);
      assert.equal(run(t, content, code), expected);
    });
  }
}

for (const image of [
  `${hubServer}-custom`, `${hubClient}-custom`,
  `${quayServer.slice(0, -1)}0`, `${quayClient.slice(0, -1)}0`,
  `registry.example/${hubServer}`, `registry.example/${hubClient}`,
]) {
  test(`does not translate a different release or repository: ${image}`, (t) => {
    const content = `services:\n  dependency:\n    image: ${image}\n`;
    assert.equal(run(t, content), content);
  });
}

test("binary recipes retain upstream releases and exact binary/base checksums", () => {
  const base = "alpine:3.21@sha256:ce64758a109eb420d874a118f87920e625e12d3634e03b4a5573fd9f6e5d3507";
  for (const [binary, release, checksum] of [
    ["minio", "2025-02-28T09-55-16Z", "5cb1e6309f2bd70e7d0ca77f33782beac1745790deb4c1f94444f1e7dec5fcb6"],
    ["mc", "2025-03-12T17-29-24Z", "a92b5f1af200ca25d54d78432ef6b0c47fd4340abf9759ce5d10275cd57e3318"],
  ]) {
    const recipe = readFileSync(new URL(`../infra/docker/${binary}.demo-local.Dockerfile`, import.meta.url), "utf8");
    assert.ok(recipe.startsWith(`FROM ${base}\n`));
    assert.ok(recipe.includes(`ADD --checksum=sha256:${checksum}`));
    assert.ok(recipe.includes(`https://github.com/minio/${binary}/releases/download/RELEASE.${release}/${binary}.linux-amd64.RELEASE.${release}`));
    assert.ok(recipe.includes(`ENTRYPOINT ["/usr/local/bin/${binary}"]`));
    assert.doesNotMatch(recipe, /:latest|--no-check-certificate/);
  }
});

test("dependency publication verifies exact YCR digests before reusing existing tags", () => {
  const workflow = readFileSync(new URL("../.github/workflows/docker-publish.yml", import.meta.url), "utf8");
  for (const [name, image, checksum] of [
    ["minio", server, "5cb1e6309f2bd70e7d0ca77f33782beac1745790deb4c1f94444f1e7dec5fcb6"],
    ["mc", client, "a92b5f1af200ca25d54d78432ef6b0c47fd4340abf9759ce5d10275cd57e3318"],
  ]) {
    const digest = image.split("@")[1];
    assert.equal(workflow.split(`= "${digest}"`).length - 1, 2, "verify at reuse and final gate");
    assert.ok(workflow.includes(`if: steps.pinned_deps.outputs.${name}_exists != 'true'`));
    assert.ok(workflow.includes(`file: infra/docker/${name}.demo-local.Dockerfile`));
    assert.ok(workflow.includes(`}}:${checksum}`));
  }
  assert.ok(workflow.includes('for image in "$API_IMAGE" "$ROOM_STATE_IMAGE" "$REMOTE_BROWSER_IMAGE"'));
  assert.ok(workflow.includes('for tag in "$SHA_TAG" "$BRANCH_SLUG" staging'));
});
