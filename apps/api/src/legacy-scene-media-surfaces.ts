import { createHash } from "node:crypto";
import type { SceneMediaSurfaceDefinition } from "@vrata/shared-types";
import { fetchSceneMediaSurfaces, resolveSceneMediaSurfaceUrl, type SceneMediaSurfaceLoad } from "./scene-media-surfaces.js";

const TTL_MS = 5_000;
const MAX_ENTRIES = 128;
const MAX_INFLIGHT = 128;

type Frozen = readonly Readonly<{ surfaceId: string; label: string; allowedObjectTypes: readonly string[] }>[];
type Settled = { kind: "loaded"; surfaces: Frozen | undefined } | Extract<SceneMediaSurfaceLoad, { kind: "failed" }>;

export interface LegacySceneMediaSurfaceResolver {
  /** Successes are shared for a short TTL; a failure is never cached and never serves an expired success. */
  resolve(sceneBundleUrl: string | null, localOrigin: string): Promise<SceneMediaSurfaceLoad>;
}

const freeze = (surfaces: SceneMediaSurfaceDefinition[] | undefined): Frozen | undefined => surfaces && Object.freeze(surfaces.map(item =>
  Object.freeze({ surfaceId: item.surfaceId, label: item.label, allowedObjectTypes: Object.freeze([...item.allowedObjectTypes]) })));
const thaw = (surfaces: Frozen | undefined): SceneMediaSurfaceDefinition[] | undefined =>
  surfaces?.map(item => ({ surfaceId: item.surfaceId, label: item.label, allowedObjectTypes: [...item.allowedObjectTypes] }));

/** Floor-1 POST/GET surface preparation, always awaited before the credential fence. Keys are a digest of the
 * normalized absolute URL, so no URL (or multi-MiB data URL) is retained; nothing is logged or counted. */
export function createLegacySceneMediaSurfaceResolver(options: { fetchManifest?: typeof fetch; now?: () => number } = {}): LegacySceneMediaSurfaceResolver {
  const fetchManifest = options.fetchManifest ?? fetch;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, { storedAt: number; surfaces: Frozen | undefined }>();
  const inflight = new Map<string, Promise<Settled>>();
  function load(key: string, url: URL): Promise<Settled> {
    // The preceding lookup and this check/set are one turn; duplicate keys coalesce.
    if (inflight.size >= MAX_INFLIGHT) return Promise.resolve<Settled>({ kind: "failed", reason: "capacity" });
    const pending = fetchSceneMediaSurfaces(url, fetchManifest).then((result): Settled => {
      if (result.kind === "failed") return result;
      const surfaces = freeze(result.surfaces);
      entries.set(key, { storedAt: now(), surfaces });
      // Map order is insertion order: the oldest entry is evicted first.
      for (const oldest of entries.keys()) { if (entries.size <= MAX_ENTRIES) break; entries.delete(oldest); }
      return { kind: "loaded", surfaces };
    }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }
  return {
    async resolve(sceneBundleUrl, localOrigin) {
      if (!sceneBundleUrl) return { kind: "loaded", surfaces: undefined };
      const url = resolveSceneMediaSurfaceUrl(sceneBundleUrl, localOrigin);
      if (!(url instanceof URL)) return url;
      const key = createHash("sha256").update(url.href).digest("base64url");
      const at = now(), entry = entries.get(key);
      if (entry && at >= entry.storedAt && at - entry.storedAt < TTL_MS) return { kind: "loaded", surfaces: thaw(entry.surfaces) };
      // An expired entry, or one stamped ahead of a clock step back, is dropped before any refetch.
      entries.delete(key);
      const settled = await (inflight.get(key) ?? load(key, url));
      return settled.kind === "loaded" ? { kind: "loaded", surfaces: thaw(settled.surfaces) } : settled;
    }
  };
}

/** The one production instance shared by legacy POST /api/tokens/state and GET session-control. */
export const legacySceneMediaSurfaces = createLegacySceneMediaSurfaceResolver();
