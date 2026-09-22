import { createHash } from "node:crypto";
import { listProductRoomTemplateVersionContracts, resolveLockedRoomTemplateAssetUrl } from "@vrata/templates";
import { templateAssetOptions } from "./room-template-policy.js";

export async function preflightReferenceTemplateAssets(fetcher: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env) {
  const files: Array<{ templateId: string; path: string; sha256: string; sizeBytes: number }> = [];
  for (const definition of listProductRoomTemplateVersionContracts()) {
    const lock = definition.assetLock;
    for (const file of [lock.releaseManifest, lock.sceneManifest, lock.sceneAsset, lock.preview]) {
      const url = resolveLockedRoomTemplateAssetUrl(lock, file.path, templateAssetOptions(env));
      const response = await fetcher(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.body) throw new Error(`reference_asset_unavailable:${definition.templateId}:${response.status}`);
      const reader = response.body.getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > file.sizeBytes) { await reader.cancel(); throw new Error(`reference_asset_size_mismatch:${definition.templateId}`); }
          hash.update(chunk.value);
        }
      } finally { reader.releaseLock(); }
      if (bytes !== file.sizeBytes || hash.digest("hex") !== file.sha256) throw new Error(`reference_asset_checksum_mismatch:${definition.templateId}`);
      files.push({ templateId: definition.templateId, path: file.path, sha256: file.sha256, sizeBytes: bytes });
    }
  }
  return { verified: true, files };
}
