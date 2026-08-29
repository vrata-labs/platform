import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { disposeSceneObject } from "./scene-dispose.js";

test("disposeSceneObject detaches a root and disposes shared resources once", () => {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const lineGeometry = new THREE.BufferGeometry();
  const uniformTexture = new THREE.Texture();
  const shaderMaterial = new THREE.ShaderMaterial({
    uniforms: { diffuseMap: { value: uniformTexture } }
  });
  let geometryDisposals = 0;
  let materialDisposals = 0;
  let textureDisposals = 0;
  let lineGeometryDisposals = 0;
  let shaderMaterialDisposals = 0;
  let uniformTextureDisposals = 0;
  geometry.addEventListener("dispose", () => geometryDisposals += 1);
  material.addEventListener("dispose", () => materialDisposals += 1);
  texture.addEventListener("dispose", () => textureDisposals += 1);
  lineGeometry.addEventListener("dispose", () => lineGeometryDisposals += 1);
  shaderMaterial.addEventListener("dispose", () => shaderMaterialDisposals += 1);
  uniformTexture.addEventListener("dispose", () => uniformTextureDisposals += 1);
  root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  root.add(new THREE.Line(lineGeometry, shaderMaterial));
  scene.add(root);

  disposeSceneObject(root);

  assert.equal(root.parent, null);
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(textureDisposals, 1);
  assert.equal(lineGeometryDisposals, 1);
  assert.equal(shaderMaterialDisposals, 1);
  assert.equal(uniformTextureDisposals, 1);
});
