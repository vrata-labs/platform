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
        position: { x: 1, y: 0, z: -2 }
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
    bounds: { width: 20, height: 8, depth: 20 },
    preview: "preview.jpg"
  });

  assert.equal(manifest.sceneId, "sense-hall");
  assert.equal(manifest.renderMode, "clean");
  assert.equal(manifest.materialOverrides?.[0]?.match, "chairs*");
  assert.equal(manifest.anchors?.teleportFloorY, 0);
  assert.equal(manifest.anchors?.seatAnchors[0]?.id, "seat-a");
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
