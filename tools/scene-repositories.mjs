import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseSceneRepositoriesLock(value) {
  assert.equal(value?.schemaVersion, 1, "invalid_scene_repositories_lock");
  assert(Array.isArray(value.repositories) && value.repositories.length > 0, "empty_scene_repositories_lock");
  const keys = new Set();
  return value.repositories.map(item => {
    assert(item && typeof item.repository === "string", "invalid_scene_repository");
    const parts = item.repository.split("/");
    assert(parts.length === 2 && parts.every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== ".."), "invalid_scene_repository");
    assert(typeof item.commitSha === "string" && /^[a-f0-9]{40}$/.test(item.commitSha), "invalid_scene_repository_commit");
    const key = `${item.repository.toLowerCase()}@${item.commitSha}`;
    assert(!keys.has(key), "duplicate_scene_repository_revision");
    keys.add(key);
    return { repository: item.repository, commitSha: item.commitSha, path: `.scene-assets/${item.repository}/${item.commitSha}` };
  });
}

export function assertSceneRepositoryCoverage(repositories, definitions) {
  const declared = repositories.map(({ repository, commitSha }) => `${repository}@${commitSha}`).sort();
  const used = [...new Set(definitions.map(({ assetLock }) => `${assetLock.repository}@${assetLock.commitSha}`))].sort();
  assert.deepEqual(declared, used, "scene_repository_definition_coverage_mismatch");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const repositories = parseSceneRepositoriesLock(JSON.parse(await readFile(resolve(root, "scene-repositories.lock.json"), "utf8")));
  process.stdout.write(JSON.stringify({ include: repositories })+"\n");
}
