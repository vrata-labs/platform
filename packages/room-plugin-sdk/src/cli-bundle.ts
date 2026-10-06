import { dirname, extname } from "node:path";
import { build, type Loader, version } from "esbuild";
import { ROOM_PLUGIN_LIMITS } from "./contracts.js";
import { validateRoomPluginModule } from "./artifact.js";
import { roomPluginUtf8ByteLength } from "./data.js";
import { RoomPluginValidationError } from "./errors.js";
import { decodeRoomPluginFile, readRoomPluginFile, RoomPluginCliError } from "./cli-io.js";
import { checkRoomPluginImport, roomPluginProjectRoot, roomPluginSourcePath } from "./cli-root.js";
import { createLegacyRequireMainSelector } from "./cli-legacy-main.js";

const loaders: Readonly<Record<string, Loader>> = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".ts": "ts", ".mts": "ts", ".cts": "ts", ".json": "json"
};
const graphMaximumBytes = 8 * 1024 * 1024;
const graphMaximumFiles = 128;

/** Fixed local compiler policy; no author plugins, lifecycle scripts, config execution or fetch. */
export async function bundleRoomPluginFile(path: string, explicitRoot?: string): Promise<Uint8Array> {
  if (version !== "0.25.12") throw new RoomPluginCliError("bundler_version_mismatch", 5);
  const root = await roomPluginProjectRoot(explicitRoot);
  const source = await roomPluginSourcePath(root, path);
  const input = await readRoomPluginFile(source, ROOM_PLUGIN_LIMITS.artifactBytes, "entry_too_large");
  const loader = loaders[extname(source).toLowerCase()];
  if (!loader || loader === "json") throw new RoomPluginCliError("unsupported_entry_type", 3);
  let sourceBytes = input.byteLength;
  let inputError: unknown;
  const legacyRequireMain = createLegacyRequireMainSelector(root);
  type LoadedSource = { contents: string; loader: Loader };
  const sources = new Map<string, Promise<LoadedSource>>([
    [source, Promise.resolve({ contents: decodeRoomPluginFile(input), loader })]
  ]);
  let reads: Promise<void> = Promise.resolve();
  function loadSource(path: string, sourceLoader: Loader): Promise<LoadedSource> {
    const cached = sources.get(path);
    if (cached) return cached;
    // Charge distinct canonical modules before any new file allocation/read.
    if (sources.size >= graphMaximumFiles) throw new RoomPluginCliError("source_graph_too_large", 3);
    const loaded = reads.then(async () => {
      if (inputError) throw inputError;
      // Serialize bounded reads so parallel onLoad callbacks cannot oversubscribe
      // the remaining graph budget. readRoomPluginFile checks stat before alloc.
      const maximum = Math.min(ROOM_PLUGIN_LIMITS.artifactBytes, graphMaximumBytes - sourceBytes);
      const sizeCode = maximum < ROOM_PLUGIN_LIMITS.artifactBytes ? "source_graph_too_large" : "entry_too_large";
      const bytes = await readRoomPluginFile(path, maximum, sizeCode);
      sourceBytes += bytes.byteLength;
      return { contents: decodeRoomPluginFile(bytes), loader: sourceLoader };
    });
    sources.set(path, loaded);
    reads = loaded.then(() => {}, () => {});
    return loaded;
  }
  try {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [source],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2020",
      packages: "bundle",
      mainFields: ["module", "main"],
      // Built-in import/require conditions follow each import's kind. An explicit
      // empty custom list also disables esbuild's automatic "module" condition.
      conditions: [],
      tsconfigRaw: { compilerOptions: {} },
      minify: true,
      charset: "utf8",
      legalComments: "inline",
      sourcemap: false,
      logLevel: "silent",
      plugins: [{
        name: "bounded-local-source",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async args => {
            try {
              // The canonical entry is already root-checked and bounded above.
              // It must have the same file identity when a dependency imports it.
              if (args.kind === "entry-point") return { path: source };
              if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(args.path)) throw new RoomPluginCliError("module_import_forbidden", 3);
              const target = await checkRoomPluginImport(root, args.resolveDir, args.path);
              const main = await legacyRequireMain(target, args.path, args.kind);
              if (main && target) {
                await checkRoomPluginImport(root, target.directory, main);
                // Resolve the explicit main path natively (extensions/directories),
                // keeping the same root guards on the nested resolver callback.
                const resolved = await builder.resolve(main, { kind: args.kind, resolveDir: target.directory });
                if (resolved.errors.length) throw new RoomPluginCliError("bundle_failed", 5);
                if (!resolved.external) await roomPluginSourcePath(root, resolved.path);
                return resolved;
              }
              return undefined;
            } catch (error) {
              inputError ??= error;
              return { errors: [{ text: "local_import_rejected" }] };
            }
          });
          builder.onLoad({ filter: /.*/ }, async args => {
            try {
              const dependency = await roomPluginSourcePath(root, args.path);
              const dependencyLoader = loaders[extname(dependency).toLowerCase()];
              if (!dependencyLoader) throw new RoomPluginCliError("unsupported_source_type", 3);
              return { ...await loadSource(dependency, dependencyLoader), resolveDir: dirname(dependency) };
            } catch (error) {
              inputError ??= error;
              return { errors: [{ text: "local_source_rejected" }] };
            }
          });
        }
      }]
    });
    if (result.outputFiles.length !== 1) throw new RoomPluginCliError("bundle_failed", 5);
    const bytes = result.outputFiles[0]!.contents;
    if (bytes.byteLength > ROOM_PLUGIN_LIMITS.artifactBytes) throw new RoomPluginCliError("entry_too_large", 3);
    const entry = decodeRoomPluginFile(bytes);
    roomPluginUtf8ByteLength(entry, ROOM_PLUGIN_LIMITS.artifactBytes, "artifact_too_large");
    validateRoomPluginModule(entry);
    return bytes;
  } catch (error) {
    if (inputError) throw inputError;
    if (error instanceof RoomPluginCliError || error instanceof RoomPluginValidationError) throw error;
    throw new RoomPluginCliError("bundle_failed", 5);
  }
}
