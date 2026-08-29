import * as THREE from "three";

import { inspectSceneObject, type SceneDiagnosticsSnapshot } from "./scene-debug.js";
import type { SceneBundleManifest, SceneBundleRenderProfile, SceneBundleSpawnPoint } from "./scene-bundle.js";
import { disposeSceneObject } from "./scene-dispose.js";
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
  applySceneRenderProfile(profile: SceneBundleRenderProfile | undefined, root: THREE.Object3D | null): void;
  applyCleanSceneMode(enabled: boolean): void;
  applySceneDebugFit(boundingBox: NonNullable<SceneDiagnosticsSnapshot["boundingBox"]>): void;
  applySpawnPoint?(spawnPoint: SceneBundleSpawnPoint): void;
  setFallbackEnvironmentVisible(visible: boolean): void;
  loadSceneBundleImpl?: typeof loadSceneBundle;
}): Promise<SceneSessionResult> {
  let candidateSceneRoot: THREE.Group | null = null;
  try {
    const loadedScene = await (input.loadSceneBundleImpl ?? loadSceneBundle)({
      bundleUrl: input.bundleUrl,
      onLoadStage(stage) {
        input.previousSceneDebug.loadStage = stage;
      },
      onAssetProgress(loaded, expected) {
        input.previousSceneDebug.assetBytesLoaded = loaded;
        input.previousSceneDebug.assetBytesExpected = expected;
      }
    });
    candidateSceneRoot = loadedScene.group;
    const effectiveCleanSceneMode = input.requestedCleanSceneMode || loadedScene.manifest.renderMode === "clean";
    input.applySceneMaterialDebugMode(loadedScene.group);
    const renderProfileStartedAt = performance.now();
    input.applySceneRenderProfile(loadedScene.manifest.renderProfile, loadedScene.group);
    const renderProfileApplyMs = loadedScene.manifest.renderProfile
      ? Math.round(performance.now() - renderProfileStartedAt)
      : null;
    if (effectiveCleanSceneMode) {
      input.applyCleanSceneMode(true);
    }
    input.scene.add(loadedScene.group);
    input.previousSceneDebug.loadStage = "scene_added";
    input.setFallbackEnvironmentVisible(false);
    if (loadedScene.spawnPoint && input.applySpawnPoint) {
      input.applySpawnPoint(loadedScene.spawnPoint);
      loadedScene.spawnPointApplied = true;
    }
    input.previousSceneDebug.loadStage = "spawn_applied";
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
        renderProfile: loadedScene.manifest.renderProfile ?? null,
        assetUrl: loadedScene.assetUrl,
        assetType: loadedScene.assetType,
        spawnPointId: loadedScene.spawnPointId,
        spawnYaw: loadedScene.spawnPoint?.yaw ?? null,
        spawnApplied: loadedScene.spawnPointApplied,
        loadMs: loadedScene.loadMs,
        renderProfileApplyMs,
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
    if (candidateSceneRoot) {
      disposeSceneObject(candidateSceneRoot);
    }
    input.applySceneRenderProfile(undefined, null);
    input.applyCleanSceneMode(input.requestedCleanSceneMode);
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
        loadMs: null,
        renderProfileApplyMs: null
      },
      brandingSuffix: "Scene bundle fallback active",
      note: "scene_bundle_failed"
    };
  }
}
