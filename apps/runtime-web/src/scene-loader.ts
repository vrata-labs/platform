import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { parseSceneBundleManifest, pickSceneSpawnPoint, resolveSceneAssetUrl, type SceneBundleManifest } from "./scene-bundle.js";

export interface LoadedSceneBundle {
  manifest: SceneBundleManifest;
  group: THREE.Group;
  spawnPointApplied: boolean;
  spawnPointId: string | null;
  assetUrl: string;
  assetType: string;
  loadMs: number;
  missingAssets: string[];
}

export async function loadSceneBundle(input: {
  scene: THREE.Scene;
  player: THREE.Object3D;
  bundleUrl: string;
}): Promise<LoadedSceneBundle> {
  const startedAt = performance.now();
  const response = await fetch(input.bundleUrl);
  if (!response.ok) {
    throw new Error(`failed_to_load_scene_bundle_manifest:${response.status}`);
  }

  const manifest = parseSceneBundleManifest(await response.json());
  const group = new THREE.Group();
  group.name = `scene-bundle:${manifest.sceneId}`;
  const sceneAssetUrl = resolveSceneAssetUrl(response.url, manifest.glbPath);
  const missingAssets = new Set<string>();
  if (/[.]fbx$/i.test(sceneAssetUrl)) {
    const manager = new THREE.LoadingManager();
    manager.onError = (url) => {
      missingAssets.add(url);
    };
    const loader = new FBXLoader(manager);
    const fbx = await loader.loadAsync(sceneAssetUrl);
    group.add(fbx);
  } else {
    const manager = new THREE.LoadingManager();
    manager.onError = (url) => {
      missingAssets.add(url);
    };
    const loader = new GLTFLoader(manager);
    const gltf = await loader.loadAsync(sceneAssetUrl);
    group.add(gltf.scene);
  }
  input.scene.add(group);

  const spawnPoint = pickSceneSpawnPoint(manifest);
  if (spawnPoint) {
    input.player.position.set(spawnPoint.position.x, spawnPoint.position.y, spawnPoint.position.z);
  }

  return {
    manifest,
    group,
    spawnPointApplied: Boolean(spawnPoint),
    spawnPointId: spawnPoint?.id ?? null,
    assetUrl: sceneAssetUrl,
    assetType: sceneAssetUrl.split(".").pop()?.toLowerCase() ?? "unknown",
    loadMs: Math.round(performance.now() - startedAt),
    missingAssets: Array.from(missingAssets)
  };
}
