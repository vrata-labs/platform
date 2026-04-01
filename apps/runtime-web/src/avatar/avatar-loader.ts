import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { configureGltfLoader } from "../scene-loader.js";
import { createEmptyAvatarDiagnostics, type AvatarDiagnostics } from "./avatar-debug.js";
import { mergeAvatarCatalogWithRecipes, parseAvatarCatalog, parseAvatarRecipeCatalog } from "./avatar-catalog.js";
import type { AvatarCatalogV1, AvatarRecipeCatalogV1, LoadedAvatarPreset } from "./avatar-types.js";

export interface LoadedAvatarCatalog {
  catalog: AvatarCatalogV1;
  recipes: AvatarRecipeCatalogV1;
  presets: LoadedAvatarPreset[];
  diagnostics: AvatarDiagnostics;
}

export async function loadAvatarCatalog(input: {
  catalogUrl: string;
  renderer?: THREE.WebGLRenderer;
}): Promise<LoadedAvatarCatalog> {
  const diagnostics = createEmptyAvatarDiagnostics();
  diagnostics.state = "loading";
  diagnostics.sandboxEntryPoint = input.catalogUrl;

  const catalogResponse = await fetch(input.catalogUrl);
  if (!catalogResponse.ok) {
    throw new Error(`failed_to_load_avatar_catalog:${catalogResponse.status}`);
  }
  const catalog = parseAvatarCatalog(await catalogResponse.json());
  const recipesResponse = await fetch(new URL("avatar-recipes.v1.json", catalogResponse.url));
  if (!recipesResponse.ok) {
    throw new Error(`failed_to_load_avatar_recipes:${recipesResponse.status}`);
  }
  const recipes = parseAvatarRecipeCatalog(await recipesResponse.json());
  const presets = mergeAvatarCatalogWithRecipes(catalog, recipes);

  if (catalog.packFormat === "glb-v1") {
    const loader = configureGltfLoader(new GLTFLoader(), { renderer: input.renderer });
    await loader.loadAsync(catalog.packUrl);
  }

  diagnostics.state = "loaded";
  diagnostics.catalogId = catalog.catalogId;
  diagnostics.packUrl = catalog.packUrl;
  diagnostics.packFormat = catalog.packFormat;
  diagnostics.presetCount = presets.length;
  diagnostics.validatorSummary = presets.map((preset) => `${preset.preset.avatarId}:${preset.preset.validation.triangleCount}`);

  return {
    catalog,
    recipes,
    presets,
    diagnostics
  };
}
