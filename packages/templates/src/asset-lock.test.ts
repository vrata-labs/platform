import assert from "node:assert/strict";
import test from "node:test";
import { getStandardRoomTemplateVersionContract } from "./standard-room-definitions.js";
import { resolveLockedRoomTemplateAssetUrl } from "./asset-lock.js";

const lock = getStandardRoomTemplateVersionContract("personal-room-basic", "1.0.0")!.assetLock;

test("official asset origin uses the definition's exact repository and revision", () => {
  assert.equal(resolveLockedRoomTemplateAssetUrl(lock, lock.sceneManifest.path),
    `https://cdn.jsdelivr.net/gh/${lock.repository}@${lock.commitSha}/${lock.sceneManifest.path}`);
  const independent = { ...lock, repository: "vrata-labs/personal-workspace-v1", commitSha: "a".repeat(40) };
  assert.equal(resolveLockedRoomTemplateAssetUrl(independent, independent.preview.path),
    `https://cdn.jsdelivr.net/gh/vrata-labs/personal-workspace-v1@${"a".repeat(40)}/${lock.preview.path}`);
});

test("one mirror isolates equal relative paths from different repositories and revisions", () => {
  const options = { mirrorBaseUrl: "https://assets.example/mirror" };
  const other = { ...lock, repository: "vrata-labs/personal-workspace-v1" };
  const revised = { ...lock, commitSha: "b".repeat(40) };
  const urls = [lock, other, revised].map(value => resolveLockedRoomTemplateAssetUrl(value, value.sceneAsset.path, options));
  assert.equal(new Set(urls).size, 3);
  assert.equal(urls[0], `https://assets.example/mirror/${lock.repository}/${lock.commitSha}/${lock.sceneAsset.path}`);
  assert.equal(resolveLockedRoomTemplateAssetUrl(lock, lock.sceneAsset.path, { mirrorBaseUrl: options.mirrorBaseUrl+"/" }), urls[0]);
});

test("locked URL resolution rejects path substitution and untrusted mirror configuration", () => {
  for (const path of ["../scene.json", "scene.json?token=x", "assets/other/scene.json"]) {
    assert.throws(() => resolveLockedRoomTemplateAssetUrl(lock, path), /unlocked_template_asset_path/);
  }
  for (const repository of ["../scene", "owner/../scene", "owner/scene?ref=main"]) {
    assert.throws(() => resolveLockedRoomTemplateAssetUrl({ ...lock, repository }, lock.preview.path), /invalid_template_asset_lock/);
  }
  assert.throws(() => resolveLockedRoomTemplateAssetUrl({ ...lock, commitSha: "main" }, lock.preview.path), /invalid_template_asset_lock/);
  for (const mirrorBaseUrl of ["", "http://assets.example", "https://user:pass@assets.example", "https://assets.example/mirror/../other"]) {
    assert.throws(() => resolveLockedRoomTemplateAssetUrl(lock, lock.preview.path, { mirrorBaseUrl }), /invalid_template_asset_base_url/);
  }
  assert.throws(() => resolveLockedRoomTemplateAssetUrl(lock, lock.preview.path, { mirrorBaseUrl: "http://127.0.0.1:4000" }), /invalid_template_asset_base_url/);
  assert.equal(resolveLockedRoomTemplateAssetUrl(lock, lock.preview.path, { mirrorBaseUrl: "http://127.0.0.1:4000", allowLoopbackHttp: true }),
    `http://127.0.0.1:4000/${lock.repository}/${lock.commitSha}/${lock.preview.path}`);
});
