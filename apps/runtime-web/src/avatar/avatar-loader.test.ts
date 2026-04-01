import test from "node:test";
import assert from "node:assert/strict";

import { loadAvatarCatalog } from "./avatar-loader.js";

test("loadAvatarCatalog loads procedural technical assets without pack fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (input) => {
    fetchCount += 1;
    const url = String(input);
    if (url.endsWith("catalog.v1.json")) {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        catalogId: "technical-v1",
        assetVersion: "v1",
        rig: "humanoid-v1",
        packUrl: "/assets/avatars/avatar-pack.v1.glb",
        packFormat: "procedural-debug-v1",
        presets: Array.from({ length: 10 }, (_, index) => ({
          avatarId: `preset-${String(index + 1).padStart(2, "0")}`,
          label: `Preset ${index + 1}`,
          recipeId: `preset-${String(index + 1).padStart(2, "0")}`,
          validation: {
            triangleCount: 12000,
            materialCount: 1,
            textureCount: 1,
            morphTargets: ["blink", "viseme-aa"],
            animationClips: ["idle"],
            skeletonSignature: "humanoid-v1/base"
          }
        }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("avatar-recipes.v1.json")) {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        recipes: Array.from({ length: 10 }, (_, index) => ({
          schemaVersion: 1,
          avatarId: `preset-${String(index + 1).padStart(2, "0")}`,
          rig: "humanoid-v1",
          bodyVariant: "base",
          headVariant: "round",
          hairVariant: "short",
          outfitVariant: "hoodie",
          palette: { skin: "#f2d1b3", primary: "#355c7d", accent: "#f67280" },
          accessories: []
        }))
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const loaded = await loadAvatarCatalog({ catalogUrl: "https://example.com/assets/avatars/catalog.v1.json" });
    assert.equal(loaded.presets.length, 10);
    assert.equal(loaded.diagnostics.packFormat, "procedural-debug-v1");
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
