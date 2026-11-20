import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("private scene releases keep publication and extraction safety rules", () => {
  const output = execFileSync("python3", ["-B", fileURLToPath(new URL("./private-scene-release.test.py", import.meta.url))], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  assert.equal(output, "");
});
