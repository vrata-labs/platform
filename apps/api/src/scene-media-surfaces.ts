import { parseSceneMediaSurfaceDefinitions, type SceneMediaSurfaceDefinition } from "@vrata/shared-types";

const MAX_MANIFEST_BYTES = 1024 * 1024;

// The URL comes from the stored admin-controlled room binding, never from a join
// payload. No credentials are forwarded to the asset host. Failed scene loading
// keeps the legacy room usable; it cannot grant any additional logical surfaces.
export async function loadSceneMediaSurfaces(sceneBundleUrl: string | null | undefined, localOrigin: string, fetchManifest: typeof fetch = fetch): Promise<SceneMediaSurfaceDefinition[] | undefined> {
  if (!sceneBundleUrl) return undefined;
  try {
    const url = new URL(sceneBundleUrl, localOrigin);
    if (!["http:", "https:", "data:"].includes(url.protocol)) return undefined;
    if (url.protocol === "data:" && url.href.length > MAX_MANIFEST_BYTES * 2) return undefined;
    const response = await fetchManifest(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok || !response.body) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_MANIFEST_BYTES) { await reader.cancel(); return undefined; }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (manifest.schemaVersion !== 1 || manifest.mediaSurfaces === undefined) return undefined;
    return parseSceneMediaSurfaceDefinitions(manifest.mediaSurfaces);
  } catch {
    return undefined;
  }
}
