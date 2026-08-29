import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createEmptySceneDiagnostics } from "./scene-debug.js";
import { startSceneBundleSession } from "./scene-session.js";

test("startSceneBundleSession reports failure result for missing bundle", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("missing", { status: 404 });

  let fallbackVisible = false;
  let renderProfileReset = false;
  const cleanModes: boolean[] = [];
  try {
    const result = await startSceneBundleSession({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      bundleUrl: "https://example.com/scene.json",
      requestedCleanSceneMode: false,
      sceneFitEnabled: false,
      previousSceneDebug: createEmptySceneDiagnostics(),
      applySceneMaterialDebugMode() {},
      applySceneRenderProfile(profile, root) {
        renderProfileReset = profile === undefined && root === null;
      },
      applyCleanSceneMode(enabled) {
        cleanModes.push(enabled);
      },
      applySceneDebugFit() {},
      setFallbackEnvironmentVisible(visible) {
        fallbackVisible = visible;
      }
    });

    assert.equal(result.sceneBundleState, "failed");
    assert.equal(result.note, "scene_bundle_failed");
    assert.equal(result.sceneDebug.failureReason, "failed_to_load_scene_bundle_manifest:404");
    assert.equal(result.sceneDebug.loadStage, "manifest_requested");
    assert.equal(fallbackVisible, true);
    assert.equal(renderProfileReset, true);
    assert.deepEqual(cleanModes, [false]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startSceneBundleSession rolls back attached scene resources and render state", async () => {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial();
  let geometryDisposed = false;
  let materialDisposed = false;
  geometry.addEventListener("dispose", () => geometryDisposed = true);
  material.addEventListener("dispose", () => materialDisposed = true);
  group.add(new THREE.Mesh(geometry, material));
  const renderProfiles: Array<string | undefined> = [];
  const cleanModes: boolean[] = [];

  const result = await startSceneBundleSession({
    scene,
    camera: new THREE.PerspectiveCamera(),
    bundleUrl: "https://example.com/scene.json",
    requestedCleanSceneMode: false,
    sceneFitEnabled: false,
    previousSceneDebug: createEmptySceneDiagnostics(),
    applySceneMaterialDebugMode() {},
    applySceneRenderProfile(profile) {
      renderProfiles.push(profile);
    },
    applyCleanSceneMode(enabled) {
      cleanModes.push(enabled);
    },
    applySceneDebugFit() {},
    applySpawnPoint() {
      throw new Error("spawn_failed");
    },
    setFallbackEnvironmentVisible() {},
    async loadSceneBundleImpl() {
      return {
        manifest: {
          schemaVersion: 1,
          sceneId: "test-scene",
          label: "Test Scene",
          source: "test",
          glbPath: "scene.glb",
          renderMode: "clean",
          renderProfile: "neutral-pbr",
          spawnPoints: []
        },
        group,
        spawnPointApplied: false,
        spawnPointId: "main",
        spawnPoint: {
          id: "main",
          position: { x: 0, y: 0, z: 0 }
        },
        assetUrl: "https://example.com/scene.glb",
        assetType: "glb",
        loadMs: 10,
        missingAssets: []
      };
    }
  });

  assert.equal(result.sceneBundleState, "failed");
  assert.equal(result.sceneDebug.failureReason, "spawn_failed");
  assert.equal(group.parent, null);
  assert.equal(geometryDisposed, true);
  assert.equal(materialDisposed, true);
  assert.deepEqual(renderProfiles, ["neutral-pbr", undefined]);
  assert.deepEqual(cleanModes, [true, false]);
});
