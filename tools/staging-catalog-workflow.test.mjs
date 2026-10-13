import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("catalog workflow ships an independently importable guarded protocol", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const workflow = readFileSync(new URL("../.github/workflows/template-catalog.yml", import.meta.url), "utf8");
  const files = workflow.match(/tar -C tools -czf - ([a-zA-Z0-9_. -]+) \| ssh/)?.[1].trim().split(/\s+/);
  assert(files, "the workflow must transport the complete helper bundle");
  const directory = mkdtempSync(join(tmpdir(), "vrata-catalog-protocol-"));
  try {
    const archive = execFileSync("tar", ["-C", join(root, "tools"), "-czf", "-", ...files]);
    execFileSync("tar", ["-xzf", "-", "-C", directory], { input: archive });
    const output = execFileSync("python3", ["-B", join(directory, "staging-template-catalog.py"), "--help"], { encoding: "utf8" });
    assert.match(output, /guard-accepted/);
    assert.match(output, /activate/);
    assert.match(workflow, /STAGING_SSH_KNOWN_HOSTS/);
    assert.doesNotMatch(workflow, /StrictHostKeyChecking=no/);
    assert(workflow.indexOf("Prepare accepted catalog protocol") < workflow.indexOf("Retain pre-activation legacy regression fixtures"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
