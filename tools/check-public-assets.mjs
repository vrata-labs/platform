import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PUBLIC_SCENE_ALLOWLIST = [
  "livadia-nicholas-office-v1",
  "the-hall-v1",
  "the-office-v1"
];

export async function listSceneBundleDirs(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function findBlockedPublicSceneDirs(sceneDirs, allowlist = DEFAULT_PUBLIC_SCENE_ALLOWLIST) {
  const allowed = new Set(allowlist);
  return sceneDirs.filter((sceneDir) => !allowed.has(sceneDir));
}

export async function checkPublicSceneAssets({
  rootDir = "apps/runtime-web/public/assets/scenes",
  allowlist = DEFAULT_PUBLIC_SCENE_ALLOWLIST
} = {}) {
  const sceneDirs = await listSceneBundleDirs(rootDir);
  return findBlockedPublicSceneDirs(sceneDirs, allowlist);
}

async function main() {
  const blocked = await checkPublicSceneAssets();
  if (blocked.length === 0) {
    console.log("public_asset_audit_ok");
    return;
  }

  console.error("public_asset_audit_failed: non-cleared scene assets are present");
  for (const sceneDir of blocked) {
    console.error(`- ${sceneDir}`);
  }
  console.error("See docs/asset-license-audit.md before publishing public release images.");
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
