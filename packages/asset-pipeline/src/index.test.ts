import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { validateSceneBundlePath, validateSceneBundleReference } from "./scene-bundle-validator.js";
import { validateTemplateScenePair } from "./template-scene-validator.js";
import { validateAsset, validateAvatarPack } from "./validator.js";
import type { RoomTemplateSceneContract } from "@vrata/shared-types";

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

function validMediaSurface(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    surfaceId: "debug-main",
    representation: "platform-runtime-plane",
    position: { x: 0, y: 2, z: -5 },
    yaw: 0,
    widthM: 3.2,
    heightM: 1.8,
    pixelDimensions: { width: 1920, height: 1080 },
    frontFace: "local-positive-z",
    input: { enabled: true, maxDistanceM: 12 },
    ...overrides
  };
}

function validLegacyMediaSurface(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    surfaceId: "debug-main",
    label: "Legacy screen",
    kind: "wall",
    widthM: 3.2,
    heightM: 1.8,
    widthPx: 1920,
    heightPx: 1080,
    transform: { x: 0, y: 2, z: -5, yaw: 0, pitch: 0, roll: 0 },
    visible: true,
    allowedObjectTypes: ["screen-share"],
    ...overrides
  };
}

const meetingSceneContract: RoomTemplateSceneContract = {
  schemaVersion: 1,
  templateId: "meeting-room-basic",
  templateVersion: "1.0.0",
  sceneId: "meeting-room-v1",
  sceneVersion: "1.0.0",
  surfaces: [
    {
      surfaceId: "debug-main",
      label: "Meeting display",
      purpose: "collaboration",
      allowedObjectTypes: ["screen-share"],
      aspectRatio: { width: 16, height: 9, maxRelativeError: 0.02 }
    },
    {
      surfaceId: "whiteboard-wall",
      label: "Collaboration wall",
      purpose: "collaboration",
      allowedObjectTypes: ["whiteboard"],
      aspectRatio: { width: 48, height: 25, maxRelativeError: 0.02 }
    }
  ],
  seats: { minimum: 4, maximum: 4 }
};

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

test("validateSceneBundlePath validates the F3 media surface projection", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [
        validMediaSurface({
          representation: "mesh-node",
          position: { x: 0, y: "bad", z: -5 },
          yaw: Number.POSITIVE_INFINITY,
          widthM: 0,
          pixelDimensions: { width: 1920.5, height: 1080 },
          frontFace: "local-negative-z",
          input: { enabled: "yes", maxDistanceM: 0 }
        }),
        validMediaSurface({
          surfaceId: "whiteboard-wall",
          position: null,
          pixelDimensions: null,
          input: null
        })
      ]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_representation" && entry.path === "scene.json#/mediaSurfaces/0/representation"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_position" && entry.path === "scene.json#/mediaSurfaces/0/position/y"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_yaw" && entry.path === "scene.json#/mediaSurfaces/0/yaw"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_dimensions" && entry.path === "scene.json#/mediaSurfaces/0/widthM"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_pixel_dimensions" && entry.path === "scene.json#/mediaSurfaces/0/pixelDimensions/width"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_front_face" && entry.path === "scene.json#/mediaSurfaces/0/frontFace"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_input_enabled" && entry.path === "scene.json#/mediaSurfaces/0/input/enabled"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_input_max_distance_m" && entry.path === "scene.json#/mediaSurfaces/0/input/maxDistanceM"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_position" && entry.path === "scene.json#/mediaSurfaces/1/position"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_pixel_dimensions" && entry.path === "scene.json#/mediaSurfaces/1/pixelDimensions"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_input" && entry.path === "scene.json#/mediaSurfaces/1/input"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath accepts the exact runtime media surface shape", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [{
        surfaceId: "debug-main",
        representation: "platform-runtime-plane",
        position: { x: 0, y: 2, z: -5 },
        yaw: 0,
        widthM: 3.2,
        heightM: 1.8,
        pixelDimensions: { width: 1920, height: 1080 },
        frontFace: "local-positive-z",
        input: { enabled: false, maxDistanceM: 6 }
      }]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath preserves independent physical and pixel aspect ratios", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [validMediaSurface({ widthM: 3.2, heightM: 2 })]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath rejects non-positive and fractional media surface pixel dimensions", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [
        validMediaSurface(),
        validMediaSurface({ surfaceId: "fractional", pixelDimensions: { width: 1920.5, height: 1080 } }),
        validMediaSurface({ surfaceId: "non-positive", pixelDimensions: { width: 1920, height: 0 } })
      ]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.filter((entry) => entry.code === "invalid_scene_bundle_media_surface_pixel_dimensions").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath rejects an explicitly empty media surface layout", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({ mediaSurfaces: [] }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surfaces_empty"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath rejects duplicate media surface ids", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({ mediaSurfaces: [validMediaSurface(), validMediaSurface()] }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((entry) => entry.code === "duplicate_scene_bundle_media_surface_id" && entry.path === "scene.json#/mediaSurfaces/1/surfaceId"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surfaces_debug_main_count" && entry.path === "scene.json#/mediaSurfaces"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath requires exactly one debug-main F3 media surface", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({ mediaSurfaces: [validMediaSurface({ surfaceId: "whiteboard-wall" })] }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surfaces_debug_main_count" && entry.path === "scene.json#/mediaSurfaces"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath accepts and validates legacy v1 media surfaces", async () => {
  const acceptedRoot = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [
        validLegacyMediaSurface({ surfaceId: "legacy-wall" }),
        validLegacyMediaSurface({ surfaceId: "legacy-table", kind: "table", transform: { x: 1, y: 1, z: 2 } })
      ]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  const rejectedRoot = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [validLegacyMediaSurface({
        transform: { x: 0, y: "bad", z: -5, pitch: Number.POSITIVE_INFINITY },
        allowedObjectTypes: ["screen-share", ""]
      })]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const accepted = await validateSceneBundlePath(acceptedRoot);
    const rejected = await validateSceneBundlePath(rejectedRoot);
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.issues, []);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_transform" && entry.path.endsWith("/transform/y")), true);
    assert.equal(rejected.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_allowed_object_type"), true);
  } finally {
    await rm(acceptedRoot, { recursive: true, force: true });
    await rm(rejectedRoot, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath rejects mixed F3 and legacy media surface arrays", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [validMediaSurface(), validLegacyMediaSurface({ surfaceId: "legacy-wall" })]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surfaces_mixed_formats" && entry.path === "scene.json#/mediaSurfaces"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath still rejects duplicate ids in all-legacy arrays", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [
        validLegacyMediaSurface({ surfaceId: "legacy-wall" }),
        validLegacyMediaSurface({ surfaceId: "legacy-wall" })
      ]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((entry) => entry.code === "duplicate_scene_bundle_media_surface_id"), true);
    assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surfaces_debug_main_count"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateSceneBundlePath enforces equal F3 and legacy pixel budgets at boundaries", async () => {
  const acceptedRoot = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [validMediaSurface({ pixelDimensions: { width: 8192, height: 4096 } })]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  const acceptedLegacyRoot = await createSceneBundle({
    sceneJson: validSceneJson({
      mediaSurfaces: [validLegacyMediaSurface({ widthPx: 8192, heightPx: 4096 })]
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  const rejectedRoots = await Promise.all([
    validMediaSurface({ pixelDimensions: { width: 8193, height: 1 } }),
    validMediaSurface({ pixelDimensions: { width: 8192, height: 4097 } }),
    validLegacyMediaSurface({ widthPx: 8193, heightPx: 1 }),
    validLegacyMediaSurface({ widthPx: 8192, heightPx: 4097 })
  ].map((surface) => createSceneBundle({
    sceneJson: validSceneJson({ mediaSurfaces: [surface] }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  })));
  try {
    assert.equal((await validateSceneBundlePath(acceptedRoot)).ok, true);
    assert.equal((await validateSceneBundlePath(acceptedLegacyRoot)).ok, true);
    for (const root of rejectedRoots) {
      const result = await validateSceneBundlePath(root);
      assert.equal(result.ok, false);
      assert.equal(result.issues.some((entry) => entry.code === "invalid_scene_bundle_media_surface_pixel_dimensions"), true);
    }
  } finally {
    await rm(acceptedRoot, { recursive: true, force: true });
    await rm(acceptedLegacyRoot, { recursive: true, force: true });
    await Promise.all(rejectedRoots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("validateTemplateScenePair accepts matching surfaces and seat policy", () => {
  const issues = validateTemplateScenePair(validSceneJson({
    sceneId: "meeting-room-v1",
    mediaSurfaces: [
      validMediaSurface(),
      validMediaSurface({
        surfaceId: "whiteboard-wall",
        widthM: 4.8,
        heightM: 2.5,
        pixelDimensions: { width: 1920, height: 1000 }
      })
    ],
    anchors: {
      seatAnchors: Array.from({ length: 4 }, (_, index) => ({
        id: `seat-${index}`,
        position: { x: index, y: 0.48, z: 0 },
        yaw: 0,
        seatHeight: 0.06,
        radius: 0.5
      }))
    }
  }), meetingSceneContract, "1.0.0");
  assert.deepEqual(issues, []);
});

test("validateTemplateScenePair rejects incomplete pixel dimensions", () => {
  const issues = validateTemplateScenePair(validSceneJson({
    sceneId: "meeting-room-v1",
    mediaSurfaces: [
      validMediaSurface({ pixelDimensions: { width: 1920 } }),
      validMediaSurface({
        surfaceId: "whiteboard-wall",
        widthM: 4.8,
        heightM: 2.5,
        pixelDimensions: { width: 1920, height: 1000 }
      })
    ],
    anchors: {
      seatAnchors: Array.from({ length: 4 }, (_, index) => ({
        id: `seat-${index}`,
        position: { x: index, y: 0.48, z: 0 },
        yaw: 0,
        seatHeight: 0.06
      }))
    }
  }), meetingSceneContract, "1.0.0");
  assert.equal(issues.some((entry) => entry.code === "template_surface_pixel_dimensions_required"), true);
});

test("validateTemplateScenePair preserves legacy aspect and allowlist checks", () => {
  const accepted = validateTemplateScenePair(validSceneJson({
    sceneId: "meeting-room-v1",
    mediaSurfaces: [
      validLegacyMediaSurface(),
      validLegacyMediaSurface({
        surfaceId: "whiteboard-wall",
        widthM: 4.8,
        heightM: 2.5,
        widthPx: 1920,
        heightPx: 1000,
        allowedObjectTypes: ["whiteboard"]
      })
    ],
    anchors: {
      seatAnchors: Array.from({ length: 4 }, (_, index) => ({
        id: `seat-${index}`,
        position: { x: index, y: 0.48, z: 0 },
        yaw: 0,
        seatHeight: 0.06
      }))
    }
  }), meetingSceneContract, "1.0.0");
  const rejected = validateTemplateScenePair(validSceneJson({
    sceneId: "meeting-room-v1",
    mediaSurfaces: [
      validLegacyMediaSurface({ widthM: 2, heightM: 1, allowedObjectTypes: ["whiteboard"] }),
      validLegacyMediaSurface({ surfaceId: "whiteboard-wall", widthM: 4.8, heightM: 2.5, widthPx: 1920, heightPx: 1000, allowedObjectTypes: ["whiteboard"] })
    ],
    anchors: { seatAnchors: [] }
  }), meetingSceneContract, "1.0.0");

  assert.deepEqual(accepted, []);
  assert.equal(rejected.some((entry) => entry.code === "template_surface_aspect_ratio_mismatch"), true);
  assert.equal(rejected.some((entry) => entry.code === "template_surface_object_type_mismatch"), true);
});

test("validateSceneBundlePath applies template scene pair requirements", async () => {
  const root = await createSceneBundle({
    sceneJson: validSceneJson({
      schemaVersion: 99,
      sceneId: "wrong-scene-v1",
      mediaSurfaces: [validMediaSurface({ widthM: 2, heightM: 1 })],
      anchors: { seatAnchors: [] }
    }),
    files: { "scene.glb": Buffer.from("glb"), "preview.webp": Buffer.from("webp") }
  });
  try {
    const result = await validateSceneBundlePath(root, { templateContract: meetingSceneContract, sceneVersion: "0.9.0" });
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((entry) => entry.code === "template_scene_id_mismatch"), true);
    assert.equal(result.issues.some((entry) => entry.code === "template_scene_schema_mismatch"), true);
    assert.equal(result.issues.some((entry) => entry.code === "template_scene_version_mismatch"), true);
    assert.equal(result.issues.some((entry) => entry.code === "missing_template_surface"), true);
    assert.equal(result.issues.some((entry) => entry.code === "template_surface_aspect_ratio_mismatch"), true);
    assert.equal(result.issues.some((entry) => entry.code === "template_seat_count_mismatch"), true);
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
