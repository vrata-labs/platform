import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../apps/runtime-web/package.json", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));
const lockFile = resolve(root, "infra/docker/plugin-runtime.lock.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const manifestPath = "assets/plugin-runtime/releases.json";

export async function pinnedPluginInputs() {
  const packagePath = require.resolve("@jitl/quickjs-wasmfile-release-sync/package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const files = { wasm: pkg.exports["./wasm"], ffi: pkg.exports["./ffi"].import, loader: pkg.exports["./emscripten-module"].browser };
  const inputs = {};
  for (const [name, path] of Object.entries(files)) inputs[name] = hash(await readFile(resolve(dirname(packagePath), path)));
  return { schemaVersion: 1, quickjsVersion: pkg.version, inputs };
}

export async function pluginRuntimeAssets(dist, verify = false) {
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  if (JSON.stringify(lock) !== JSON.stringify(await pinnedPluginInputs())) throw new Error("plugin_runtime_input_digest_mismatch");
  const files = await readdir(resolve(dist, "assets"));
  const selected = files.filter(name => /^room-plugin-(?:worker|kernel)-[A-Za-z0-9_-]{8,}\.js$/.test(name)
    || /^emscripten-module.*-[A-Za-z0-9_-]{8,}\.wasm$/.test(name));
  for (const pattern of [/^room-plugin-worker-/, /^room-plugin-kernel-/, /\.wasm$/]) {
    if (selected.filter(name => pattern.test(name)).length !== 1) throw new Error("plugin_runtime_asset_missing_or_duplicate");
  }
  const artifacts = [];
  for (const name of selected.sort()) {
    const bytes = await readFile(resolve(dist, "assets", name));
    const sha256 = hash(bytes);
    if (name.endsWith(".wasm") && sha256 !== lock.inputs.wasm) throw new Error("plugin_runtime_wasm_digest_mismatch");
    artifacts.push({ url: `/assets/${name}`, sha256, bytes: bytes.length });
  }
  const sdk = JSON.parse(await readFile(resolve(dist, "assets/plugin-sdk/releases.json"), "utf8"));
  for (const release of sdk.releases) {
    if (!/^\/assets\/plugin-sdk\/\d+\.\d+\.\d+\/[a-f0-9]{64}\/vrata-room-plugin-sdk-\d+\.\d+\.\d+\.tgz$/.test(release.url)) {
      throw new Error("plugin_runtime_sdk_url_invalid");
    }
    const bytes = await readFile(resolve(dist, `.${release.url}`));
    if (hash(bytes) !== release.sha256) throw new Error("plugin_runtime_sdk_digest_mismatch");
    artifacts.push({ url: release.url, sha256: release.sha256, bytes: bytes.length });
  }
  if (!sdk.releases.length) throw new Error("plugin_runtime_sdk_missing");
  const manifest = { schemaVersion: 1, quickjsVersion: lock.quickjsVersion, artifacts };
  const path = resolve(dist, manifestPath);
  if (verify) {
    if (JSON.stringify(JSON.parse(await readFile(path, "utf8"))) !== JSON.stringify(manifest)) throw new Error("plugin_runtime_manifest_mismatch");
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write-lock")) await writeFile(lockFile, `${JSON.stringify(await pinnedPluginInputs(), null, 2)}\n`);
  else await pluginRuntimeAssets(resolve(root, "apps/runtime-web/dist"), process.argv.includes("--verify"));
}
