import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertSelfContainedGlb, verifySceneBytes } from "./scene-integrity.js";
import { loadSceneBundle } from "./scene-loader.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function glb(value: unknown): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(20+Math.ceil(encoded.length/4)*4);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.length, true);
  header.setUint32(12, bytes.length-20, true); header.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20); bytes.set(encoded, 20);
  return bytes.buffer;
}

test("verified bytes reject corruption and self-contained GLBs reject remote resources", async () => {
  const bytes = new TextEncoder().encode("accepted");
  await verifySceneBytes(bytes.buffer, hash(bytes), "asset");
  await assert.rejects(() => verifySceneBytes(bytes.buffer, "0".repeat(64), "asset"), /scene_asset_checksum_mismatch/);
  await assert.rejects(() => verifySceneBytes(bytes.buffer, "bad", "manifest"), /invalid_scene_integrity/);
  assertSelfContainedGlb(glb({ asset: { version: "2.0" }, images: [{ uri: "data:image/png;base64,AA==" }] }));
  for (const uri of ["external.png", "https://outside.example/texture.png"]) assert.throws(() => assertSelfContainedGlb(glb({ images: [{ uri }] })), /verified_scene_external_resource/);
});

test("loader checks manifest before parsing and asset before glTF decoding", async () => {
  const originalFetch = globalThis.fetch;
  const manifest = JSON.stringify({ schemaVersion: 1, sceneId: "verified", label: "Verified", source: "test", glbPath: "scene.glb", spawnPoints: [{ id: "main", position: { x: 0, y: 0, z: 0 } }] });
  const asset = glb({ asset: { version: "2.0" }, scene: 0, scenes: [{}] });
  const integrity = { manifestSha256: hash(manifest), assetSha256: hash(new Uint8Array(asset)) };
  const requests: string[] = [];
  let corruptManifest = true, corruptAsset = false;
  globalThis.fetch = async input => {
    const url = String(input); requests.push(url);
    const response = new Response(url.endsWith(".json") ? corruptManifest ? "not-json" : manifest : corruptAsset ? "not-glb" : asset);
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  try {
    await assert.rejects(() => loadSceneBundle({ bundleUrl: "https://fixtures.example/scene.json", integrity }), /scene_manifest_checksum_mismatch/);
    assert.equal(requests.length, 1);
    corruptManifest = false; corruptAsset = true;
    await assert.rejects(() => loadSceneBundle({ bundleUrl: "https://fixtures.example/scene.json", integrity }), /scene_asset_checksum_mismatch/);
    corruptAsset = false;
    const stages: string[] = [];
    const result = await loadSceneBundle({ bundleUrl: "https://fixtures.example/scene.json", integrity, onLoadStage: stage => stages.push(stage) });
    assert.equal(result.manifest.sceneId, "verified");
    assert(stages.indexOf("manifest_verified") < stages.indexOf("manifest_loaded"));
    assert(stages.indexOf("asset_verified") < stages.indexOf("asset_parsed"));
  } finally { globalThis.fetch = originalFetch; }
});
