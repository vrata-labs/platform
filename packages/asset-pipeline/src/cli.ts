import { readFile } from "node:fs/promises";

import { validateSceneBundlePath, type SceneBundleValidationResult } from "./scene-bundle-validator.js";
import { validateAsset, validateAvatarPack } from "./validator.js";

interface CliArgs {
  command: "asset" | "avatar" | "scene";
  fileName: string;
  extension: string;
  sizeMb: number;
  avatarCatalogPath?: string;
  avatarRecipesPath?: string;
  sceneBundlePath?: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv[0] === "scenes" && argv[1] === "validate") {
    const json = argv.includes("--json");
    const sceneBundlePath = argv.slice(2).find((arg) => !arg.startsWith("--"));
    return { command: "scene", fileName: "", extension: "", sizeMb: 0, sceneBundlePath, json };
  }

  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index] ?? "", argv[index + 1] ?? "");
  }

  const fileName = values.get("--file") ?? "";
  const extension = values.get("--ext") ?? "";
  const sizeMb = Number.parseFloat(values.get("--size-mb") ?? "0");
  const avatarCatalogPath = values.get("--avatar-catalog");
  const avatarRecipesPath = values.get("--avatar-recipes");
  const command = avatarCatalogPath && avatarRecipesPath ? "avatar" : "asset";

  return { command, fileName, extension, sizeMb, avatarCatalogPath, avatarRecipesPath, json: true };
}

function writeSceneValidationResult(result: SceneBundleValidationResult, jsonOutput: boolean): void {
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stdout.write(`${result.ok ? "Scene bundle valid" : "Scene bundle invalid"}: ${result.inputPath}\n`);
  for (const issue of result.issues) {
    process.stdout.write(`- ${issue.severity.toUpperCase()} ${issue.code} ${issue.path}: ${issue.message}\n`);
  }
  process.stdout.write(`Files: ${result.stats.fileCount}; bundle bytes: ${result.stats.bundleBytes}`);
  if (result.stats.mainAssetBytes !== undefined) {
    process.stdout.write(`; main asset bytes: ${result.stats.mainAssetBytes}`);
  }
  process.stdout.write("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "scene") {
    if (!args.sceneBundlePath) {
      process.stderr.write("Usage: vrata scenes validate <scene-bundle-dir|scene.json|bundle.zip> [--json]\n");
      process.exitCode = 2;
      return;
    }
    const result = await validateSceneBundlePath(args.sceneBundlePath);
    writeSceneValidationResult(result, args.json);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

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
