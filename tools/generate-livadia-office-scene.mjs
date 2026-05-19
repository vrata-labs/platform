#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromRuntime = createRequire(new URL("../apps/runtime-web/package.json", import.meta.url));
const THREE = await import(requireFromRuntime.resolve("three"));
const { GLTFExporter } = await import(requireFromRuntime.resolve("three/examples/jsm/exporters/GLTFExporter.js"));

if (!globalThis.FileReader) {
  globalThis.FileReader = class NodeFileReader {
    result = null;
    onloadend = null;

    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = buffer;
        this.onloadend?.();
      });
    }

    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onloadend?.();
      });
    }
  };
}

const sceneId = "livadia-nicholas-office-v1";
const outputDir = fileURLToPath(new URL(`../apps/runtime-web/public/assets/scenes/${sceneId}/`, import.meta.url));

function material(name, color, options = {}) {
  const result = new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.72,
    metalness: options.metalness ?? 0,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0
  });
  result.name = name;
  return result;
}

function basicMaterial(name, color) {
  const result = new THREE.MeshBasicMaterial({ color });
  result.name = name;
  return result;
}

const mats = {
  wall: material("livadia-wall-warm-ivory-plaster", 0xf0e2c4, { roughness: 0.9, emissive: 0xf0e2c4, emissiveIntensity: 0.1 }),
  wallShadow: material("livadia-wall-recessed-cream-panel", 0xe2d0ad, { roughness: 0.9, emissive: 0xe2d0ad, emissiveIntensity: 0.08 }),
  oak: material("livadia-parquet-golden-oak", 0xc78944, { roughness: 0.64, emissive: 0x8c5f2d, emissiveIntensity: 0.07 }),
  oakLight: material("livadia-parquet-honey-oak", 0xe1af63, { roughness: 0.66, emissive: 0xa57535, emissiveIntensity: 0.08 }),
  walnut: material("livadia-carved-dark-walnut", 0x67391f, { roughness: 0.58, emissive: 0x2a150a, emissiveIntensity: 0.08 }),
  walnutLight: material("livadia-polished-mahogany", 0x88482a, { roughness: 0.52, emissive: 0x35190d, emissiveIntensity: 0.08 }),
  leather: material("livadia-desk-green-leather", 0x21543d, { roughness: 0.48, emissive: 0x0b1d15, emissiveIntensity: 0.08 }),
  velvet: material("livadia-chair-olive-velvet", 0x42582f, { roughness: 0.82, emissive: 0x12190d, emissiveIntensity: 0.08 }),
  burgundy: material("livadia-curtain-deep-burgundy", 0x7a3140, { roughness: 0.86, emissive: 0x22080d, emissiveIntensity: 0.07 }),
  rugRed: material("livadia-rug-crimson-field", 0xa83a45, { roughness: 0.86, emissive: 0x2a080c, emissiveIntensity: 0.08 }),
  rugBlue: material("livadia-rug-navy-border", 0x1e3856, { roughness: 0.86 }),
  rugGold: material("livadia-rug-gold-ornament", 0xc99b49, { roughness: 0.78 }),
  brass: material("livadia-aged-brass-metal", 0xd2a142, { metalness: 0.72, roughness: 0.34 }),
  marble: material("livadia-warm-white-marble", 0xf6efe1, { roughness: 0.45, emissive: 0xf6efe1, emissiveIntensity: 0.05 }),
  soot: material("livadia-fireplace-dark-soot", 0x17120f, { roughness: 0.94 }),
  paper: material("livadia-aged-paper", 0xf8e9bf, { roughness: 0.88, emissive: 0xf8e9bf, emissiveIntensity: 0.05 }),
  ink: material("livadia-inkwell-black-glass", 0x11151a, { roughness: 0.28, metalness: 0.08 }),
  porcelain: material("livadia-cream-porcelain-shade", 0xf3dfbf, { roughness: 0.42, emissive: 0xffd18a, emissiveIntensity: 0.16 }),
  lampGlow: material("livadia-warm-lamp-glow", 0xffd786, { roughness: 0.35, emissive: 0xffc76d, emissiveIntensity: 1.6 }),
  glassBlue: material("livadia-window-daylight-blue-glass", 0x8cc8e8, { roughness: 0.18, metalness: 0 }),
  sky: basicMaterial("livadia-window-crimean-sky", 0x98d7f1),
  sea: basicMaterial("livadia-window-black-sea-blue", 0x286f9d),
  mountain: basicMaterial("livadia-window-crimean-mountain-silhouette", 0x7c9174),
  bookRed: material("livadia-book-spine-red", 0x963d34, { roughness: 0.78 }),
  bookGreen: material("livadia-book-spine-green", 0x305235, { roughness: 0.78 }),
  bookBlue: material("livadia-book-spine-blue", 0x244965, { roughness: 0.78 }),
  bookTan: material("livadia-book-spine-tan", 0xa97b45, { roughness: 0.78 }),
  portrait: material("livadia-painted-portrait-muted-canvas", 0x6b5a47, { roughness: 0.92 }),
  mapGreen: material("livadia-crimea-map-green-ink", 0x4f7145, { roughness: 0.85 }),
  mapBlue: material("livadia-crimea-map-blue-water", 0x47779b, { roughness: 0.85 })
};

const scene = new THREE.Scene();
scene.name = `${sceneId}-export-scene`;

const root = new THREE.Group();
root.name = `${sceneId}-root`;
scene.add(root);

function addBox(name, size, position, mat, rotation = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  root.add(mesh);
  return mesh;
}

function addCylinder(name, radiusTop, radiusBottom, height, position, mat, radialSegments = 20, rotation = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments), mat);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  root.add(mesh);
  return mesh;
}

function addSphere(name, radius, position, mat, widthSegments = 16, heightSegments = 10) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, widthSegments, heightSegments), mat);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  root.add(mesh);
  return mesh;
}

function addCone(name, radius, height, position, mat, radialSegments = 20, rotation = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(radius, height, radialSegments), mat);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  root.add(mesh);
  return mesh;
}

function addLight(name, color, intensity, distance, position) {
  const light = new THREE.PointLight(color, intensity, distance, 2);
  light.name = name;
  light.position.set(position[0], position[1], position[2]);
  root.add(light);
}

function addChair(prefix, x, z, yaw, mat = mats.velvet) {
  const group = new THREE.Group();
  group.name = `${prefix}-group`;
  group.position.set(x, 0, z);
  group.rotation.y = yaw;
  root.add(group);

  function chairBox(name, size, position, materialRef, rotation = [0, 0, 0]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), materialRef);
    mesh.name = `${prefix}-${name}`;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    group.add(mesh);
  }

  chairBox("seat-cushion", [0.72, 0.16, 0.66], [0, 0.45, 0], mat);
  chairBox("front-rail", [0.78, 0.08, 0.08], [0, 0.38, -0.35], mats.walnut);
  chairBox("back-rail", [0.78, 0.08, 0.08], [0, 0.38, 0.35], mats.walnut);
  chairBox("left-arm", [0.08, 0.42, 0.68], [-0.45, 0.63, 0], mats.walnut);
  chairBox("right-arm", [0.08, 0.42, 0.68], [0.45, 0.63, 0], mats.walnut);
  chairBox("tall-back", [0.86, 1.08, 0.12], [0, 1.04, 0.43], mat, [-0.08, 0, 0]);
  chairBox("back-crown", [0.96, 0.12, 0.14], [0, 1.62, 0.39], mats.brass);
  for (const lx of [-0.28, 0.28]) {
    for (const lz of [-0.24, 0.24]) {
      chairBox(`leg-${lx}-${lz}`, [0.08, 0.42, 0.08], [lx, 0.2, lz], mats.walnut);
    }
  }
}

function addBookcase(prefix, x, z, widthZ) {
  addBox(`${prefix}-case-back`, [0.34, 2.7, widthZ], [x, 1.35, z], mats.walnut);
  addBox(`${prefix}-case-top`, [0.48, 0.12, widthZ + 0.16], [x + 0.04, 2.74, z], mats.walnutLight);
  addBox(`${prefix}-case-base`, [0.5, 0.16, widthZ + 0.18], [x + 0.04, 0.12, z], mats.walnutLight);
  for (const y of [0.72, 1.28, 1.86, 2.42]) {
    addBox(`${prefix}-shelf-${y}`, [0.48, 0.07, widthZ + 0.08], [x + 0.04, y, z], mats.walnutLight);
  }
  const bookMats = [mats.bookRed, mats.bookGreen, mats.bookBlue, mats.bookTan];
  let index = 0;
  for (const y of [0.46, 1.02, 1.6, 2.16]) {
    for (let i = 0; i < 8; i += 1) {
      const zOffset = -widthZ / 2 + 0.28 + i * (widthZ - 0.56) / 7;
      const h = 0.34 + ((i + Math.floor(y * 10)) % 4) * 0.04;
      const w = 0.07 + (i % 3) * 0.02;
      addBox(`${prefix}-book-${index}`, [0.16, h, w], [x + 0.25, y + h / 2, z + zOffset], bookMats[index % bookMats.length]);
      index += 1;
    }
  }
}

// Architectural shell: compact, room-scale, readable from the main spawn.
addBox("livadia-floor-structural-slab", [10.4, 0.08, 8.4], [0, -0.04, 0], mats.oak);
for (let i = 0; i < 18; i += 1) {
  const z = -3.95 + i * 0.46;
  addBox(`livadia-parquet-long-plank-${i}`, [9.85, 0.024, 0.22], [0, 0.018, z], i % 2 === 0 ? mats.oakLight : mats.oak);
}
addBox("livadia-back-wall", [10.5, 4.15, 0.12], [0, 2.075, -4.25], mats.wall);
addBox("livadia-front-wall-left", [3.65, 4.15, 0.12], [-3.43, 2.075, 4.25], mats.wall);
addBox("livadia-front-wall-right", [3.65, 4.15, 0.12], [3.43, 2.075, 4.25], mats.wall);
addBox("livadia-front-door-lintel", [3.2, 1.15, 0.12], [0, 3.575, 4.25], mats.wall);
addBox("livadia-left-wall", [0.12, 4.15, 8.5], [-5.25, 2.075, 0], mats.wall);
addBox("livadia-right-wall", [0.12, 4.15, 8.5], [5.25, 2.075, 0], mats.wall);
addBox("livadia-coffered-ceiling-main", [10.5, 0.12, 8.5], [0, 4.16, 0], mats.wallShadow);
for (const x of [-4.8, 4.8]) addBox(`livadia-ceiling-long-cove-${x}`, [0.18, 0.18, 8.25], [x, 4.05, 0], mats.walnutLight);
for (const z of [-3.98, 3.98]) addBox(`livadia-ceiling-cross-cove-${z}`, [10.1, 0.18, 0.18], [0, 4.05, z], mats.walnutLight);
for (const z of [-2.4, 0, 2.4]) addBox(`livadia-ceiling-inner-beam-${z}`, [8.0, 0.12, 0.12], [0, 4.0, z], mats.brass);

// Wall panels and trim.
for (const x of [-4.1, -2.05, 2.05, 4.1]) {
  addBox(`livadia-back-panel-${x}`, [1.42, 1.38, 0.05], [x, 1.35, -4.18], mats.wallShadow);
  addBox(`livadia-back-panel-gold-top-${x}`, [1.52, 0.05, 0.07], [x, 2.08, -4.12], mats.brass);
  addBox(`livadia-back-panel-gold-bottom-${x}`, [1.52, 0.05, 0.07], [x, 0.62, -4.12], mats.brass);
}
for (const z of [-3.05, -1.25, 0.55, 2.35]) {
  addBox(`livadia-left-wainscot-panel-${z}`, [0.05, 1.08, 1.34], [-5.18, 1.02, z], mats.wallShadow);
  addBox(`livadia-right-wainscot-panel-${z}`, [0.05, 1.08, 1.34], [5.18, 1.02, z], mats.wallShadow);
}
addBox("livadia-front-double-door", [2.6, 2.78, 0.08], [0, 1.39, 4.18], mats.walnut);
addBox("livadia-front-door-brass-split", [0.05, 2.45, 0.1], [0, 1.34, 4.1], mats.brass);
addBox("livadia-front-door-top-arch", [2.82, 0.08, 0.1], [0, 2.83, 4.1], mats.brass);

// Windows toward the Crimean coast, built as layered geometry rather than external images.
for (const [index, x] of [-2.9, 0, 2.9].entries()) {
  addBox(`livadia-window-sky-${index}`, [1.42, 1.0, 0.04], [x, 2.48, -4.08], mats.sky);
  addBox(`livadia-window-sea-${index}`, [1.42, 0.55, 0.045], [x, 1.72, -4.075], mats.sea);
  addBox(`livadia-window-mountain-${index}`, [1.25, 0.22, 0.05], [x, 1.96, -4.06], mats.mountain);
  addBox(`livadia-window-glass-${index}`, [1.52, 1.86, 0.035], [x, 2.12, -4.035], mats.glassBlue);
  addBox(`livadia-window-frame-left-${index}`, [0.07, 1.98, 0.08], [x - 0.82, 2.12, -3.98], mats.walnutLight);
  addBox(`livadia-window-frame-right-${index}`, [0.07, 1.98, 0.08], [x + 0.82, 2.12, -3.98], mats.walnutLight);
  addBox(`livadia-window-frame-cross-${index}`, [1.64, 0.07, 0.08], [x, 2.12, -3.98], mats.walnutLight);
  addBox(`livadia-window-frame-top-${index}`, [1.7, 0.08, 0.08], [x, 3.13, -3.98], mats.walnutLight);
  addBox(`livadia-window-frame-bottom-${index}`, [1.7, 0.08, 0.08], [x, 1.1, -3.98], mats.walnutLight);
  addBox(`livadia-curtain-left-${index}`, [0.18, 2.16, 0.16], [x - 1.0, 2.07, -3.88], mats.burgundy);
  addBox(`livadia-curtain-right-${index}`, [0.18, 2.16, 0.16], [x + 1.0, 2.07, -3.88], mats.burgundy);
}
addCylinder("livadia-brass-curtain-rod", 0.04, 0.04, 8.2, [0, 3.32, -3.88], mats.brass, 16, [0, 0, Math.PI / 2]);

// Central rug with legible ornamentation.
addBox("livadia-rug-main-crimson", [4.8, 0.035, 2.85], [0, 0.05, 0.78], mats.rugRed);
addBox("livadia-rug-navy-border-front", [4.8, 0.045, 0.22], [0, 0.075, 2.1], mats.rugBlue);
addBox("livadia-rug-navy-border-back", [4.8, 0.045, 0.22], [0, 0.075, -0.54], mats.rugBlue);
addBox("livadia-rug-navy-border-left", [0.22, 0.045, 2.85], [-2.29, 0.075, 0.78], mats.rugBlue);
addBox("livadia-rug-navy-border-right", [0.22, 0.045, 2.85], [2.29, 0.075, 0.78], mats.rugBlue);
for (const x of [-1.35, 0, 1.35]) addBox(`livadia-rug-gold-medallion-${x}`, [0.56, 0.055, 0.28], [x, 0.105, 0.78], mats.rugGold);

// Writing desk and Nicholas II study objects.
addBox("livadia-imperial-writing-desk-top", [2.55, 0.18, 1.18], [0, 0.86, -1.05], mats.walnutLight);
addBox("livadia-imperial-writing-desk-green-leather-inlay", [2.14, 0.035, 0.82], [0, 0.975, -1.05], mats.leather);
addBox("livadia-desk-front-modesty-panel", [2.45, 0.66, 0.12], [0, 0.52, -0.43], mats.walnut);
for (const x of [-1.05, -0.35, 0.35, 1.05]) {
  addBox(`livadia-desk-drawer-${x}`, [0.48, 0.22, 0.08], [x, 0.66, -0.36], mats.walnutLight);
  addCylinder(`livadia-desk-brass-handle-${x}`, 0.035, 0.035, 0.28, [x, 0.66, -0.3], mats.brass, 12, [Math.PI / 2, 0, 0]);
}
for (const x of [-1.1, 1.1]) for (const z of [-1.45, -0.65]) addBox(`livadia-desk-carved-leg-${x}-${z}`, [0.18, 0.72, 0.18], [x, 0.43, z], mats.walnut);
addBox("livadia-desk-paper-stack", [0.46, 0.035, 0.32], [-0.64, 1.02, -0.86], mats.paper, [0, 0.18, 0]);
addBox("livadia-desk-crimea-map-paper", [0.72, 0.025, 0.52], [0.28, 1.025, -1.05], mats.paper, [0, -0.12, 0]);
addBox("livadia-desk-map-sea-mark", [0.22, 0.03, 0.1], [0.08, 1.05, -1.0], mats.mapBlue, [0, -0.12, 0]);
addBox("livadia-desk-map-land-mark", [0.24, 0.03, 0.16], [0.34, 1.052, -1.13], mats.mapGreen, [0, -0.12, 0]);
addCylinder("livadia-desk-inkwell", 0.08, 0.1, 0.12, [-0.95, 1.05, -1.22], mats.ink, 18);
addCylinder("livadia-desk-brass-lamp-stem", 0.035, 0.035, 0.64, [0.95, 1.32, -1.08], mats.brass, 14);
addCone("livadia-desk-lamp-shade", 0.24, 0.32, [0.95, 1.72, -1.08], mats.porcelain, 24);
addSphere("livadia-desk-lamp-bulb", 0.1, [0.95, 1.48, -1.08], mats.lampGlow, 18, 12);
addLight("livadia-desk-warm-point-light", 0xffd6a0, 5, 6, [0.95, 1.5, -1.08]);

addChair("livadia-desk-chair", 0, -2.2, Math.PI, mats.velvet);
addChair("livadia-guest-chair-left", -0.9, 0.55, 0, mats.velvet);
addChair("livadia-guest-chair-right", 0.9, 0.55, 0, mats.velvet);
addChair("livadia-fireplace-armchair", 3.62, 1.25, Math.PI / 2, mats.burgundy);

// Side sofa with two usable seats.
addBox("livadia-left-sofa-seat", [0.9, 0.2, 1.72], [-4.15, 0.46, 1.72], mats.velvet);
addBox("livadia-left-sofa-back", [0.16, 1.0, 1.82], [-4.62, 0.92, 1.72], mats.velvet);
addBox("livadia-left-sofa-front-rail", [0.14, 0.34, 1.88], [-3.68, 0.5, 1.72], mats.walnut);
addBox("livadia-left-sofa-top-rail", [0.18, 0.12, 1.94], [-4.58, 1.48, 1.72], mats.brass);
for (const z of [0.98, 2.46]) addBox(`livadia-left-sofa-side-${z}`, [0.88, 0.62, 0.14], [-4.15, 0.7, z], mats.walnut);

// Book walls and fireplace lounge.
addBookcase("livadia-left-bookcase", -5.02, -1.4, 3.8);
addBookcase("livadia-right-bookcase", 5.02, -1.55, 3.2);
addBox("livadia-fireplace-marble-hearth", [1.5, 0.22, 0.42], [4.47, 0.12, 2.76], mats.marble);
addBox("livadia-fireplace-marble-surround", [0.42, 1.38, 1.45], [5.03, 0.82, 2.76], mats.marble);
addBox("livadia-fireplace-soot-opening", [0.08, 0.72, 0.78], [4.78, 0.72, 2.76], mats.soot);
addBox("livadia-fireplace-mantel", [0.6, 0.16, 1.78], [4.76, 1.58, 2.76], mats.marble);
addCylinder("livadia-mantel-clock-body", 0.18, 0.18, 0.16, [4.4, 1.78, 2.76], mats.brass, 24, [0, 0, Math.PI / 2]);
addBox("livadia-mantel-clock-face", [0.035, 0.22, 0.22], [4.27, 1.78, 2.76], mats.paper);

// Portraits, map board, bust, and period details.
addBox("livadia-portrait-frame-left", [0.08, 1.05, 0.86], [-5.17, 2.55, 2.95], mats.brass);
addBox("livadia-portrait-canvas-left", [0.06, 0.82, 0.62], [-5.12, 2.55, 2.95], mats.portrait);
addBox("livadia-wall-map-board-frame", [0.08, 1.04, 1.42], [5.16, 2.54, 2.2], mats.walnutLight);
addBox("livadia-wall-map-board-paper", [0.06, 0.82, 1.16], [5.11, 2.54, 2.2], mats.paper);
addBox("livadia-wall-map-green-coast", [0.065, 0.18, 0.52], [5.06, 2.55, 2.12], mats.mapGreen);
addBox("livadia-wall-map-blue-sea", [0.068, 0.24, 0.42], [5.055, 2.33, 2.42], mats.mapBlue);
addBox("livadia-bust-pedestal", [0.48, 0.82, 0.48], [-3.62, 0.41, -3.28], mats.marble);
addSphere("livadia-white-marble-bust-head", 0.22, [-3.62, 1.05, -3.28], mats.marble, 20, 12);
addBox("livadia-bust-shoulders", [0.48, 0.2, 0.28], [-3.62, 0.83, -3.28], mats.marble);
addCylinder("livadia-telescope-brass-tube", 0.045, 0.06, 0.92, [3.25, 1.04, -2.95], mats.brass, 16, [Math.PI / 2, 0.25, 0]);
addBox("livadia-telescope-tripod-one", [0.05, 0.7, 0.05], [3.05, 0.45, -2.78], mats.walnut, [0.25, 0, -0.28]);
addBox("livadia-telescope-tripod-two", [0.05, 0.7, 0.05], [3.48, 0.45, -2.78], mats.walnut, [0.25, 0, 0.28]);
addBox("livadia-telescope-tripod-three", [0.05, 0.7, 0.05], [3.26, 0.42, -3.25], mats.walnut, [-0.25, 0, 0]);

// Chandelier: visible in desktop and comfortable above VR head height.
addCylinder("livadia-chandelier-chain", 0.025, 0.025, 0.78, [0, 3.55, 0.75], mats.brass, 12);
addCylinder("livadia-chandelier-ring", 0.52, 0.52, 0.04, [0, 3.12, 0.75], mats.brass, 32);
for (let i = 0; i < 6; i += 1) {
  const angle = i * Math.PI / 3;
  const x = Math.cos(angle) * 0.54;
  const z = 0.75 + Math.sin(angle) * 0.54;
  addCylinder(`livadia-chandelier-arm-${i}`, 0.018, 0.018, 0.58, [x / 2, 3.1, 0.75 + (z - 0.75) / 2], mats.brass, 8, [Math.PI / 2, 0, Math.PI / 2 - angle]);
  addSphere(`livadia-chandelier-bulb-${i}`, 0.08, [x, 3.02, z], mats.lampGlow, 16, 10);
  addCone(`livadia-chandelier-cream-shade-${i}`, 0.16, 0.22, [x, 2.91, z], mats.porcelain, 16, [Math.PI, 0, 0]);
}
addLight("livadia-chandelier-warm-point-light", 0xffddb0, 8, 7, [0, 3.05, 0.75]);

// Soft daylight accents from windows; the room remains readable with clean-mode ambient light.
addLight("livadia-window-daylight-left", 0xccecff, 2.5, 6, [-2.9, 2.3, -3.5]);
addLight("livadia-window-daylight-center", 0xccecff, 3, 6.5, [0, 2.3, -3.5]);
addLight("livadia-window-daylight-right", 0xccecff, 2.5, 6, [2.9, 2.3, -3.5]);

function drawPreviewPpm(filePath) {
  const width = 1024;
  const height = 576;
  const pixels = Buffer.alloc(width * height * 3);

  function setPixel(x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 3;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
  }

  function fillRect(x, y, w, h, color) {
    for (let py = Math.max(0, y); py < Math.min(height, y + h); py += 1) {
      for (let px = Math.max(0, x); px < Math.min(width, x + w); px += 1) {
        setPixel(px, py, color);
      }
    }
  }

  function fillPoly(points, color) {
    const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p[1]))));
    for (let y = minY; y <= maxY; y += 1) {
      const nodes = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi < y && yj >= y) || (yj < y && yi >= y)) {
          nodes.push(Math.round(xi + ((y - yi) / (yj - yi)) * (xj - xi)));
        }
      }
      nodes.sort((a, b) => a - b);
      for (let k = 0; k < nodes.length; k += 2) {
        for (let x = Math.max(0, nodes[k]); x < Math.min(width, nodes[k + 1] ?? nodes[k]); x += 1) {
          setPixel(x, y, color);
        }
      }
    }
  }

  fillRect(0, 0, width, height, [232, 220, 194]);
  fillRect(0, 0, width, 215, [219, 203, 171]);
  fillPoly([[0, 576], [1024, 576], [812, 236], [212, 236]], [173, 115, 55]);
  fillPoly([[110, 520], [914, 520], [725, 285], [299, 285]], [129, 34, 45]);
  fillPoly([[150, 490], [874, 490], [690, 305], [334, 305]], [30, 56, 86]);
  for (const x of [240, 432, 624]) {
    fillRect(x, 92, 130, 178, [142, 204, 232]);
    fillRect(x + 6, 188, 118, 44, [39, 111, 157]);
    fillRect(x + 15, 172, 100, 23, [120, 145, 116]);
    fillRect(x - 8, 82, 146, 12, [107, 52, 28]);
    fillRect(x - 8, 270, 146, 12, [107, 52, 28]);
  }
  fillRect(350, 295, 324, 118, [90, 43, 25]);
  fillRect(382, 283, 260, 34, [113, 51, 28]);
  fillRect(410, 288, 204, 18, [22, 60, 43]);
  fillRect(448, 248, 34, 54, [210, 160, 66]);
  fillRect(430, 232, 70, 34, [242, 213, 171]);
  fillRect(280, 382, 112, 84, [49, 68, 37]);
  fillRect(632, 382, 112, 84, [49, 68, 37]);
  fillRect(58, 175, 98, 300, [74, 42, 25]);
  fillRect(868, 182, 98, 268, [74, 42, 25]);
  for (let i = 0; i < 9; i += 1) {
    fillRect(72 + i * 9, 205, 6, 65, [[150, 61, 52], [48, 82, 53], [36, 73, 101]][i % 3]);
    fillRect(883 + i * 8, 214, 6, 59, [[150, 61, 52], [48, 82, 53], [36, 73, 101]][(i + 1) % 3]);
  }
  fillRect(744, 260, 88, 124, [238, 232, 218]);
  fillRect(765, 288, 46, 68, [24, 18, 15]);
  fillRect(758, 242, 62, 20, [238, 232, 218]);
  fillRect(495, 48, 34, 96, [210, 160, 66]);
  fillRect(448, 137, 130, 22, [210, 160, 66]);
  for (const x of [428, 470, 512, 554, 596]) fillRect(x, 156, 20, 20, [255, 215, 132]);

  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  return writeFile(filePath, Buffer.concat([header, pixels]));
}

async function exportGlb(filePath) {
  const exporter = new GLTFExporter();
  const glb = await new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      resolve,
      reject,
      {
        binary: true,
        trs: false,
        onlyVisible: true,
        maxTextureSize: 2048
      }
    );
  });
  await writeFile(filePath, Buffer.from(glb));
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const sceneGlbPath = join(outputDir, "scene.glb");
  const previewPpmPath = join(outputDir, "preview.ppm");
  const previewWebpPath = join(outputDir, "preview.webp");

  await exportGlb(sceneGlbPath);
  await drawPreviewPpm(previewPpmPath);
  execFileSync("cwebp", ["-quiet", "-q", "88", previewPpmPath, "-o", previewWebpPath], { stdio: "inherit" });
  await rm(previewPpmPath, { force: true });

  const manifest = {
    schemaVersion: 1,
    sceneId,
    label: "Livadia Nicholas II Office",
    source: "Noah original procedural scene inspired by public-domain Livadia Palace imperial office history",
    glbPath: "scene.glb",
    renderMode: "clean",
    spawnPoints: [
      {
        id: "main",
        position: { x: 0, y: 0, z: 3.25 }
      }
    ],
    anchors: {
      teleportFloorY: 0,
      seatAnchors: [
        {
          id: "livadia-office-desk-chair",
          position: { x: 0, y: 0.45, z: -2.2 },
          yaw: 3.142,
          seatHeight: 0.06,
          radius: 0.5,
          label: "Imperial writing desk chair"
        },
        {
          id: "livadia-office-guest-left",
          position: { x: -0.9, y: 0.45, z: 0.55 },
          yaw: 0,
          seatHeight: 0.06,
          radius: 0.48,
          label: "Guest chair left"
        },
        {
          id: "livadia-office-guest-right",
          position: { x: 0.9, y: 0.45, z: 0.55 },
          yaw: 0,
          seatHeight: 0.06,
          radius: 0.48,
          label: "Guest chair right"
        },
        {
          id: "livadia-office-sofa-left",
          position: { x: -4.08, y: 0.46, z: 1.16 },
          yaw: -1.571,
          seatHeight: 0.06,
          radius: 0.5,
          label: "Left sofa seat"
        },
        {
          id: "livadia-office-sofa-right",
          position: { x: -4.08, y: 0.46, z: 2.28 },
          yaw: -1.571,
          seatHeight: 0.06,
          radius: 0.5,
          label: "Right sofa seat"
        },
        {
          id: "livadia-office-fireplace-armchair",
          position: { x: 3.62, y: 0.45, z: 1.25 },
          yaw: 1.571,
          seatHeight: 0.06,
          radius: 0.5,
          label: "Fireplace armchair"
        }
      ]
    },
    bounds: { width: 10.6, height: 4.3, depth: 8.6 },
    preview: "preview.webp",
    rights: {
      owner: "noah",
      license: "internal-original",
      clearedFor: ["staging", "production", "web-runtime", "screenshots", "optimization"],
      sourceAssets: [
        {
          id: "livadia-nicholas-office-v1-procedural-geometry",
          type: "mesh",
          author: "Noah/OpenCode",
          licenseRef: "LICENSES.md"
        },
        {
          id: "livadia-nicholas-office-v1-procedural-preview",
          type: "texture",
          author: "Noah/OpenCode",
          licenseRef: "LICENSES.md"
        }
      ]
    },
    visual: {
      intentionalDark: false
    },
    notes: "Original room-scale VR office scene: warm Livadia-inspired imperial study, central writing desk, bookcases, Crimean coast windows, fireplace, seating anchors, and clean-mode lighting. No external meshes, textures, fonts, or private source paths."
  };

  await writeFile(join(outputDir, "scene.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDir, "LICENSES.md"), `# Licenses And Provenance\n\nScene: ${manifest.label}\n\n- Geometry: original procedural mesh composition authored for Noah/OpenCode.\n- Materials: original named PBR color materials generated by tools/generate-livadia-office-scene.mjs.\n- Preview: original procedural raster preview generated from the same concept.\n- External assets: none. No third-party meshes, textures, fonts, photos, scans, or proprietary scene layouts are included.\n- Historical basis: public-domain historical theme of Nicholas II's Livadia Palace office, interpreted as a new Noah scene rather than copied from any prior digital room or copyrighted reference package.\n- Cleared usage: staging, production, web runtime, screenshots, and optimization.\n`);
}

await main();
