import * as THREE from "three";

import { inspectSceneObject, type SceneDiagnosticsSnapshot } from "./scene-debug.js";
import type { SceneBundleManifest, SceneBundleSpawnPoint } from "./scene-bundle.js";
import { loadSceneBundle } from "./scene-loader.js";

export interface SceneSessionResult {
  activeSceneBundleRoot: THREE.Object3D | null;
  sceneManifest: SceneBundleManifest | null;
  effectiveCleanSceneMode: boolean;
  sceneBundleState: "fallback" | "loaded" | "failed";
  sceneDebug: SceneDiagnosticsSnapshot;
  brandingSuffix: string | null;
  note: "scene_bundle_loaded" | "scene_bundle_failed" | null;
}

function getFailureReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function startSceneBundleSession(input: {
  scene: THREE.Scene;
  camera: THREE.Camera;
  bundleUrl: string;
  requestedCleanSceneMode: boolean;
  sceneFitEnabled: boolean;
  previousSceneDebug: SceneDiagnosticsSnapshot;
  applySceneMaterialDebugMode(root: THREE.Object3D): void;
  applyCleanSceneMode(enabled: boolean): void;
  applySceneDebugFit(boundingBox: NonNullable<SceneDiagnosticsSnapshot["boundingBox"]>): void;
  applySpawnPoint?(spawnPoint: SceneBundleSpawnPoint): void;
  setFallbackEnvironmentVisible(visible: boolean): void;
}): Promise<SceneSessionResult> {
  try {
    const loadedScene = await loadSceneBundle({
      scene: input.scene,
      bundleUrl: input.bundleUrl,
      applySpawnPoint: input.applySpawnPoint,
      onLoadStage(stage) {
        input.previousSceneDebug.loadStage = stage;
      },
      onAssetProgress(loaded, expected) {
        input.previousSceneDebug.assetBytesLoaded = loaded;
        input.previousSceneDebug.assetBytesExpected = expected;
      }
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
        failureReason: null,
        loadStage: "loaded",
        assetBytesLoaded: input.previousSceneDebug.assetBytesLoaded,
        assetBytesExpected: input.previousSceneDebug.assetBytesExpected,
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
      sceneManifest: loadedScene.manifest,
      effectiveCleanSceneMode,
      sceneBundleState: "loaded",
      sceneDebug,
      brandingSuffix: `Scene: ${loadedScene.manifest.label}`,
      note: "scene_bundle_loaded"
    };
  } catch (error) {
    input.setFallbackEnvironmentVisible(true);
    return {
      activeSceneBundleRoot: null,
      sceneManifest: null,
      effectiveCleanSceneMode: input.requestedCleanSceneMode,
      sceneBundleState: "failed",
      sceneDebug: {
        ...input.previousSceneDebug,
        bundleUrl: input.bundleUrl,
        state: "failed",
        failureReason: getFailureReason(error),
        loadStage: input.previousSceneDebug.loadStage,
        assetBytesLoaded: input.previousSceneDebug.assetBytesLoaded,
        assetBytesExpected: input.previousSceneDebug.assetBytesExpected,
        missingAssets: [],
        loadMs: null
      },
      brandingSuffix: "Scene bundle fallback active",
      note: "scene_bundle_failed"
    };
  }
}
