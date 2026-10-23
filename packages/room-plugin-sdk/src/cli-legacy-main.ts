import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeRoomPluginFile, readRoomPluginFile, RoomPluginCliError } from "./cli-io.js";
import { roomPluginSourcePath } from "./cli-root.js";

/** Only bare-root require of legacy dual main/module packages. Exports and subpaths
 * stay with esbuild's resolver; this is not a replacement Node package resolver.
 */
export function createLegacyRequireMainSelector(root: string): (target: { packageName: string; directory: string } | undefined, specifier: string, kind: string) => Promise<string | undefined> {
  const packages = new Map<string, Promise<string | undefined>>();
  return async (target, specifier, kind) => {
    if (kind !== "require-call" || !target || specifier !== target.packageName) return undefined;
    let cached = packages.get(target.directory);
    if (!cached) {
      // Bound metadata materialization as well as the source graph.
      if (packages.size >= 128) throw new RoomPluginCliError("source_graph_too_large", 3);
      cached = (async () => {
        const path = join(target.directory, "package.json");
        try { await lstat(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw new RoomPluginCliError("io_error", 4);
        }
        const manifest = await roomPluginSourcePath(root, path);
        const bytes = await readRoomPluginFile(manifest, 32 * 1024, "package_manifest_too_large");
        let metadata: unknown;
        try { metadata = JSON.parse(decodeRoomPluginFile(bytes)); }
        catch (error) {
          if (error instanceof RoomPluginCliError) throw error;
          throw new RoomPluginCliError("bundle_failed", 5);
        }
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
        const fields = metadata as Record<string, unknown>;
        if (Object.hasOwn(fields, "exports") && fields.exports !== null) return undefined;
        if (!Object.hasOwn(fields, "main") || !Object.hasOwn(fields, "module") ||
          typeof fields.main !== "string" || !fields.main || typeof fields.module !== "string" || !fields.module) return undefined;
        return resolve(target.directory, fields.main);
      })();
      packages.set(target.directory, cached);
    }
    return cached;
  };
}
