import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

// Build only the fixed, trusted SDK graph. Author artifacts still use the separate
// bounded CLI and are never executed by this package build or by API validation.
if (version !== "0.25.12") throw new Error("bundler_version_mismatch");
const source = new URL("../src/", import.meta.url);
const output = new URL("./commonjs/", import.meta.url);
await build({
  entryPoints: ["index", "artifact", "contracts", "config", "data", "errors", "messages", "text"].map(name => fileURLToPath(new URL(`${name}.ts`, source))),
  outdir: fileURLToPath(output),
  format: "cjs",
  platform: "neutral",
  target: "es2022",
  bundle: false,
  sourcemap: true,
  charset: "utf8",
  logLevel: "silent"
});
// The distinct graph keeps CJS loader/transformation caches separate from ESM;
// shared modules within each graph retain one constructor/module identity.
await writeFile(new URL("package.json", output), JSON.stringify({ type: "commonjs" }) + "\n");
