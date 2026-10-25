#!/usr/bin/env node
// Split the local e2e specs into CI shards balanced by measured duration.
// Each shard runs on its own runner with workers=1 (playwright.config.ts), so two
// software-WebGL scenarios never share a host. Every spec lands in exactly one shard;
// a spec without a measured weight gets a default one and still runs.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_SECONDS = 30;
const SPEC = /\.(spec|test)\.[cm]?[jt]sx?$/;

export function listSpecs(directory = join(root, "tests/e2e")) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && SPEC.test(entry.name))
    .map(entry => relative(root, join(entry.parentPath ?? entry.path, entry.name)).split("\\").join("/"))
    .sort();
}

export function readWeights() {
  return JSON.parse(readFileSync(join(root, "tools/e2e-shard-weights.json"), "utf8")).seconds;
}

// Longest processing time first: heaviest spec to the lightest shard, ties by name for determinism.
export function assignShards(specs, weights, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error("e2e_shard_total_invalid");
  const shards = Array.from({ length: total }, () => ({ seconds: 0, specs: [] }));
  const weighted = specs.map(spec => ({ spec, seconds: weights[spec] ?? DEFAULT_SECONDS }))
    .sort((a, b) => b.seconds - a.seconds || a.spec.localeCompare(b.spec));
  for (const { spec, seconds } of weighted) {
    const target = shards.reduce((best, shard, index) => shard.seconds < shards[best].seconds ? index : best, 0);
    shards[target].seconds += seconds;
    shards[target].specs.push(spec);
  }
  for (const shard of shards) shard.specs.sort();
  return shards;
}

// Playwright treats file filters as unanchored regular expressions; anchor each path so a
// spec never selects another one whose path contains it.
export function fileFilter(spec) {
  return `${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [index, total] = process.argv.slice(2).map(Number);
  const shards = assignShards(listSpecs(), readWeights(), total);
  if (!Number.isInteger(index) || index < 1 || index > total) throw new Error("e2e_shard_index_invalid");
  const shard = shards[index - 1];
  console.error(`e2e shard ${index}/${total}: ${shard.specs.length} specs, about ${Math.round(shard.seconds / 60)} min`);
  console.log(shard.specs.map(fileFilter).join("\n"));
}
