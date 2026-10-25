import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assignShards, DEFAULT_SECONDS, fileFilter, listSpecs, readWeights } from "./e2e-shard.mjs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const total = Number(workflow.match(/shard: \[([\d, ]+)\]/)[1].split(",").length);

test("every local e2e spec runs in exactly one CI shard", () => {
  const specs = listSpecs();
  assert(specs.includes("tests/e2e/runtime.spec.ts") && specs.includes("tests/e2e/m0.5/reliable-room-scenario.spec.ts"));
  const shards = assignShards(specs, readWeights(), total);
  const assigned = shards.flatMap(shard => shard.specs).sort();
  assert.deepEqual(assigned, specs);
  assert.equal(new Set(assigned).size, assigned.length);
  assert(shards.every(shard => shard.specs.length > 0));
  // Deterministic: the same input gives the same split on every runner.
  assert.deepEqual(assignShards(specs, readWeights(), total), shards);
});

test("shards stay balanced and new specs still run", () => {
  const weights = readWeights();
  const shards = assignShards(listSpecs(), weights, total);
  const seconds = shards.map(shard => shard.seconds);
  const heaviest = Math.max(...Object.values(weights));
  assert(Math.max(...seconds) - Math.min(...seconds) <= heaviest, JSON.stringify(seconds));
  const withNew = assignShards([...listSpecs(), "tests/e2e/brand-new.spec.ts"], weights, total);
  assert.equal(withNew.filter(shard => shard.specs.includes("tests/e2e/brand-new.spec.ts")).length, 1);
  assert.equal(DEFAULT_SECONDS > 0, true);
  for (const spec of Object.keys(weights)) assert(listSpecs().includes(spec), `stale weight for ${spec}`);
});

test("file filters select only their own spec", () => {
  const specs = listSpecs();
  for (const spec of specs) {
    const filter = new RegExp(fileFilter(spec), "gi");
    assert.deepEqual(specs.filter(other => new RegExp(filter.source, "gi").test(`/repo/${other}`)), [spec]);
  }
  const output = execFileSync("node", [fileURLToPath(new URL("./e2e-shard.mjs", import.meta.url)), "1", String(total)], { encoding: "utf8" });
  assert(output.trim().split("\n").every(line => line.startsWith("tests/e2e/") && line.endsWith("$")));
});

test("CI runs the shards, the unit job and a gate under the required check name", () => {
  assert.match(workflow, /node tools\/e2e-shard\.mjs "\$\{\{ matrix\.shard \}\}" "\$\{\{ strategy\.job-total \}\}"/);
  assert.match(workflow, /^  checks:\n(?:    .*\n)*?    needs: \[changes, core, e2e\]/m);
  assert.doesNotMatch(workflow, /M0\.5 acceptance/);
  assert.doesNotMatch(workflow, /run: pnpm (lint|typecheck)$/m);
  // Every shard must start its own services and test database.
  const e2e = workflow.split("\n  e2e:\n")[1].split("\n  checks:\n")[0];
  assert.match(e2e, /services:\n\s+postgres:/);
  assert.match(e2e, /fail-fast: false/);
});
