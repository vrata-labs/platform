import { readFile } from "node:fs/promises";

import { validateAsset, validateAvatarPack } from "./validator.js";

interface CliArgs {
  fileName: string;
  extension: string;
  sizeMb: number;
  avatarCatalogPath?: string;
  avatarRecipesPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index] ?? "", argv[index + 1] ?? "");
  }

  const fileName = values.get("--file") ?? "";
  const extension = values.get("--ext") ?? "";
  const sizeMb = Number.parseFloat(values.get("--size-mb") ?? "0");
  const avatarCatalogPath = values.get("--avatar-catalog");
  const avatarRecipesPath = values.get("--avatar-recipes");

  return { fileName, extension, sizeMb, avatarCatalogPath, avatarRecipesPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.avatarCatalogPath && args.avatarRecipesPath) {
    const catalog = JSON.parse(await readFile(args.avatarCatalogPath, "utf8")) as {
      rig?: string;
      packFormat?: string;
      packUrl?: string;
      presets?: Array<{
        avatarId?: string;
        validation?: {
          triangleCount?: number;
          materialCount?: number;
          textureCount?: number;
          morphTargets?: string[];
          animationClips?: string[];
          skeletonSignature?: string;
        };
      }>;
    };
    const recipes = JSON.parse(await readFile(args.avatarRecipesPath, "utf8")) as { recipes?: Array<{ avatarId?: string }> };
    const result = validateAvatarPack({
      rig: catalog.rig ?? "",
      packFormat: catalog.packFormat ?? "",
      packUrl: catalog.packUrl ?? "",
      presets: (catalog.presets ?? []).map((preset) => ({
        avatarId: preset.avatarId ?? "",
        triangleCount: preset.validation?.triangleCount ?? Number.POSITIVE_INFINITY,
        materialCount: preset.validation?.materialCount ?? Number.POSITIVE_INFINITY,
        textureCount: preset.validation?.textureCount ?? Number.POSITIVE_INFINITY,
        morphTargets: preset.validation?.morphTargets ?? [],
        animationClips: preset.validation?.animationClips ?? [],
        skeletonSignature: preset.validation?.skeletonSignature ?? ""
      }))
    });
    const recipeIds = new Set((recipes.recipes ?? []).map((recipe) => recipe.avatarId ?? ""));
    for (const preset of catalog.presets ?? []) {
      if (!recipeIds.has(preset.avatarId ?? "")) {
        result.ok = false;
        result.reasons.push(`missing_recipe:${preset.avatarId ?? "unknown"}`);
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const result = validateAsset(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

void main();
