import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real pnpm tarball separates published declarations from pre-build workspace source types", { timeout: 90_000 }, () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const manifestPath = join(root, "package.json");
  const original = readFileSync(manifestPath, "utf8");
  const workspace = JSON.parse(original);
  assert.equal(workspace.types, "./src/index.ts");
  assert.equal(workspace.exports["."].types, "./src/index.ts");
  assert.equal(workspace.exports["./artifact"].types, "./src/artifact.ts");

  const directory = mkdtempSync(join(tmpdir(), "vrata-room-plugin-sdk-pack-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", directory], { cwd: root, timeout: 60_000, encoding: "utf8" });
    const archives = readdirSync(directory).filter(name => name.endsWith(".tgz"));
    assert.equal(archives.length, 1, "pack must produce one standalone archive");
    const archive = join(directory, archives[0]!);
    const published = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8", timeout: 10_000 }));
    const files = new Set(execFileSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 10_000 }).trim().split("\n"));
    const expectedExports = {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/commonjs/index.js", default: "./dist/index.js" },
      "./artifact": { types: "./dist/artifact.d.ts", import: "./dist/artifact.js", require: "./dist/commonjs/artifact.js", default: "./dist/artifact.js" },
      "./package.json": "./package.json"
    };

    assert.equal(published.name, "@vrata/room-plugin-sdk");
    assert.equal(published.types, "./dist/index.d.ts", "external consumers must not compile SDK source");
    assert.deepEqual(published.exports, expectedExports);
    assert.deepEqual(published.bin, { "vrata-room-plugin": "dist/cli.js" });
    assert.equal(published.dependencies.esbuild, "0.25.12");
    assert.ok(files.has("package/dist/cli.js"));
    assert.ok(execFileSync("tar", ["-xOf", archive, "package/dist/cli.js"], { encoding: "utf8", timeout: 10_000 }).startsWith("#!/usr/bin/env node\n"));
    assert.deepEqual(Object.keys(workspace.exports).sort(), Object.keys(published.exports).sort(), "publish must preserve the workspace public namespace");
    for (const name of [".", "./artifact"] as const) {
      const entry = published.exports[name];
      assert.equal(entry.import, workspace.exports[name].import, "runtime import ABI must not change during pack");
      assert.equal(entry.default, workspace.exports[name].default);
      assert.equal(entry.require, workspace.exports[name].require);
      assert.notEqual(entry.require, entry.import, "CJS and ESM loaders must never share a transformed filename");
      for (const target of new Set<string>(Object.values(entry))) {
        assert.ok(files.has(`package/${target.slice(2)}`), `missing published export target: ${target}`);
      }
    }
    assert.ok(files.has("package/src/index.ts"), "source remains available independently of declaration exports");
    assert.deepEqual(JSON.parse(execFileSync("tar", ["-xOf", archive, "package/dist/commonjs/package.json"], { encoding: "utf8", timeout: 10_000 })), { type: "commonjs" });
    assert.ok(files.has("package/src/artifact.ts"));
    assert.ok(files.has("package/examples/welcome-status/build.mjs"));
    assert.ok(files.has("package/examples/auto-seat/build.mjs"));
    assert.ok(files.has("package/examples/auto-seat/manifest.json"));
    for (const example of ["welcome-status", "auto-seat"]) {
      const exampleManifest = JSON.parse(execFileSync("tar", ["-xOf", archive, `package/examples/${example}/package.json`], { encoding: "utf8", timeout: 10_000 }));
      assert.equal(exampleManifest.dependencies["@vrata/room-plugin-sdk"], "file:./vrata-room-plugin-sdk-0.1.0.tgz", "standalone examples must never resolve a registry SDK name");
    }
    assert.equal(readFileSync(manifestPath, "utf8"), original, "pack must not rewrite workspace source exports");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
