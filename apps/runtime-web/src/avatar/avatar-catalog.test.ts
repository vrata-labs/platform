import test from "node:test";
import assert from "node:assert/strict";

import { mergeAvatarCatalogWithRecipes, parseAvatarCatalog, parseAvatarRecipeCatalog } from "./avatar-catalog.js";

test("parseAvatarCatalog reads technical catalog", () => {
  const catalog = parseAvatarCatalog({
    schemaVersion: 1,
    catalogId: "technical-v1",
    assetVersion: "v1",
    rig: "humanoid-v1",
    packUrl: "/assets/avatars/avatar-pack.v1.glb",
    packFormat: "procedural-debug-v1",
    presets: [{
      avatarId: "preset-01",
      label: "Preset 01",
      recipeId: "preset-01",
      validation: {
        triangleCount: 12000,
        materialCount: 1,
        textureCount: 1,
        morphTargets: ["blink", "viseme-aa"],
        animationClips: ["idle"],
        skeletonSignature: "humanoid-v1/base"
      }
    }]
  });

  assert.equal(catalog.packFormat, "procedural-debug-v1");
});

test("mergeAvatarCatalogWithRecipes rejects missing recipes", () => {
  const catalog = parseAvatarCatalog({
    schemaVersion: 1,
    catalogId: "technical-v1",
    assetVersion: "v1",
    rig: "humanoid-v1",
    packUrl: "/assets/avatars/avatar-pack.v1.glb",
    packFormat: "procedural-debug-v1",
    presets: [{
      avatarId: "preset-01",
      label: "Preset 01",
      recipeId: "preset-01",
      validation: {
        triangleCount: 12000,
        materialCount: 1,
        textureCount: 1,
        morphTargets: ["blink", "viseme-aa"],
        animationClips: ["idle"],
        skeletonSignature: "humanoid-v1/base"
      }
    }]
  });
  const recipes = parseAvatarRecipeCatalog({ schemaVersion: 1, recipes: [] });

  assert.throws(() => mergeAvatarCatalogWithRecipes(catalog, recipes), /missing_avatar_recipe/);
});
