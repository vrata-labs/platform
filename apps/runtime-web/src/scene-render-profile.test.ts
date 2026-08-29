import test from "node:test";
import assert from "node:assert/strict";

import { resolveSceneRenderSettings } from "./scene-render-profile.js";

test("legacy lighting preserves default and clean scene behavior", () => {
  assert.deepEqual(resolveSceneRenderSettings(undefined, false), {
    ambientVisible: false,
    hemisphereVisible: true,
    directionalVisible: true,
    toneMapping: "none",
    toneMappingExposure: 1
  });
  assert.deepEqual(resolveSceneRenderSettings(undefined, true), {
    ambientVisible: true,
    hemisphereVisible: true,
    directionalVisible: false,
    toneMapping: "none",
    toneMappingExposure: 1
  });
});

test("neutral PBR lighting replaces legacy lights in default and clean scenes", () => {
  const expected = {
    ambientVisible: true,
    hemisphereVisible: true,
    directionalVisible: true,
    toneMapping: "agx",
    toneMappingExposure: 1.2
  };
  assert.deepEqual(resolveSceneRenderSettings("neutral-pbr", false), expected);
  assert.deepEqual(resolveSceneRenderSettings("neutral-pbr", true), expected);
});
