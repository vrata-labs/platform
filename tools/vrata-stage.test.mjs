import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("on-demand stand leases, creation and removal keep their safety rules", () => {
  const output = execFileSync("python3", ["-B", fileURLToPath(new URL("./vrata_stage_test.py", import.meta.url))], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(output, "");
});

test("scheduled Rutube canary runs once a day and only while the stand exists", () => {
  const workflow = readFileSync(new URL("../.github/workflows/rutube-canary.yml", import.meta.url), "utf8");
  const crons = [...workflow.matchAll(/cron:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(crons.length, 1);
  const [minute, hour, day, month, weekday] = crons[0].split(/\s+/);
  assert.match(minute, /^\d+$/);
  assert.match(hour, /^\d+$/);
  assert.deepEqual([day, month, weekday], ["*", "*", "*"]);
  assert.match(workflow, /vars\.STAGING_AUTO_DEPLOY_ENABLED != 'false'/);
});

test("platform stand hook gives both keys to cloud-init and keeps the admin token out of user-data", () => {
  const dir = mkdtempSync(join(tmpdir(), "vrata-stage-hook-"));
  try {
    writeFileSync(join(dir, "admin.pub"), "ssh-ed25519 AAAAadmin admin\n");
    writeFileSync(join(dir, "ci.pub"), "ssh-ed25519 AAAAci ci\n");
    writeFileSync(join(dir, "token"), "secret-token-value-that-must-stay-out-of-user-data\n");
    const userData = execFileSync("bash", [fileURLToPath(new URL("../infra/staging/on-demand-hook.sh", import.meta.url)), "user-data"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, STAGE_SERVER_NAME: "vrata-platform-stage", STAGE_ADMIN_PUBKEY: join(dir, "admin.pub"),
        STAGE_CI_PUBKEY: join(dir, "ci.pub"), STAGE_ADMIN_TOKEN: join(dir, "token") },
    });
    assert.match(userData, /^#cloud-config\n/);
    assert.match(userData, /- ssh-ed25519 AAAAadmin admin\n/);
    assert.match(userData, /- ssh-ed25519 AAAAci ci\n/);
    assert.doesNotMatch(userData, /secret-token-value/);
    assert.match(userData, /ssh_pwauth: false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const hook = readFileSync(new URL("../infra/staging/on-demand-hook.sh", import.meta.url), "utf8");
  assert.match(hook, /bootstrap=true/);
  assert.match(hook, /<"\$STAGE_ADMIN_TOKEN"/);
});

test("dispatched deploy runs carry the request id in their name", () => {
  const workflow = readFileSync(new URL("../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
  assert.match(workflow, /^run-name: \$\{\{ inputs\.request && format\('Staging Deploy \{0\}', inputs\.request\) \|\| '' \}\}$/m);
  assert.match(workflow, /      request:\n        description: [^\n]+\n        required: false\n        default: ""\n        type: string/);
});
