import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import test from "node:test";

import {
  desiredSceneBundleUrl,
  preflightSceneBundle,
  resolveSceneBundleVersion
} from "./patch-staging-scene-bundles.mjs";

const fullSha = "0123456789abcdef0123456789abcdef01234567";

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("resolveSceneBundleVersion requires an explicit full sha by default", () => {
  assert.equal(resolveSceneBundleVersion({ STAGING_SCENE_BUNDLE_VERSION: fullSha }), fullSha);
  assert.equal(resolveSceneBundleVersion({ DEPLOY_SHA: fullSha }), fullSha);
  assert.equal(resolveSceneBundleVersion({}, fullSha), fullSha);
  assert.throws(() => resolveSceneBundleVersion({}), /missing_scene_bundle_version/);
  assert.throws(() => resolveSceneBundleVersion({ STAGING_SCENE_BUNDLE_VERSION: "v1" }), /expected_full_git_sha/);
  assert.equal(resolveSceneBundleVersion({ STAGING_ALLOW_MUTABLE_SCENE_BUNDLE_URL: "1" }), null);
});

test("desiredSceneBundleUrl writes version into the scene asset path", () => {
  assert.equal(
    desiredSceneBundleUrl("sense-hall2-v1", {
      assetBaseUrl: "https://state.example.test/",
      version: fullSha
    }),
    `https://state.example.test/assets/scenes/sense-hall2-v1/${fullSha}/scene.json`
  );
});

test("preflightSceneBundle verifies manifest and relative assets", async () => {
  await withServer((request, response) => {
    if (request.url === `/${fullSha}/scene.json`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        sceneId: "test-scene",
        glbPath: "scene.glb",
        preview: "preview.png",
        materialOverrides: [{ match: "wall", mapPath: "textures/wall.png" }]
      }));
      return;
    }
    if ([`/${fullSha}/scene.glb`, `/${fullSha}/preview.png`, `/${fullSha}/textures/wall.png`].includes(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(request.method === "HEAD" ? undefined : "x");
      return;
    }
    response.writeHead(404);
    response.end();
  }, async (baseUrl) => {
    const result = await preflightSceneBundle(`${baseUrl}/${fullSha}/scene.json`, { attempts: 1, delayMs: 1 });
    assert.equal(result.sceneId, "test-scene");
    assert.equal(result.assetUrls.length, 3);
  });
});

test("snapshot-scene-assets creates immutable version directory without copying older snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "noah-scene-assets-"));
  const scene = join(root, "sense-hall2-v1");
  const oldSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  await mkdir(join(scene, oldSha), { recursive: true });
  await writeFile(join(scene, "scene.json"), JSON.stringify({ glbPath: "scene.glb" }));
  await writeFile(join(scene, "scene.glb"), "glb");
  await writeFile(join(scene, oldSha, ".noah-scene-snapshot"), "version=old\n");
  await writeFile(join(scene, oldSha, "old.txt"), "old");

  const scriptPath = fileURLToPath(new URL("./snapshot-scene-assets.sh", import.meta.url));
  await execFilePromise("bash", [scriptPath, "--root", root, "--version", fullSha, "--scene", "sense-hall2-v1"]);

  assert.equal(await readFile(join(scene, fullSha, "scene.json"), "utf8"), JSON.stringify({ glbPath: "scene.glb" }));
  assert.equal(await readFile(join(scene, fullSha, "scene.glb"), "utf8"), "glb");
  await assert.rejects(readFile(join(scene, fullSha, oldSha, "old.txt"), "utf8"));
});
