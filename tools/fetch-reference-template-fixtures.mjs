import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listProductRoomTemplateVersionContracts, resolveLockedRoomTemplateAssetUrl } from "../packages/templates/dist/index.js";

export async function loadReferenceTemplateFixtures() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)), ".reference-scene-assets");
  const files = new Map();
  for (const definition of listProductRoomTemplateVersionContracts()) {
    const lock = definition.assetLock;
    for (const file of [lock.sceneManifest, lock.sceneAsset, lock.preview]) {
      const path = `${lock.repository}/${lock.commitSha}/${file.path}`;
      let bytes = await readFile(resolve(root, path)).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (!bytes) {
        const url = resolveLockedRoomTemplateAssetUrl(lock, file.path);
        const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
        assert(response.ok, `reference_fixture_http_${response.status}:${file.path}`);
        bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(bytes.length, file.sizeBytes, "reference_fixture_size_mismatch");
        assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, "reference_fixture_hash_mismatch");
        await mkdir(dirname(resolve(root, path)), { recursive: true });
        await writeFile(resolve(root, path), bytes);
      }
      assert.equal(bytes.length, file.sizeBytes, "reference_fixture_cache_size_mismatch");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, "reference_fixture_cache_hash_mismatch");
      files.set(`/${path}`, { bytes, type: file.path.endsWith(".glb") ? "model/gltf-binary" : file.path.endsWith(".webp") ? "image/webp" : "application/json" });
    }
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void loadReferenceTemplateFixtures().then(files => console.log(`Verified ${files.size} pinned public scene fixture files.`)).catch(error => {
    console.error(error); process.exitCode = 1;
  });
}
