import type { AssetRecord, Storage } from "./storage-contracts.js";

export async function validateRoomAssetIds(
  storage: Storage,
  assetIds: string[] | undefined,
  templateId?: string,
  templateVersion?: string
): Promise<string | null> {
  if (!assetIds || assetIds.length === 0) {
    return null;
  }
  const assets = await storage.listAssets();
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  const template = templateId ? await storage.getTemplateVersion(templateId, templateVersion) : null;
  for (const assetId of assetIds) {
    const asset = byId.get(assetId);
    if (!asset) {
      return "invalid_asset_reference";
    }
    if (asset.validationStatus === "rejected") {
      return "rejected_asset_not_attachable";
    }
    if (template && !template.assetSlots.includes(asset.kind)) {
      return "asset_kind_not_supported_by_template";
    }
  }
  return null;
}

export function validateAssetInput(input: Partial<AssetRecord>): string | null {
  if (!input.url) {
    return "invalid_asset_url";
  }

  const fileName = input.url.split("/").pop() ?? "";
  const extensionMatch = fileName.match(/(\.[a-z0-9]+)$/i);
  const extension = extensionMatch?.[1] ?? "";
  if (!fileName) {
    return "missing_filename";
  }
  if (!/[.]glb$|[.]gltf$|[.]ktx2$/i.test(extension)) {
    return "unsupported_extension";
  }

  return null;
}
