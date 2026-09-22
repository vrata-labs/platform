import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateSceneBundlePath } from "../packages/asset-pipeline/dist/index.js";
import {
  listReferenceTemplateVersionContracts
} from "../packages/templates/dist/index.js";
import { parseSceneRepositoriesLock, assertSceneRepositoryCoverage } from "./scene-repositories.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyFileLock(assetsRoot, lock) {
  const bytes = await readFile(join(assetsRoot, lock.path));
  assert(bytes.length === lock.sizeBytes, `reference_asset_size_mismatch:${lock.path}`);
  assert(sha256(bytes) === lock.sha256, `reference_asset_checksum_mismatch:${lock.path}`);
}

const repositories = parseSceneRepositoriesLock(JSON.parse(await readFile(join(repoRoot, "scene-repositories.lock.json"), "utf8")));
const definitions = listReferenceTemplateVersionContracts();
assertSceneRepositoryCoverage(repositories, definitions);
const selectedRepository = process.env.VRATA_SCENE_REPOSITORY;
const selectedCommit = process.env.VRATA_SCENE_COMMIT_SHA;
assert(Boolean(selectedRepository) === Boolean(selectedCommit), "incomplete_scene_repository_selection");
const selected = selectedRepository ? repositories.filter(item => item.repository === selectedRepository && item.commitSha === selectedCommit) : repositories;
assert(selected.length > 0, "unknown_scene_repository_selection");
const checkouts = new Map();
for (const item of selected) {
  const assetsRoot = process.env.VRATA_SCENE_REPOSITORIES_ROOT
    ? resolve(process.env.VRATA_SCENE_REPOSITORIES_ROOT, item.repository, item.commitSha)
    : resolve(repoRoot, item.path);
  const checkoutCommit = execFileSync("git", ["-C", assetsRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert(checkoutCommit === item.commitSha, "scene_assets_checkout_lock_mismatch");
  checkouts.set(`${item.repository}@${item.commitSha}`, {
    assetsRoot,
    releaseManifest: JSON.parse(await readFile(join(assetsRoot, "manifest.json"), "utf8"))
  });
}
for (const definition of definitions) {
  const lock = definition.assetLock;
  const checkout = checkouts.get(`${lock.repository}@${lock.commitSha}`);
  if (!checkout) continue;
  const { assetsRoot, releaseManifest } = checkout;
  await Promise.all([
    verifyFileLock(assetsRoot, lock.releaseManifest),
    verifyFileLock(assetsRoot, lock.sceneManifest),
    verifyFileLock(assetsRoot, lock.sceneAsset),
    verifyFileLock(assetsRoot, lock.preview)
  ]);

  const release = releaseManifest.releases?.find((candidate) => candidate.sceneId === definition.scene.sceneId
    && candidate.version === definition.scene.sceneVersion);
  assert(release, `reference_asset_release_missing:${lock.sceneReleaseId}`);
  const expectedReleasePath = dirname(lock.sceneManifest.path);
  assert(release.releasePath === expectedReleasePath, `reference_asset_release_path_mismatch:${lock.sceneReleaseId}`);
  const releaseFileNames = Object.keys(release.files ?? {}).sort();
  assert(
    JSON.stringify(releaseFileNames) === JSON.stringify(["LICENSES.md", "preview.webp", "scene.glb", "scene.json"]),
    `reference_asset_release_file_set_mismatch:${lock.sceneReleaseId}`
  );
  for (const fileName of releaseFileNames) {
    const manifestFile = release.files[fileName];
    const bytes = await readFile(join(assetsRoot, expectedReleasePath, fileName));
    assert(bytes.length === manifestFile.sizeBytes, `reference_asset_release_size_mismatch:${expectedReleasePath}/${fileName}`);
    assert(sha256(bytes) === manifestFile.sha256, `reference_asset_release_checksum_mismatch:${expectedReleasePath}/${fileName}`);
  }
  for (const [manifestName, fileLock] of [
    ["scene.json", lock.sceneManifest],
    ["scene.glb", lock.sceneAsset],
    ["preview.webp", lock.preview]
  ]) {
    const manifestFile = release.files?.[manifestName];
    assert(manifestFile?.sha256 === fileLock.sha256, `reference_asset_manifest_checksum_mismatch:${fileLock.path}`);
    assert(manifestFile?.sizeBytes === fileLock.sizeBytes, `reference_asset_manifest_size_mismatch:${fileLock.path}`);
  }

  const result = await validateSceneBundlePath(join(assetsRoot, expectedReleasePath), {
    maxMainAssetBytes: 15 * 1024 * 1024,
    maxBundleBytes: 15 * 1024 * 1024,
    templateContract: definition.scene,
    sceneVersion: definition.scene.sceneVersion
  });
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    for (const issue of result.issues) {
      process.stderr.write(`${lock.sceneReleaseId}:${issue.code}:${issue.message}\n`);
    }
    throw new Error(`reference_asset_template_validation_failed:${lock.sceneReleaseId}`);
  }
  process.stdout.write(`${definition.templateId}@${definition.version} verified against ${lock.sceneReleaseId} at ${lock.repository}@${lock.commitSha}.\n`);
}
