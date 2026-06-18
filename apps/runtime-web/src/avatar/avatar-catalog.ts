import type { AvatarCatalogV1, AvatarRecipeCatalogV1, AvatarRecipeV1, LoadedAvatarPreset } from "./avatar-types.js";

function assertObject(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(errorCode);
  }
  return value;
}

function assertStringArray(value: unknown, errorCode: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(errorCode);
  }
  return value;
}

function assertFiniteNumber(value: unknown, errorCode: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(errorCode);
  }
  return value;
}

export function parseAvatarCatalog(input: unknown): AvatarCatalogV1 {
  const payload = assertObject(input, "invalid_avatar_catalog");
  if (payload.schemaVersion !== 1) {
    throw new Error("unsupported_avatar_catalog_schema");
  }
  const presetsRaw = payload.presets;
  if (!Array.isArray(presetsRaw)) {
    throw new Error("invalid_avatar_catalog_presets");
  }
  return {
    schemaVersion: 1,
    catalogId: assertString(payload.catalogId, "invalid_avatar_catalog_id"),
    assetVersion: assertString(payload.assetVersion, "invalid_avatar_catalog_asset_version"),
    rig: payload.rig === "humanoid-v1" ? "humanoid-v1" : (() => { throw new Error("invalid_avatar_catalog_rig"); })(),
    packUrl: assertString(payload.packUrl, "invalid_avatar_catalog_pack_url"),
    packFormat: payload.packFormat === "glb-v1" || payload.packFormat === "procedural-debug-v1"
      ? payload.packFormat
      : (() => { throw new Error("invalid_avatar_catalog_pack_format"); })(),
    presets: presetsRaw.map((entry, index) => {
      const preset = assertObject(entry, `invalid_avatar_preset:${index}`);
      const validation = assertObject(preset.validation, `invalid_avatar_preset_validation:${index}`);
      return {
        avatarId: assertString(preset.avatarId, `invalid_avatar_preset_id:${index}`),
        label: assertString(preset.label, `invalid_avatar_preset_label:${index}`),
        recipeId: assertString(preset.recipeId, `invalid_avatar_preset_recipe_id:${index}`),
        thumbnailUrl: typeof preset.thumbnailUrl === "string" ? preset.thumbnailUrl : undefined,
        validation: {
          triangleCount: assertFiniteNumber(validation.triangleCount, `invalid_avatar_preset_triangles:${index}`),
          materialCount: assertFiniteNumber(validation.materialCount, `invalid_avatar_preset_materials:${index}`),
          textureCount: assertFiniteNumber(validation.textureCount, `invalid_avatar_preset_textures:${index}`),
          morphTargets: assertStringArray(validation.morphTargets, `invalid_avatar_preset_morphs:${index}`),
          animationClips: assertStringArray(validation.animationClips, `invalid_avatar_preset_clips:${index}`),
          skeletonSignature: assertString(validation.skeletonSignature, `invalid_avatar_preset_skeleton:${index}`)
        }
      };
    })
  };
}

export function parseAvatarRecipeCatalog(input: unknown): AvatarRecipeCatalogV1 {
  const payload = assertObject(input, "invalid_avatar_recipe_catalog");
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.recipes)) {
    throw new Error("unsupported_avatar_recipe_schema");
  }
  return {
    schemaVersion: 1,
    recipes: payload.recipes.map((entry, index) => {
      const recipe = assertObject(entry, `invalid_avatar_recipe:${index}`);
      const palette = assertObject(recipe.palette, `invalid_avatar_recipe_palette:${index}`);
      return {
        schemaVersion: recipe.schemaVersion === 1 ? 1 : (() => { throw new Error(`invalid_avatar_recipe_version:${index}`); })(),
        avatarId: assertString(recipe.avatarId, `invalid_avatar_recipe_id:${index}`),
        rig: recipe.rig === "humanoid-v1" ? "humanoid-v1" : (() => { throw new Error(`invalid_avatar_recipe_rig:${index}`); })(),
        bodyVariant: assertString(recipe.bodyVariant, `invalid_avatar_recipe_body:${index}`),
        headVariant: assertString(recipe.headVariant, `invalid_avatar_recipe_head:${index}`),
        hairVariant: assertString(recipe.hairVariant, `invalid_avatar_recipe_hair:${index}`),
        outfitVariant: assertString(recipe.outfitVariant, `invalid_avatar_recipe_outfit:${index}`),
        palette: {
          skin: assertString(palette.skin, `invalid_avatar_recipe_skin:${index}`),
          primary: assertString(palette.primary, `invalid_avatar_recipe_primary:${index}`),
          accent: assertString(palette.accent, `invalid_avatar_recipe_accent:${index}`)
        },
        accessories: assertStringArray(recipe.accessories, `invalid_avatar_recipe_accessories:${index}`)
      } satisfies AvatarRecipeV1;
    })
  };
}

export function mergeAvatarCatalogWithRecipes(catalog: AvatarCatalogV1, recipes: AvatarRecipeCatalogV1): LoadedAvatarPreset[] {
  const recipesById = new Map<string, AvatarRecipeV1>(recipes.recipes.map((recipe) => [recipe.avatarId, recipe]));
  return catalog.presets.map((preset) => {
    const recipe = recipesById.get(preset.recipeId);
    if (!recipe) {
      throw new Error(`missing_avatar_recipe:${preset.recipeId}`);
    }
    if (recipe.rig !== catalog.rig) {
      throw new Error(`avatar_rig_mismatch:${preset.avatarId}`);
    }
    return { preset, recipe };
  });
}
