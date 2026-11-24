import { isSceneAudioPath, type SceneAudioPath } from "@vrata/shared-types";

export type PrivateSceneFileFetch = (file: "scene.json" | "scene.glb" | SceneAudioPath, signal?: AbortSignal) => Promise<Response>;
interface Descriptor {
  roomId: string;
  bundleVersionId: string;
  contentHash: string;
  purpose: string;
  baseUrl: string;
  manifestUrl: string;
  issuedAt: string;
  expiresAt: string;
  refreshAfter: string;
}

type CachedDescriptor = { baseUrl: string; refreshAt: number };

/** Credentials go only to the same-origin API. The separate asset origin receives a short-lived view capability,
 * never the room session or cookies. Only non-secret errors/paths leave this closure. */
export function privateSceneSource(
  endpoint: string,
  roomId: string,
  binding: { bundleVersionId: string; contentHash: string },
  session: () => string,
  apiFetch: typeof fetch = fetch,
  assetFetch: typeof fetch = fetch
): PrivateSceneFileFetch {
  let current: CachedDescriptor | undefined, pending: Promise<CachedDescriptor> | undefined;
  async function refresh(): Promise<CachedDescriptor> {
    const token = session();
    if (!token) throw new Error("private_scene_session_required");
    const requestedAt = performance.now();
    const r = await apiFetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    if (!r.ok) throw new Error(`private_scene_descriptor:${r.status}`);
    const d = (await r.json()) as Descriptor;
    const base = new URL(d.baseUrl);
    const local = base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname);
    const issued = Date.parse(d.issuedAt),
      expires = Date.parse(d.expiresAt),
      renew = Date.parse(d.refreshAfter);
    if (
      d.purpose !== "view" ||
      d.roomId !== roomId ||
      d.bundleVersionId !== binding.bundleVersionId ||
      d.contentHash !== binding.contentHash ||
      (base.protocol !== "https:" && !local) ||
      base.origin === new URL(endpoint).origin ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !/^\/c\/[A-Za-z0-9_-]{43,2048}\/$/.test(base.pathname) ||
      d.manifestUrl !== `${base.href}scene.json` ||
      !Number.isFinite(issued) ||
      !Number.isFinite(expires) ||
      !Number.isFinite(renew) ||
      expires <= issued ||
      renew < issued ||
      renew > expires
    )
      throw new Error("private_scene_descriptor_invalid");
    // Use elapsed time, not the device clock. Counting request latency can only refresh early;
    // whether the capability is actually expired is decided by the asset server.
    return (current = { baseUrl: d.baseUrl, refreshAt: requestedAt + (renew - issued) });
  }
  function descriptor() {
    return current && current.refreshAt > performance.now()
      ? Promise.resolve(current)
      : (pending ??= refresh().finally(() => {
          pending = undefined;
        }));
  }
  return async (file, signal) => {
    if (file !== "scene.json" && file !== "scene.glb" && !isSceneAudioPath(file)) throw new Error("invalid_private_scene_path");
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const d = await descriptor();
      let r: Response;
      try {
        r = await assetFetch(d.baseUrl + file, {
          mode: "cors",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal
        });
      } catch {
        throw new Error("private_scene_asset_unreachable");
      }
      if (r.status !== 403 || attempt === 1) return r;
      await r.body?.cancel();
      if (current === d) current = undefined;
    }
    throw new Error("private_scene_asset_unavailable");
  };
}
