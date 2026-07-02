import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { validateSceneBundlePath, validateSceneBundleReference } from "./scene-bundle-validator.js";
import { validateAsset, validateAvatarPack } from "./validator.js";

const execFileAsync = promisify(execFile);

async function createSceneBundle(input: {
  sceneJson?: Record<string, unknown>;
  files?: Record<string, string | Buffer>;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vrata-scene-bundle-"));
  if (input.sceneJson) {
    await writeFile(join(root, "scene.json"), `${JSON.stringify(input.sceneJson, null, 2)}\n`);
  }
  for (const [filePath, content] of Object.entries(input.files ?? {})) {
    const absolutePath = join(root, filePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  return root;
}

function validSceneJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sceneId: "test-scene-v1",
    label: "Test Scene",
    source: "vrata-test-fixture",
    glbPath: "scene.glb",
    spawnPoints: [{ id: "main", position: { x: 0, y: 0, z: 4 } }],
    bounds: { width: 10, height: 4, depth: 10 },
    preview: "preview.webp",
    ...overrides
  };
}

function createStoredZip(files: Record<string, string | Buffer>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, rawContent] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(content.byteLength, 18);
    localHeader.writeUInt32LE(content.byteLength, 22);
    localHeader.writeUInt16LE(nameBuffer.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(content.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(nameBuffer.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.byteLength + nameBuffer.byteLength + content.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

test("validateAsset accepts glb under budget", () => {
  assert.deepEqual(validateAsset({ fileName: "scene.glb", extension: ".glb", sizeMb: 10 }), {
    ok: true,
    reasons: []
  });
});

test("validateAsset rejects oversized unknown asset", () => {
  const result = validateAsset({ fileName: "scene.fbx", extension: ".fbx", sizeMb: 100 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["unsupported_extension", "asset_too_large"]);
});

test("validateAvatarPack accepts technical humanoid pack metadata", () => {
  const result = validateAvatarPack({
    rig: "humanoid-v1",
    packFormat: "procedural-debug-v1",
    packUrl: "/assets/avatars/avatar-pack.v1.glb",
    presets: Array.from({ length: 10 }, (_, index) => ({
      avatarId: `preset-${String(index + 1).padStart(2, "0")}`,
      triangleCount: 12000,
      materialCount: 1,
      textureCount: 1,
      morphTargets: ["blink", "viseme-aa"],
      animationClips: ["idle"],
      skeletonSignature: "humanoid-v1/base"
    }))
  });

  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("validateAvatarPack rejects mismatched skeleton signatures", () => {
  const result = validateAvatarPack({
    rig: "humanoid-v1",
    packFormat: "procedural-debug-v1",
    packUrl: "/assets/avatars/avatar-pack.v1.glb",
    presets: Array.from({ length: 10 }, (_, index) => ({
      avatarId: `preset-${String(index + 1).padStart(2, "0")}`,
      triangleCount: 12000,
      materialCount: 1,
      textureCount: 1,
      morphTargets: ["blink", "viseme-aa"],
      animationClips: ["idle"],
      skeletonSignature: index === 9 ? "humanoid-v1/alt" : "humanoid-v1/base"
    }))
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasons.includes("mismatched_skeleton_signature"), true);
});

test("validateSceneBundlePath accepts a valid scene directory", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson(),
    files: {
      "scene.glb": Buffer.from("glb"),
      "preview.webp": Buffer.from("webp")
    }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.stats.fileCount, 3);
    assert.equal(result.stats.mainAssetBytes, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath accepts a valid zip scene bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "vrata-scene-bundle-zip-test-"));
  const zipPath = join(root, "bundle.zip");
  await writeFile(zipPath, createStoredZip({
    "scene.json": `${JSON.stringify(validSceneJson(), null, 2)}\n`,
    "scene.glb": Buffer.from("glb"),
    "preview.webp": Buffer.from("webp")
  }));
  try {
    const result = await validateSceneBundlePath(zipPath);
    assert.equal(result.ok, true);
    assert.equal(result.inputType, "zip");
    assert.equal(result.manifestPath, `${zipPath}!/scene.json`);
    assert.equal(result.stats.mainAssetBytes, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath rejects a missing scene.json", async () => {
  const root = await createSceneBundle({ files: { "scene.glb": Buffer.from("glb") } });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.code === "missing_scene_json" && issue.path === "scene.json"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath rejects a missing scene asset", async () => {
  const root = await createSceneBundle({ sceneJson: validSceneJson({ glbPath: "missing.glb", preview: undefined }) });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.code === "missing_scene_asset" && issue.path === "missing.glb"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath rejects an invalid spawn point", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({ spawnPoints: [{ id: "main", position: { x: 0, y: "bad", z: 4 } }] }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue) => issue.code === "invalid_scene_bundle_position" && issue.path === "scene.json#/spawnPoints/0/position/y"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundleReference rejects unsafe storage keys for server-side callers", () => {
  const issues = validateSceneBundleReference({ storageKey: "../scene.json", provider: "minio-default" });
  assert.equal(issues.some((issue) => issue.code === "invalid_scene_bundle_storage_key"), true);
});

test("scene bundle CLI --json returns structured validation errors", async () => {
  const root = await createSceneBundle({ sceneJson: validSceneJson({ glbPath: "missing.glb", preview: undefined }) });
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  try {
    let rejected: unknown;
    try {
      await execFileAsync(process.execPath, [cliPath, "scenes", "validate", root, "--json"], { encoding: "utf8" });
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected && typeof rejected === "object" && "stdout" in rejected);
    const payload = JSON.parse(String((rejected as { stdout: string }).stdout)) as { ok: boolean; issues: Array<{ code: string; path: string; message: string }> };
    assert.equal(payload.ok, false);
    assert.equal(payload.issues.some((issue) => issue.code === "missing_scene_asset" && issue.path === "missing.glb" && issue.message.length > 0), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
