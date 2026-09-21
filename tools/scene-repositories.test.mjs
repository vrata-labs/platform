import assert from "node:assert/strict";
import test from "node:test";
import { parseSceneRepositoriesLock, assertSceneRepositoryCoverage } from "./scene-repositories.mjs";

const personal = { repository: "vrata-labs/personal-workspace-v1", commitSha: "a".repeat(40) };
const presentation = { repository: "vrata-labs/presentation-room-v1", commitSha: "b".repeat(40) };
const parse = repositories => parseSceneRepositoriesLock({ schemaVersion: 1, repositories });

test("CI matrix isolates each repository revision and covers every definition", () => {
  const revised = { ...personal, commitSha: "c".repeat(40) };
  const matrix = parse([personal, presentation, revised]);
  assert.equal(new Set(matrix.map(item => item.path)).size, 3);
  assert.equal(matrix[0].path, `.scene-assets/${personal.repository}/${personal.commitSha}`);
  assertSceneRepositoryCoverage(matrix, [personal, presentation, revised, personal].map(assetLock => ({ assetLock })));
  assert.throws(() => assertSceneRepositoryCoverage(matrix, [{ assetLock: personal }]), /scene_repository_definition_coverage_mismatch/);
  assert.throws(() => assertSceneRepositoryCoverage(parse([personal]), [personal, presentation].map(assetLock => ({ assetLock }))), /scene_repository_definition_coverage_mismatch/);
});

test("CI lock rejects mutable revisions, unsafe checkout paths and duplicate repositories", () => {
  for (const repository of ["../repo", "owner/..", "owner/repo/extra", "owner/repo%2fother", "owner/repo?ref=main", "owner/repo\n"]) {
    assert.throws(() => parse([{ ...personal, repository }]), /invalid_scene_repository/);
  }
  for (const commitSha of ["main", "v1.0.0", "a".repeat(39), "a".repeat(40)+"\n"]) {
    assert.throws(() => parse([{ ...personal, commitSha }]), /invalid_scene_repository_commit/);
  }
  assert.throws(() => parse([]), /empty_scene_repositories_lock/);
  assert.throws(() => parse([personal, personal]), /duplicate_scene_repository_revision/);
  assert.throws(() => parse([personal, { ...personal, repository: personal.repository.toUpperCase() }]), /duplicate_scene_repository_revision/);
  assert.throws(() => parseSceneRepositoriesLock({ schemaVersion: 2, repositories: [personal] }), /invalid_scene_repositories_lock/);
});
