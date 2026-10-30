import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pluginRuntimeAssets } from "./plugin-runtime-assets.mjs";

test("built sandbox distribution is self-contained, pinned, and refuses altered bytes or manifests", async t => {
  const manifest = await pluginRuntimeAssets(resolve("apps/runtime-web/dist"), true);
  assert.ok(manifest.artifacts.length >= 4);
  const directory = await mkdtemp(join(tmpdir(), "vrata-plugin-runtime-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const artifact of manifest.artifacts) {
    assert.match(artifact.url, /^\/assets\//);
    await mkdir(dirname(join(directory, `.${artifact.url}`)), { recursive: true });
    await cp(resolve("apps/runtime-web/dist", `.${artifact.url}`), join(directory, `.${artifact.url}`));
  }
  await cp(resolve("apps/runtime-web/dist/assets/plugin-sdk/releases.json"), join(directory, "assets/plugin-sdk/releases.json"));
  await pluginRuntimeAssets(directory);
  await pluginRuntimeAssets(directory, true);
  const wasm = manifest.artifacts.find(item => item.url.endsWith(".wasm"));
  const path = join(directory, `.${wasm.url}`), bytes = await readFile(path);
  await writeFile(path, Buffer.from("corrupted"));
  await assert.rejects(pluginRuntimeAssets(directory, true), /wasm_digest_mismatch/);
  await writeFile(path, bytes);
  const worker = manifest.artifacts.find(item => item.url.includes("room-plugin-worker-"));
  await writeFile(join(directory, `.${worker.url}`), "// drift");
  await assert.rejects(pluginRuntimeAssets(directory, true), /manifest_mismatch/);
});
