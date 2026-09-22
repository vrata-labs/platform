import assert from "node:assert/strict";
import test from "node:test";
import type { RoomTemplateSurface } from "@vrata/shared-types";
import { parseSceneBundleManifest } from "./scene-bundle.js";
import { assertTemplateSceneSurfaces } from "./template-layout.js";

const required: RoomTemplateSurface[] = [{ surfaceId: "workspace-main", label: "Workspace", purpose: "workspace", allowedObjectTypes: ["markdown-board"], aspectRatio: { width: 16, height: 9, maxRelativeError: .02 } }];
const physical = parseSceneBundleManifest({ schemaVersion: 1, sceneId: "test", label: "Test", source: "fixture", glbPath: "scene.glb", spawnPoints: [{ id: "main", position: { x: 0, y: 0, z: 0 } }], mediaSurfaces: [{ surfaceId: "workspace-main", kind: "wall", widthM: 1.6, heightM: .9, transform: { x: 0, y: 1, z: 0, yaw: 0 }, visible: true }] }).mediaSurfaces!;

test("template/scene matching requires exact visible physical IDs and preserves their transforms", () => {
  const original = structuredClone(physical);
  assertTemplateSceneSurfaces(required, physical);
  assert.deepEqual(physical, original);
  assert.throws(() => assertTemplateSceneSurfaces(required, []), /missing_template_surface/);
  assert.throws(() => assertTemplateSceneSurfaces(required, [...physical, ...physical]), /duplicate_template_surface/);
  assert.throws(() => assertTemplateSceneSurfaces(required, [{ ...physical[0]!, visible: false }]), /missing_template_surface/);
  assert.throws(() => assertTemplateSceneSurfaces(required, [{ ...physical[0]!, heightM: 3 }]), /template_surface_aspect_mismatch/);
});
