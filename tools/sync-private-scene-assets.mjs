import { cp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET_SCENE_ROOT = "apps/runtime-web/public/assets/scenes";

export async function readPrivateSceneManifest(privateAssetsRoot) {
  const manifestPath = resolve(privateAssetsRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || typeof manifest.scenesRoot !== "string" || !Array.isArray(manifest.scenes)) {
    throw new Error("invalid_private_scene_manifest");
  }
  return manifest;
}

export async function syncPrivateSceneAssets({
  privateAssetsRoot,
  targetSceneRoot = DEFAULT_TARGET_SCENE_ROOT
}) {
  if (!privateAssetsRoot) {
    throw new Error("missing_private_assets_root");
  }

  const resolvedPrivateAssetsRoot = resolve(privateAssetsRoot);
  const resolvedTargetSceneRoot = resolve(targetSceneRoot);
  const manifest = await readPrivateSceneManifest(resolvedPrivateAssetsRoot);
  const synced = [];

  for (const scene of manifest.scenes) {
    const sceneDir = scene.sceneDir ?? scene.sceneId;
    if (typeof sceneDir !== "string" || !sceneDir.startsWith("sense-")) {
      throw new Error(`invalid_private_scene_dir:${String(sceneDir)}`);
    }
    await cp(resolve(resolvedPrivateAssetsRoot, manifest.scenesRoot, sceneDir), resolve(resolvedTargetSceneRoot, sceneDir), {
      recursive: true,
      force: true
    });
    synced.push(sceneDir);
  }

  return { sceneCount: synced.length, scenes: synced.sort() };
}

async function main() {
  const privateAssetsRoot = process.argv[2];
  if (!privateAssetsRoot) {
    console.error("usage: node tools/sync-private-scene-assets.mjs /path/to/private-repo/assets");
    process.exitCode = 2;
    return;
  }

  const result = await syncPrivateSceneAssets({ privateAssetsRoot });
  console.log(`synced_private_scene_assets:${result.sceneCount}`);
  for (const scene of result.scenes) {
    console.log(`- ${scene}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
