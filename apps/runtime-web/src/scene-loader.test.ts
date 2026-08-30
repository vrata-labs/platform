import test from "node:test";
import assert from "node:assert/strict";

import { loadSceneBundle } from "./scene-loader.js";

test("rejects legacy FBX assets for the baked PBR profile", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const response = new Response(JSON.stringify({
      schemaVersion: 1,
      sceneId: "baked-fbx",
      label: "Baked FBX",
      source: "runtime-test",
      glbPath: "scene.fbx",
      renderProfile: "baked-pbr-v1",
      spawnPoints: [{ id: "main", position: { x: 0, y: 0, z: 0 } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    Object.defineProperty(response, "url", { value: "https://example.com/scene.json" });
    return response;
  };

  try {
    await assert.rejects(
      loadSceneBundle({ bundleUrl: "https://example.com/scene.json" }),
      /unsupported_baked_pbr_asset:fbx/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
