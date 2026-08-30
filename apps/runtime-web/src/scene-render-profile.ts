import type { SceneBundleRenderProfile } from "./scene-bundle.js";

export interface SceneRenderSettings {
  ambientVisible: boolean;
  ambientIntensity: number;
  hemisphereVisible: boolean;
  hemisphereIntensity: number;
  directionalVisible: boolean;
  directionalIntensity: number;
  environment: "none" | "room";
  environmentIntensity: number;
  toneMapping: "agx" | "none";
  toneMappingExposure: number;
}

export function resolveSceneRenderSettings(
  profile: SceneBundleRenderProfile | undefined,
  cleanSceneMode: boolean
): SceneRenderSettings {
  const neutralPbr = profile === "neutral-pbr";
  const bakedPbr = profile === "baked-pbr-v1";
  return {
    ambientVisible: cleanSceneMode || neutralPbr || bakedPbr,
    ambientIntensity: bakedPbr ? 0.05 : 1,
    hemisphereVisible: true,
    hemisphereIntensity: bakedPbr ? 0.2 : 1.4,
    directionalVisible: !cleanSceneMode || neutralPbr || bakedPbr,
    directionalIntensity: bakedPbr ? 0.25 : 1.4,
    environment: bakedPbr ? "room" : "none",
    environmentIntensity: bakedPbr ? 0.35 : 1,
    toneMapping: neutralPbr || bakedPbr ? "agx" : "none",
    toneMappingExposure: neutralPbr || bakedPbr ? 1.2 : 1
  };
}
