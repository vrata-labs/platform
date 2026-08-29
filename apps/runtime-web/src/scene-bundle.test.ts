import test from "node:test";
import assert from "node:assert/strict";

import { parseSceneBundleManifest, pickSceneSpawnPoint, resolveSceneAssetUrl } from "./scene-bundle.js";

test("parseSceneBundleManifest accepts valid v1 manifest", () => {
  const manifest = parseSceneBundleManifest({
    schemaVersion: 1,
    sceneId: "sense-hall",
    label: "Sense Hall",
    source: "sensetower",
    glbPath: "scene.glb",
    renderMode: "clean",
    renderProfile: "neutral-pbr",
    materialOverrides: [
      {
        match: "chairs*",
        mapPath: "textures/chairs.png",
        color: { r: 1, g: 1, b: 1 }
      }
    ],
    spawnPoints: [
      {
        id: "main",
        position: { x: 1, y: 0, z: -2 },
        yaw: Math.PI / 2
      }
    ],
    anchors: {
      teleportFloorY: 0,
      seatAnchors: [
        {
          id: "seat-a",
          position: { x: 2, y: 0, z: -1 },
          yaw: Math.PI,
          seatHeight: 0.45,
          radius: 0.5,
          label: "Front chair"
        }
      ]
    },
    mediaSurfaces: [
      {
        surfaceId: "debug-main",
        representation: "platform-runtime-plane",
        position: { x: 3.83, y: 2.35, z: -0.05 },
        yaw: -Math.PI / 2,
        widthM: 5.8,
        heightM: 3.3,
        pixelDimensions: { width: 1920, height: 1080 },
        frontFace: "local-positive-z",
        input: { enabled: true, maxDistanceM: 0.05 }
      }
    ],
    bounds: { width: 20, height: 8, depth: 20 },
    preview: "preview.jpg",
    attributions: [
      {
        title: "Old Room",
        author: "Hansalex",
        authorUrl: "https://sketchfab.com/Hansalex",
        source: "https://sketchfab.com/3d-models/old-room-6173a3c88c384f768dfc80967b6527b4",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        changes: "Normalized to meters."
      }
    ]
  });

  assert.equal(manifest.sceneId, "sense-hall");
  assert.equal(manifest.renderMode, "clean");
  assert.equal(manifest.renderProfile, "neutral-pbr");
  assert.equal(manifest.spawnPoints[0]?.yaw, Math.PI / 2);
  assert.equal(manifest.materialOverrides?.[0]?.match, "chairs*");
  assert.equal(manifest.anchors?.teleportFloorY, 0);
  assert.equal(manifest.anchors?.seatAnchors[0]?.id, "seat-a");
  assert.equal(manifest.mediaSurfaces?.[0]?.surfaceId, "debug-main");
  assert.equal(manifest.mediaSurfaces?.[0]?.manifestFormat, "f3");
  assert.equal(manifest.mediaSurfaces?.[0]?.yaw, -Math.PI / 2);
  assert.deepEqual(manifest.mediaSurfaces?.[0]?.pixelDimensions, { width: 1920, height: 1080 });
  assert.deepEqual(manifest.mediaSurfaces?.[0]?.input, { enabled: true, maxDistanceM: 0.05 });
  assert.equal(manifest.attributions?.[0]?.author, "Hansalex");
  assert.equal(manifest.attributions?.[0]?.changes, "Normalized to meters.");
  assert.equal(pickSceneSpawnPoint(manifest)?.id, "main");
  assert.equal(resolveSceneAssetUrl("https://example.com/scenes/hall/scene.json", manifest.glbPath), "https://example.com/scenes/hall/scene.glb");
});

test("resolveSceneAssetUrl supports non-gltf scene assets too", () => {
  assert.equal(
    resolveSceneAssetUrl("https://example.com/scenes/sense-hall2-v1/scene.json", "scene.fbx"),
    "https://example.com/scenes/sense-hall2-v1/scene.fbx"
  );
});

test("parseSceneBundleManifest rejects unknown schema version", () => {
  assert.throws(
    () => parseSceneBundleManifest({
      schemaVersion: 2,
      sceneId: "sense-hall",
      label: "Sense Hall",
      source: "sensetower",
      glbPath: "scene.glb",
      spawnPoints: []
    }),
    /unsupported_scene_bundle_schema/
  );
});

test("parseSceneBundleManifest rejects invalid spawn point payload", () => {
  assert.throws(
    () => parseSceneBundleManifest({
      schemaVersion: 1,
      sceneId: "sense-hall",
      label: "Sense Hall",
      source: "sensetower",
      glbPath: "scene.glb",
      spawnPoints: [{ id: "main", position: { x: 1, y: "bad", z: 0 } }]
    }),
    /invalid_scene_bundle_spawn_position/
  );
});

test("parseSceneBundleManifest rejects invalid spawn yaw", () => {
  assert.throws(
    () => parseSceneBundleManifest({
      schemaVersion: 1,
      sceneId: "sense-hall",
      label: "Sense Hall",
      source: "sensetower",
      glbPath: "scene.glb",
      spawnPoints: [{ id: "main", position: { x: 1, y: 0, z: 0 }, yaw: "bad" }]
    }),
    /invalid_scene_bundle_spawn_yaw/
  );
});

test("parseSceneBundleManifest rejects unknown render profile", () => {
  assert.throws(
    () => parseSceneBundleManifest({
      schemaVersion: 1,
      sceneId: "sense-hall",
      label: "Sense Hall",
      source: "sensetower",
      glbPath: "scene.glb",
      renderProfile: "cinematic",
      spawnPoints: [{ id: "main", position: { x: 1, y: 0, z: 0 } }]
    }),
    /invalid_scene_bundle_render_profile/
  );
});

test("parseSceneBundleManifest rejects invalid seat anchor payload", () => {
  assert.throws(
    () => parseSceneBundleManifest({
      schemaVersion: 1,
      sceneId: "sense-hall",
      label: "Sense Hall",
      source: "sensetower",
      glbPath: "scene.glb",
      spawnPoints: [],
      anchors: {
        seatAnchors: [{ id: "seat-a", position: { x: 0, y: 0, z: 0 }, yaw: 0, seatHeight: "bad" }]
      }
    }),
    /invalid_scene_bundle_seat_anchor_height/
  );
});

function manifestWithMediaSurfaces(mediaSurfaces: unknown) {
  return {
    schemaVersion: 1,
    sceneId: "sense-hall",
    label: "Sense Hall",
    source: "sensetower",
    glbPath: "scene.glb",
    spawnPoints: [],
    mediaSurfaces
  };
}

function validMediaSurface(overrides: Record<string, unknown> = {}) {
  return {
    surfaceId: "debug-main",
    representation: "platform-runtime-plane",
    position: { x: 0, y: 2, z: -4 },
    yaw: 0,
    widthM: 5.8,
    heightM: 3.3,
    pixelDimensions: { width: 1920, height: 1080 },
    frontFace: "local-positive-z",
    input: { enabled: true, maxDistanceM: 0.05 },
    ...overrides
  };
}

function validLegacyMediaSurface(overrides: Record<string, unknown> = {}) {
  return {
    surfaceId: "debug-main",
    label: "Legacy screen",
    kind: "wall",
    widthM: 3.2,
    heightM: 1.8,
    widthPx: 1920,
    heightPx: 1080,
    transform: { x: -3.4, y: 1.55, z: 0.15, yaw: Math.PI / 2, pitch: 0.1, roll: -0.2 },
    visible: false,
    allowedObjectTypes: ["screen-share"],
    ...overrides
  };
}

test("parseSceneBundleManifest rejects malformed and non-finite media surfaces", () => {
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([validMediaSurface({ widthM: 0 })])),
    /invalid_scene_bundle_media_surface_width_m/
  );
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([validMediaSurface({ position: { x: 0, y: Number.NaN, z: -4 } })])),
    /invalid_scene_bundle_media_surface_position/
  );
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([validMediaSurface({ yaw: Number.POSITIVE_INFINITY })])),
    /invalid_scene_bundle_media_surface_yaw/
  );
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([validMediaSurface({ pixelDimensions: { width: 1920.5, height: 1080 } })])),
    /invalid_scene_bundle_media_surface_pixel_dimensions/
  );
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([validMediaSurface({ input: { enabled: true, maxDistanceM: Number.NaN } })])),
    /invalid_scene_bundle_media_surface_input_max_distance_m/
  );
});

test("parseSceneBundleManifest rejects empty, duplicate, and missing-debug F3 media surface layouts", () => {
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([])),
    /invalid_scene_bundle_media_surfaces_empty/
  );
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([
      validMediaSurface(),
      validMediaSurface()
    ])),
    /duplicate_scene_bundle_media_surface_id/
  );
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([
      validMediaSurface({ surfaceId: "whiteboard-wall" })
    ])),
    /invalid_scene_bundle_media_surfaces_debug_main_count:0/
  );
});

test("parseSceneBundleManifest normalizes legacy v1 media surfaces without runtime logical ownership", () => {
  const manifest = parseSceneBundleManifest(manifestWithMediaSurfaces([
    validLegacyMediaSurface({ surfaceId: "legacy-wall" }),
    validLegacyMediaSurface({ surfaceId: "legacy-table", kind: "table", transform: { x: 1, y: 1, z: 2 } })
  ]));
  const surface = manifest.mediaSurfaces?.[0];

  assert.equal(surface?.manifestFormat, "legacy");
  assert.equal(surface?.label, "Legacy screen");
  assert.equal(surface?.kind, "wall");
  assert.deepEqual(surface?.position, { x: -3.4, y: 1.55, z: 0.15 });
  assert.equal(surface?.yaw, Math.PI / 2);
  assert.equal(surface?.pitch, 0.1);
  assert.equal(surface?.roll, -0.2);
  assert.equal(surface?.visible, false);
  assert.deepEqual(surface?.pixelDimensions, { width: 1920, height: 1080 });
  assert.deepEqual(surface?.input, { enabled: true, maxDistanceM: 0.06 });
  assert.deepEqual(surface?.legacyAllowedObjectTypes, ["screen-share"]);
  assert.deepEqual(manifest.mediaSurfaces?.map((entry) => entry.surfaceId), ["legacy-wall", "legacy-table"]);
});

test("parseSceneBundleManifest rejects mixed F3 and legacy media surface arrays deterministically", () => {
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([
      validMediaSurface(),
      validLegacyMediaSurface({ surfaceId: "legacy-wall" })
    ])),
    /invalid_scene_bundle_media_surfaces_mixed_formats/
  );
});

test("parseSceneBundleManifest still rejects duplicate ids in all-legacy arrays", () => {
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([
      validLegacyMediaSurface({ surfaceId: "legacy-wall" }),
      validLegacyMediaSurface({ surfaceId: "legacy-wall" })
    ])),
    /duplicate_scene_bundle_media_surface_id/
  );
});

test("parseSceneBundleManifest rejects malformed legacy v1 media surfaces", () => {
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([validLegacyMediaSurface({ transform: { x: 0, y: "bad", z: 0 } })])),
    /invalid_scene_bundle_media_surface_transform/
  );
  assert.throws(
    () => parseSceneBundleManifest(manifestWithMediaSurfaces([validLegacyMediaSurface({ allowedObjectTypes: [""] })])),
    /invalid_scene_bundle_media_surface_allowed_object_type/
  );
});

test("parseSceneBundleManifest applies equal F3 and legacy pixel budgets", () => {
  const f3Boundary = parseSceneBundleManifest(manifestWithMediaSurfaces([
    validMediaSurface({ pixelDimensions: { width: 8192, height: 4096 } })
  ]));
  const legacyBoundary = parseSceneBundleManifest(manifestWithMediaSurfaces([
    validLegacyMediaSurface({ widthPx: 8192, heightPx: 4096 })
  ]));
  assert.deepEqual(f3Boundary.mediaSurfaces?.[0]?.pixelDimensions, { width: 8192, height: 4096 });
  assert.deepEqual(legacyBoundary.mediaSurfaces?.[0]?.pixelDimensions, { width: 8192, height: 4096 });

  for (const mediaSurface of [
    validMediaSurface({ pixelDimensions: { width: 8193, height: 1 } }),
    validMediaSurface({ pixelDimensions: { width: 8192, height: 4097 } }),
    validLegacyMediaSurface({ widthPx: 8193, heightPx: 1 }),
    validLegacyMediaSurface({ widthPx: 8192, heightPx: 4097 })
  ]) {
    assert.throws(
      () => parseSceneBundleManifest(manifestWithMediaSurfaces([mediaSurface])),
      /invalid_scene_bundle_media_surface_(?:pixel_dimensions|width_px)/
    );
  }
});

test("parseSceneBundleManifest keeps media surfaces optional for fallback compatibility", () => {
  const manifest = parseSceneBundleManifest({
    schemaVersion: 1,
    sceneId: "sense-hall",
    label: "Sense Hall",
    source: "sensetower",
    glbPath: "scene.glb",
    spawnPoints: []
  });

  assert.equal(manifest.mediaSurfaces, undefined);
});

test("parseSceneBundleManifest rejects invalid attribution payload", () => {
  assert.throws(
    () => parseSceneBundleManifest({
      schemaVersion: 1,
      sceneId: "sense-hall",
      label: "Sense Hall",
      source: "sensetower",
      glbPath: "scene.glb",
      spawnPoints: [],
      attributions: [{ title: "Room", author: "Author", source: "https://example.test" }]
    }),
    /invalid_scene_bundle_attribution_license/
  );
});

test("parseSceneBundleManifest rejects unsafe attribution URLs", () => {
  const manifest = (attribution: Record<string, unknown>) => ({
    schemaVersion: 1,
    sceneId: "sense-hall",
    label: "Sense Hall",
    source: "sensetower",
    glbPath: "scene.glb",
    spawnPoints: [],
    attributions: [{
      title: "Room",
      author: "Author",
      source: "https://example.test/source",
      license: "CC-BY-4.0",
      ...attribution
    }]
  });

  assert.throws(
    () => parseSceneBundleManifest(manifest({ source: "javascript:alert(1)" })),
    /invalid_scene_bundle_attribution_source/
  );
  assert.throws(
    () => parseSceneBundleManifest(manifest({ authorUrl: "data:text/html,unsafe" })),
    /invalid_scene_bundle_attribution_author_url/
  );
  assert.throws(
    () => parseSceneBundleManifest(manifest({ licenseUrl: "mailto:license@example.test" })),
    /invalid_scene_bundle_attribution_license_url/
  );
});
