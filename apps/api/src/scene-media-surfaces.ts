import { parseSceneMediaSurfaceDefinitions, type SceneMediaSurfaceDefinition } from "@vrata/shared-types";

const MAX_MANIFEST_BYTES = 1024 * 1024;

/** capacity is the legacy resolver's pending-fetch bound, not a fetch response. */
export type SceneMediaSurfaceFailure = "unsupported_protocol" | "too_large" | "http" | "timeout" | "parse" | "invalid_surfaces" | "capacity";
/** No bound URL, or a schema-1 manifest without mediaSurfaces, is a successful load of no surfaces. */
export type SceneMediaSurfaceLoad =
  | { readonly kind: "loaded"; readonly surfaces: SceneMediaSurfaceDefinition[] | undefined }
  | { readonly kind: "failed"; readonly reason: SceneMediaSurfaceFailure };

const failed = (reason: SceneMediaSurfaceFailure): SceneMediaSurfaceLoad => ({ kind: "failed", reason });

/** Normalizes a bound scene URL against the local origin; never fetches. */
export function resolveSceneMediaSurfaceUrl(sceneBundleUrl: string, localOrigin: string): URL | SceneMediaSurfaceLoad {
  let url: URL;
  try { url = new URL(sceneBundleUrl, localOrigin); } catch { return failed("unsupported_protocol"); }
  if (!["http:", "https:", "data:"].includes(url.protocol)) return failed("unsupported_protocol");
  if (url.protocol === "data:" && url.href.length > MAX_MANIFEST_BYTES * 2) return failed("too_large");
  return url;
}

/** Bounded read with a 2 s abort, decoded by the shared parser. No credentials are forwarded. */
export async function fetchSceneMediaSurfaces(url: URL, fetchManifest: typeof fetch): Promise<SceneMediaSurfaceLoad> {
  let text: string;
  try {
    const response = await fetchManifest(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok || !response.body) return failed("http");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_MANIFEST_BYTES) { await reader.cancel(); return failed("too_large"); }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
    return failed(name === "TimeoutError" || name === "AbortError" ? "timeout" : "http");
  }
  let manifest: { schemaVersion?: unknown; mediaSurfaces?: unknown } | null;
  try { manifest = JSON.parse(text); } catch { return failed("parse"); }
  if (typeof manifest !== "object" || manifest === null || manifest.schemaVersion !== 1) return failed("parse");
  if (manifest.mediaSurfaces === undefined) return { kind: "loaded", surfaces: undefined };
  try { return { kind: "loaded", surfaces: parseSceneMediaSurfaceDefinitions(manifest.mediaSurfaces) }; }
  catch { return failed("invalid_surfaces"); }
}

// The URL comes from the stored admin-controlled room binding, never from a join
// payload. No credentials are forwarded to the asset host. Failed scene loading
// keeps the legacy room usable; it cannot grant any additional logical surfaces.
export async function loadSceneMediaSurfaces(sceneBundleUrl: string | null | undefined, localOrigin: string, fetchManifest: typeof fetch = fetch): Promise<SceneMediaSurfaceDefinition[] | undefined> {
  if (!sceneBundleUrl) return undefined;
  const url = resolveSceneMediaSurfaceUrl(sceneBundleUrl, localOrigin);
  const result = url instanceof URL ? await fetchSceneMediaSurfaces(url, fetchManifest) : url;
  return result.kind === "loaded" ? result.surfaces : undefined;
}
