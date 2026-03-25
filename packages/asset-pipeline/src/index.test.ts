import test from "node:test";
import assert from "node:assert/strict";

import { validateAsset } from "./validator.js";

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
