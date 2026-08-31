import test from "node:test";
import assert from "node:assert/strict";

import { resolveSceneRenderSettings } from "./scene-render-profile.js";

test("legacy lighting preserves default and clean scene behavior", () => {
  assert.deepEqual(resolveSceneRenderSettings(undefined, false), {
    ambientVisible: false,
    ambientIntensity: 1,
    hemisphereVisible: true,
    hemisphereIntensity: 1.4,
    directionalVisible: true,
    directionalIntensity: 1.4,
    environment: "none",
    environmentIntensity: 1,
    toneMapping: "none",
    toneMappingExposure: 1
  });
  assert.deepEqual(resolveSceneRenderSettings(undefined, true), {
    ambientVisible: true,
    ambientIntensity: 1,
    hemisphereVisible: true,
    hemisphereIntensity: 1.4,
    directionalVisible: false,
    directionalIntensity: 1.4,
    environment: "none",
    environmentIntensity: 1,
    toneMapping: "none",
    toneMappingExposure: 1
  });
});

test("neutral PBR lighting replaces legacy lights in default and clean scenes", () => {
  const expected = {
    ambientVisible: true,
    ambientIntensity: 1,
    hemisphereVisible: true,
    hemisphereIntensity: 1.4,
    directionalVisible: true,
    directionalIntensity: 1.4,
    environment: "none",
    environmentIntensity: 1,
    toneMapping: "agx",
    toneMappingExposure: 1.2
  };
  assert.deepEqual(resolveSceneRenderSettings("neutral-pbr", false), expected);
  assert.deepEqual(resolveSceneRenderSettings("neutral-pbr", true), expected);
});

test("baked PBR keeps low-cost live lighting for dynamic room objects", () => {
  const expected = {
    ambientVisible: true,
    ambientIntensity: 0.05,
    hemisphereVisible: true,
    hemisphereIntensity: 0.2,
    directionalVisible: true,
    directionalIntensity: 0.25,
    environment: "room",
    environmentIntensity: 0.35,
    toneMapping: "agx",
    toneMappingExposure: 1.2
  };
  assert.deepEqual(resolveSceneRenderSettings("baked-pbr-v1", false), expected);
  assert.deepEqual(resolveSceneRenderSettings("baked-pbr-v1", true), expected);
});
