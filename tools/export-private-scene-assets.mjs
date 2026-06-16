import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SCENE_ROOT = "apps/runtime-web/public/assets/scenes";

export async function listPrivateSceneBundleDirs(sceneRoot = DEFAULT_SCENE_ROOT) {
  const entries = await readdir(sceneRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("sense-"))
    .map((entry) => entry.name)
    .sort();
}

export async function readSceneBundleSummary(sceneRoot, sceneDir) {
  const sceneJsonPath = resolve(sceneRoot, sceneDir, "scene.json");
  const payload = JSON.parse(await readFile(sceneJsonPath, "utf8"));
  return {
    sceneDir,
    sceneId: payload.sceneId ?? sceneDir,
    label: payload.label ?? sceneDir,
    source: payload.source ?? null,
    glbPath: payload.glbPath ?? null
  };
}

export async function exportPrivateSceneAssets({ sceneRoot = DEFAULT_SCENE_ROOT, targetScenesRoot }) {
  if (!targetScenesRoot) {
    throw new Error("missing_target_scenes_root");
  }

  const resolvedSceneRoot = resolve(sceneRoot);
  const resolvedTargetScenesRoot = resolve(targetScenesRoot);
  if (resolvedTargetScenesRoot.startsWith(`${resolvedSceneRoot}/`) || resolvedTargetScenesRoot === resolvedSceneRoot) {
    throw new Error("target_must_not_be_inside_source_scene_root");
  }

  await mkdir(resolvedTargetScenesRoot, { recursive: true });
  const sceneDirs = await listPrivateSceneBundleDirs(resolvedSceneRoot);
  const manifest = [];

  for (const sceneDir of sceneDirs) {
    await cp(resolve(resolvedSceneRoot, sceneDir), resolve(resolvedTargetScenesRoot, sceneDir), {
      recursive: true,
      force: true
    });
    manifest.push(await readSceneBundleSummary(resolvedSceneRoot, sceneDir));
  }

  const manifestPath = resolve(dirname(resolvedTargetScenesRoot), "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, scenesRoot: basename(resolvedTargetScenesRoot), scenes: manifest }, null, 2)}\n`);

  return { sceneCount: manifest.length, manifestPath, scenes: manifest };
}

async function main() {
  const targetScenesRoot = process.argv[2];
  if (!targetScenesRoot) {
    console.error("usage: node tools/export-private-scene-assets.mjs /path/to/private-repo/assets/scenes");
    process.exitCode = 2;
    return;
  }

  const result = await exportPrivateSceneAssets({ targetScenesRoot });
  console.log(`exported_private_scene_assets:${result.sceneCount}`);
  console.log(`manifest:${result.manifestPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
