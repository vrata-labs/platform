import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { applyBakedLightMaps } from "./scene-lightmaps.js";

test("moves exported baked irradiance from emissiveMap to lightMap", () => {
  const lightMap = new THREE.Texture();
  lightMap.channel = 1;
  const material = new THREE.MeshStandardMaterial();
  material.name = "baked-wall";
  material.emissiveMap = lightMap;
  material.userData = {
    vrataLightMap: true,
    vrataLightMapIntensity: 4,
    vrataOriginalEmissive: [0.2, 0.3, 0.4],
    vrataOriginalEmissiveIntensity: 1.5
  };
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute("uv1", geometry.getAttribute("uv"));
  root.add(new THREE.Mesh(geometry, material));

  assert.equal(applyBakedLightMaps(root), 1);
  assert.equal(material.lightMap, lightMap);
  assert.equal(material.lightMapIntensity, 4);
  assert.equal(material.emissiveMap, null);
  assert.deepEqual(material.emissive.toArray(), [0.2, 0.3, 0.4]);
  assert.equal(material.emissiveIntensity, 1.5);
});

test("rejects a baked lightmap without the second UV channel", () => {
  const lightMap = new THREE.Texture();
  lightMap.channel = 1;
  const material = new THREE.MeshStandardMaterial();
  material.name = "invalid-wall";
  material.emissiveMap = lightMap;
  material.userData = { vrataLightMap: true };
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  mesh.name = "wall-without-lightmap-uv";
  root.add(mesh);

  assert.throws(() => applyBakedLightMaps(root), /missing_baked_lightmap_uv:wall-without-lightmap-uv/);
});

test("rejects baked metadata without a lightmap texture on channel one", () => {
  const material = new THREE.MeshStandardMaterial();
  material.name = "invalid-wall";
  material.emissiveMap = new THREE.Texture();
  material.userData = { vrataLightMap: true };
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute("uv1", geometry.getAttribute("uv"));
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, material));

  assert.throws(() => applyBakedLightMaps(root), /invalid_baked_lightmap_material:invalid-wall/);
});

test("validates every mesh before mutating a shared baked material", () => {
  const lightMap = new THREE.Texture();
  lightMap.channel = 1;
  const material = new THREE.MeshStandardMaterial();
  material.emissiveMap = lightMap;
  material.userData = { vrataLightMap: true };
  const validGeometry = new THREE.BoxGeometry();
  validGeometry.setAttribute("uv1", validGeometry.getAttribute("uv"));
  const invalidMesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  invalidMesh.name = "shared-material-without-uv1";
  const root = new THREE.Group();
  root.add(new THREE.Mesh(validGeometry, material), invalidMesh);

  assert.throws(() => applyBakedLightMaps(root), /missing_baked_lightmap_uv:shared-material-without-uv1/);
  assert.equal(material.lightMap, null);
  assert.equal(material.emissiveMap, lightMap);
});

test("converts a shared baked material once when every mesh has uv1", () => {
  const lightMap = new THREE.Texture();
  lightMap.channel = 1;
  const material = new THREE.MeshStandardMaterial();
  material.emissiveMap = lightMap;
  material.userData = { vrataLightMap: true };
  const root = new THREE.Group();
  for (let index = 0; index < 2; index += 1) {
    const geometry = new THREE.BoxGeometry();
    geometry.setAttribute("uv1", geometry.getAttribute("uv"));
    root.add(new THREE.Mesh(geometry, material));
  }

  assert.equal(applyBakedLightMaps(root), 1);
  assert.equal(material.lightMap, lightMap);
});
