import test from "node:test";
import assert from "node:assert/strict";

import { validateAsset, validateAvatarPack } from "./validator.js";

test("validateAsset accepts glb under budget", () => {
  assert.deepEqual(validateAsset({ fileName: "scene.glb", extension: ".glb", sizeMb: 10 }), {
    ok: true,
    reasons: []
  });
});

test("validateAsset rejects oversized unknown asset", () => {
  const result = validateAsset({ fileName: "scene.fbx", extension: ".fbx", sizeMb: 100 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["unsupported_extension", "asset_too_large"]);
});

test("validateAvatarPack accepts technical humanoid pack metadata", () => {
  const result = validateAvatarPack({
    rig: "humanoid-v1",
    packFormat: "procedural-debug-v1",
    packUrl: "/assets/avatars/avatar-pack.v1.glb",
    presets: Array.from({ length: 10 }, (_, index) => ({
      avatarId: `preset-${String(index + 1).padStart(2, "0")}`,
      triangleCount: 12000,
      materialCount: 1,
      textureCount: 1,
      morphTargets: ["blink", "viseme-aa"],
      animationClips: ["idle"],
      skeletonSignature: "humanoid-v1/base"
    }))
  });

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("validateAvatarPack rejects mismatched skeleton signatures", () => {
  const result = validateAvatarPack({
    rig: "humanoid-v1",
    packFormat: "procedural-debug-v1",
    packUrl: "/assets/avatars/avatar-pack.v1.glb",
    presets: Array.from({ length: 10 }, (_, index) => ({
      avatarId: `preset-${String(index + 1).padStart(2, "0")}`,
      triangleCount: 12000,
      materialCount: 1,
      textureCount: 1,
      morphTargets: ["blink", "viseme-aa"],
      animationClips: ["idle"],
      skeletonSignature: index === 9 ? "humanoid-v1/alt" : "humanoid-v1/base"
    }))
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasons.includes("mismatched_skeleton_signature"), true);
});
