import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as esm from "../index.js";
import * as esmArtifact from "../artifact.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, "package.json"));

test("require/import use distinct graphs with matching public values and shared errors within each graph", () => {
  const cjs = require("@vrata/room-plugin-sdk");
  const cjsArtifact = require("@vrata/room-plugin-sdk/artifact");
  assert.match(require.resolve("@vrata/room-plugin-sdk"), /[/\\]dist[/\\]commonjs[/\\]index\.js$/);
  assert.match(fileURLToPath(import.meta.resolve("@vrata/room-plugin-sdk")), /[/\\]dist[/\\]index\.js$/);
  assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
  assert.deepEqual(Object.keys(cjsArtifact).sort(), Object.keys(esmArtifact).sort());
  assert.deepEqual(cjs.ROOM_PLUGIN_LIMITS, esm.ROOM_PLUGIN_LIMITS);
  assert.throws(() => cjsArtifact.validateRoomPluginArtifact("bad"), error => error instanceof cjs.RoomPluginValidationError);
  assert.throws(() => esmArtifact.validateRoomPluginArtifact("bad"), error => error instanceof esm.RoomPluginValidationError);
});

test("actual Playwright CJS transform cache cannot poison SDK ESM imports", () => {
  const directory = mkdtempSync(join(tmpdir(), "vrata-sdk-loader-cache-"));
  const workspaceRequire = createRequire(join(root, "../../package.json"));
  const playwright = dirname(workspaceRequire.resolve("playwright/package.json"));
  const code = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {readFileSync} from 'node:fs';
    import {dirname,join} from 'node:path';
    import {pathToFileURL} from 'node:url';
    const require=createRequire(${JSON.stringify(join(root, "package.json"))});
    const transform=require(${JSON.stringify(join(playwright, "lib/transform/transform.js"))});
    const cache=require(${JSON.stringify(join(playwright, "lib/transform/compilationCache.js"))});
    const contracts=join(dirname(require.resolve('@vrata/room-plugin-sdk')),'contracts.js');
    transform.transformHook(readFileSync(contracts,'utf8'),contracts);
    const entry=cache.serializeCompilationCache().memoryCache.find(([file])=>file===contracts);
    assert.equal(entry[1].moduleUrl,undefined);
    const host=require(${JSON.stringify(join(playwright, "lib/common/esmLoaderHost.js"))});
    host.registerESMLoader(); await host.configureESMLoader();
    const main=await import(pathToFileURL(${JSON.stringify(join(root, "dist/index.js"))}).href);
    const artifact=await import(pathToFileURL(${JSON.stringify(join(root, "dist/artifact.js"))}).href);
    assert.equal(main.ROOM_PLUGIN_LIMITS.artifactBytes,1048576);
    assert.throws(()=>artifact.validateRoomPluginArtifact('bad'),error=>error instanceof main.RoomPluginValidationError);
    process.stdout.write('mixed-loader PASS');
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PWTEST_CACHE_DIR: join(directory, "cache") }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "mixed-loader PASS");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
