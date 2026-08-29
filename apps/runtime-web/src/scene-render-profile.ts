import type { SceneBundleRenderProfile } from "./scene-bundle.js";

export interface SceneRenderSettings {
  ambientVisible: boolean;
  hemisphereVisible: boolean;
  directionalVisible: boolean;
  toneMapping: "agx" | "none";
  toneMappingExposure: number;
}

export function resolveSceneRenderSettings(
  profile: SceneBundleRenderProfile | undefined,
  cleanSceneMode: boolean
): SceneRenderSettings {
  const pbrEnabled = profile === "neutral-pbr";
  return {
    ambientVisible: cleanSceneMode || pbrEnabled,
    hemisphereVisible: true,
    directionalVisible: !cleanSceneMode || pbrEnabled,
    toneMapping: pbrEnabled ? "agx" : "none",
    toneMappingExposure: pbrEnabled ? 1.2 : 1
  };
}
