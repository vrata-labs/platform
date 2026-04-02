import * as THREE from "three";

import { inspectSceneObject, type SceneDiagnosticsSnapshot } from "./scene-debug.js";
import { loadSceneBundle } from "./scene-loader.js";

export interface SceneSessionResult {
  activeSceneBundleRoot: THREE.Object3D | null;
  effectiveCleanSceneMode: boolean;
  sceneBundleState: "fallback" | "loaded" | "failed";
  sceneDebug: SceneDiagnosticsSnapshot;
  brandingSuffix: string | null;
  note: "scene_bundle_loaded" | "scene_bundle_failed" | null;
}

export async function startSceneBundleSession(input: {
  scene: THREE.Scene;
  player: THREE.Object3D;
  camera: THREE.Camera;
  bundleUrl: string;
  requestedCleanSceneMode: boolean;
  sceneFitEnabled: boolean;
  previousSceneDebug: SceneDiagnosticsSnapshot;
  applySceneMaterialDebugMode(root: THREE.Object3D): void;
  applyCleanSceneMode(enabled: boolean): void;
  applySceneDebugFit(boundingBox: NonNullable<SceneDiagnosticsSnapshot["boundingBox"]>): void;
  setFallbackEnvironmentVisible(visible: boolean): void;
}): Promise<SceneSessionResult> {
  try {
    const loadedScene = await loadSceneBundle({
      scene: input.scene,
      player: input.player,
      bundleUrl: input.bundleUrl
    });
    const effectiveCleanSceneMode = input.requestedCleanSceneMode || loadedScene.manifest.renderMode === "clean";
    input.applySceneMaterialDebugMode(loadedScene.group);
    input.setFallbackEnvironmentVisible(false);
    if (effectiveCleanSceneMode) {
      input.applyCleanSceneMode(true);
    }
    let sceneDebug = inspectSceneObject({
      root: loadedScene.group,
      camera: input.camera,
      previous: {
        ...input.previousSceneDebug,
        bundleUrl: input.bundleUrl,
        state: "loaded",
        label: loadedScene.manifest.label,
        source: loadedScene.manifest.source,
        assetUrl: loadedScene.assetUrl,
        assetType: loadedScene.assetType,
        spawnPointId: loadedScene.spawnPointId,
        spawnApplied: loadedScene.spawnPointApplied,
        loadMs: loadedScene.loadMs,
        missingAssets: loadedScene.missingAssets
      }
    });
    if (input.sceneFitEnabled && sceneDebug.boundingBox) {
      input.applySceneDebugFit(sceneDebug.boundingBox);
      sceneDebug = inspectSceneObject({
        root: loadedScene.group,
        camera: input.camera,
        previous: sceneDebug
      });
    }
    return {
      activeSceneBundleRoot: loadedScene.group,
      effectiveCleanSceneMode,
      sceneBundleState: "loaded",
      sceneDebug,
      brandingSuffix: `Scene: ${loadedScene.manifest.label}`,
      note: "scene_bundle_loaded"
    };
  } catch {
    input.setFallbackEnvironmentVisible(true);
    return {
      activeSceneBundleRoot: null,
      effectiveCleanSceneMode: input.requestedCleanSceneMode,
      sceneBundleState: "failed",
      sceneDebug: {
        ...input.previousSceneDebug,
        bundleUrl: input.bundleUrl,
        state: "failed",
        missingAssets: [],
        loadMs: null
      },
      brandingSuffix: "Scene bundle fallback active",
      note: "scene_bundle_failed"
    };
  }
}
