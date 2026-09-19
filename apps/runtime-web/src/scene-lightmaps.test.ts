import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { applyBakedLightMaps, getBakedEnvironmentMode } from "./scene-lightmaps.js";

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

function bakedFixture(includesEnvironment?: unknown) {
  const material = new THREE.MeshStandardMaterial();
  material.name = "baked-fixture";
  material.emissiveMap = new THREE.Texture();
  material.emissiveMap.channel = 1;
  material.userData = { vrataLightMap: true, vrataLightMapIncludesEnvironment: includesEnvironment };
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute("uv1", geometry.getAttribute("uv"));
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, material));
  return { material, root };
}

function shaderFixture(fragmentShader = THREE.ShaderLib.standard.fragmentShader) {
  return { fragmentShader, vertexShader: THREE.ShaderLib.standard.vertexShader, uniforms: {} } as Parameters<THREE.Material["onBeforeCompile"]>[0];
}

test("complete irradiance atlases retain IBL specular without adding IBL diffuse twice", () => {
  const { material, root } = bakedFixture(true);
  let customHookCalls = 0;
  material.onBeforeCompile = (shader) => { customHookCalls += 1; shader.fragmentShader += "\n// custom hook"; };
  material.customProgramCacheKey = () => "custom-material-key";
  applyBakedLightMaps(root);
  assert.equal(getBakedEnvironmentMode(material), "pending-compile");
  assert.match(material.customProgramCacheKey(), /^custom-material-key:vrata-baked-environment-v1$/);
  const shader = shaderFixture();
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  assert.equal(customHookCalls, 1);
  assert.equal(getBakedEnvironmentMode(material), "specular-only");
  assert.doesNotMatch(shader.fragmentShader, /reflectedLight\.indirectDiffuse \+= diffuse \* cosineWeightedIrradiance;/);
  assert.match(shader.fragmentShader, /reflectedLight\.indirectDiffuse \+= irradiance \* BRDF_Lambert/);
  assert.match(shader.fragmentShader, /reflectedLight\.indirectSpecular \+= radiance \* singleScattering/);
  assert.match(shader.fragmentShader, /reflectedLight\.indirectSpecular \+= multiScattering \* cosineWeightedIrradiance/);
  assert.match(shader.fragmentShader, /custom hook/);
  assert.match(THREE.ShaderChunk.lights_physical_pars_fragment, /reflectedLight\.indirectDiffuse \+= diffuse \* cosineWeightedIrradiance;/);
});

test("legacy/explicit-false atlases keep their original shader hooks and program keys", () => {
  for (const flag of [undefined, false]) {
    const { material, root } = bakedFixture(flag);
    const hook = material.onBeforeCompile;
    const key = material.customProgramCacheKey;
    applyBakedLightMaps(root);
    assert.equal(material.onBeforeCompile, hook);
    assert.equal(material.customProgramCacheKey, key);
    assert.equal(getBakedEnvironmentMode(material), "legacy");
  }
});

test("invalid environment metadata rejects before changing any material", () => {
  const good = bakedFixture(true);
  const bad = bakedFixture("true");
  good.root.add(bad.root);
  assert.throws(() => applyBakedLightMaps(good.root), /invalid_baked_environment_metadata:baked-fixture/);
  assert.equal(good.material.lightMap, null);
  assert.ok(good.material.emissiveMap);
});

test("custom shaders without the physical include remain usable and report fallback", () => {
  const { material, root } = bakedFixture(true);
  material.onBeforeCompile = (shader) => { shader.fragmentShader = "void main() { gl_FragColor = vec4(1.0); }"; };
  applyBakedLightMaps(root);
  const shader = shaderFixture();
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  assert.equal(shader.fragmentShader, "void main() { gl_FragColor = vec4(1.0); }");
  assert.equal(getBakedEnvironmentMode(material), "fallback");
});

test("an unsupported physical shader rejects during loading before material mutation", () => {
  const { material, root } = bakedFixture(true);
  const original = THREE.ShaderChunk.lights_physical_pars_fragment;
  try {
    THREE.ShaderChunk.lights_physical_pars_fragment = "// incompatible shader revision";
    assert.throws(() => applyBakedLightMaps(root), /unsupported_baked_environment_shader/);
    assert.equal(material.lightMap, null);
    assert.ok(material.emissiveMap);
  } finally {
    THREE.ShaderChunk.lights_physical_pars_fragment = original;
  }
});
