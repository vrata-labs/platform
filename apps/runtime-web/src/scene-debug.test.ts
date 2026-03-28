import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createEmptySceneDiagnostics, inspectSceneObject } from "./scene-debug.js";

test("inspectSceneObject reports mesh and bounds stats", () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(2, 4, 6),
    new THREE.MeshStandardMaterial({ color: 0xffaa00 })
  );
  mesh.position.set(1, 2, 3);
  root.add(mesh);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  camera.position.set(0, 1.6, 8);
  camera.lookAt(new THREE.Vector3(0, 1.6, 0));
  camera.updateMatrixWorld();
  root.updateMatrixWorld(true);

  const diagnostics = inspectSceneObject({
    root,
    camera,
    previous: {
      ...createEmptySceneDiagnostics(),
      state: "loaded",
      bundleUrl: "/assets/scenes/test/scene.json"
    }
  });

  assert.equal(diagnostics.meshCount, 1);
  assert.equal(diagnostics.materialCount, 1);
  assert.equal(diagnostics.geometryCount, 1);
  assert.equal(diagnostics.textureCount, 0);
  assert.equal(diagnostics.boundingBox?.center.x, 1);
  assert.equal(diagnostics.boundingBox?.center.y, 2);
  assert.equal(diagnostics.boundingBox?.center.z, 3);
  assert.equal(diagnostics.boundingBox?.size.x, 2);
  assert.equal(diagnostics.boundingBox?.size.y, 4);
  assert.equal(diagnostics.boundingBox?.size.z, 6);
  assert.equal(diagnostics.camera?.world.z, 8);
});
