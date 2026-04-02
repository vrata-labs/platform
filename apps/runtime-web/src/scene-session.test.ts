import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createEmptySceneDiagnostics } from "./scene-debug.js";
import { startSceneBundleSession } from "./scene-session.js";

test("startSceneBundleSession reports failure result for missing bundle", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("missing", { status: 404 });

  let fallbackVisible = false;
  try {
    const result = await startSceneBundleSession({
      scene: new THREE.Scene(),
      player: new THREE.Group(),
      camera: new THREE.PerspectiveCamera(),
      bundleUrl: "https://example.com/scene.json",
      requestedCleanSceneMode: false,
      sceneFitEnabled: false,
      previousSceneDebug: createEmptySceneDiagnostics(),
      applySceneMaterialDebugMode() {},
      applyCleanSceneMode() {},
      applySceneDebugFit() {},
      setFallbackEnvironmentVisible(visible) {
        fallbackVisible = visible;
      }
    });

    assert.equal(result.sceneBundleState, "failed");
    assert.equal(result.note, "scene_bundle_failed");
    assert.equal(fallbackVisible, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
