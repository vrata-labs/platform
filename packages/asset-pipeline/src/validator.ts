export interface AssetValidationInput {
  fileName: string;
  sizeMb: number;
  extension: string;
}

export interface AssetValidationResult {
  ok: boolean;
  reasons: string[];
}

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
