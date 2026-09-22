export async function verifySceneBytes(bytes: ArrayBuffer, expectedSha256: string, kind: "manifest" | "asset"): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("invalid_scene_integrity");
  if (!globalThis.crypto?.subtle) throw new Error("scene_integrity_crypto_unavailable");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  if (actual !== expectedSha256) throw new Error(`scene_${kind}_checksum_mismatch`);
}

export function assertSelfContainedGlb(bytes: ArrayBuffer): void {
  const data = new DataView(bytes);
  if (bytes.byteLength < 20 || data.getUint32(0, true) !== 0x46546c67 || data.getUint32(4, true) !== 2
    || data.getUint32(8, true) !== bytes.byteLength || data.getUint32(16, true) !== 0x4e4f534a) throw new Error("verified_scene_requires_glb");
  const length = data.getUint32(12, true);
  if (length > bytes.byteLength-20) throw new Error("invalid_verified_scene_glb");
  const json = JSON.parse(new TextDecoder().decode(bytes.slice(20, 20+length)));
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (item.uri !== undefined && (typeof item.uri !== "string" || !item.uri.startsWith("data:"))) throw new Error("verified_scene_external_resource");
  }
}
