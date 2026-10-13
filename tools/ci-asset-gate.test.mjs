import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("required asset-validation context fails for any unsuccessful matrix result", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const gate = workflow.split("\n  asset-validation-gate:\n")[1];
  assert(gate, "the required context must be emitted separately from matrix job names");
  assert.match(gate, /^    name: asset-validation$/m);
  assert.match(gate, /^    needs: asset-validation$/m);
  assert.match(gate, /^    if: always\(\)$/m, "failed or skipped matrices must emit a failing check");
  assert.match(gate, /ASSET_VALIDATION_RESULT: \$\{\{ needs\.asset-validation\.result \}\}/);
  const script = gate.match(/^        run: (.+)$/m)?.[1];
  assert(script);
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const execution = spawnSync("bash", ["-e", "-c", script], {
      env: { ...process.env, ASSET_VALIDATION_RESULT: result }, stdio: "ignore"
    });
    assert.equal(execution.status === 0, result === "success", result);
  }
});
