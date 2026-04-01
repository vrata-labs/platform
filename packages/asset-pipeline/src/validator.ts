export interface AssetValidationInput {
  fileName: string;
  sizeMb: number;
  extension: string;
}

export interface AssetValidationResult {
  ok: boolean;
  reasons: string[];
}

export interface AvatarPackValidationPresetInput {
  avatarId: string;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
  morphTargets: string[];
  animationClips: string[];
  skeletonSignature: string;
}

export interface AvatarPackValidationInput {
  rig: string;
  packFormat: string;
  packUrl: string;
  presets: AvatarPackValidationPresetInput[];
}

export interface AvatarPackValidationResult {
  ok: boolean;
  reasons: string[];
}

export const avatarPackBudgets = {
  maxTriangles: 15000,
  maxMaterials: 2,
  maxTextures: 3,
  supportedRig: "humanoid-v1",
  requiredMorphTargets: ["blink", "viseme-aa"],
  requiredAnimationClips: ["idle"]
} as const;

export function validateAsset(input: AssetValidationInput): AssetValidationResult {
  const reasons: string[] = [];

  if (!input.fileName) {
    reasons.push("missing_filename");
  }

  if (!/[.]glb$|[.]gltf$|[.]ktx2$/i.test(input.extension)) {
    reasons.push("unsupported_extension");
  }

  if (input.sizeMb > 40) {
    reasons.push("asset_too_large");
  }

  return {
    ok: reasons.length === 0,
    reasons
  };
}

function hasAllRequiredValues(source: string[], required: readonly string[]): boolean {
  return required.every((item) => source.includes(item));
}

export function validateAvatarPack(input: AvatarPackValidationInput): AvatarPackValidationResult {
  const reasons: string[] = [];

  if (input.rig !== avatarPackBudgets.supportedRig) {
    reasons.push("unsupported_rig");
  }
  if (input.packFormat !== "glb-v1" && input.packFormat !== "procedural-debug-v1") {
    reasons.push("unsupported_pack_format");
  }
  if (!input.packUrl) {
    reasons.push("missing_pack_url");
  }
  if (input.presets.length !== 10) {
    reasons.push("invalid_preset_count");
  }

  const signatures = new Set<string>();
  for (const preset of input.presets) {
    signatures.add(preset.skeletonSignature);
    if (preset.triangleCount > avatarPackBudgets.maxTriangles) {
      reasons.push(`preset_over_triangle_budget:${preset.avatarId}`);
    }
    if (preset.materialCount > avatarPackBudgets.maxMaterials) {
      reasons.push(`preset_over_material_budget:${preset.avatarId}`);
    }
    if (preset.textureCount > avatarPackBudgets.maxTextures) {
      reasons.push(`preset_over_texture_budget:${preset.avatarId}`);
    }
    if (!hasAllRequiredValues(preset.morphTargets, avatarPackBudgets.requiredMorphTargets)) {
      reasons.push(`preset_missing_required_morphs:${preset.avatarId}`);
    }
    if (!hasAllRequiredValues(preset.animationClips, avatarPackBudgets.requiredAnimationClips)) {
      reasons.push(`preset_missing_required_clips:${preset.avatarId}`);
    }
    if (!preset.skeletonSignature || !preset.skeletonSignature.startsWith(`${avatarPackBudgets.supportedRig}/`)) {
      reasons.push(`preset_invalid_skeleton_signature:${preset.avatarId}`);
    }
  }

  if (signatures.size > 1) {
    reasons.push("mismatched_skeleton_signature");
  }

  return {
    ok: reasons.length === 0,
    reasons
  };
}
