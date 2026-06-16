#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const requireFromRuntime = createRequire(new URL("../apps/runtime-web/package.json", import.meta.url));
const THREE = await import(requireFromRuntime.resolve("three"));
const { GLTFExporter } = await import(requireFromRuntime.resolve("three/examples/jsm/exporters/GLTFExporter.js"));

const sceneId = "livadia-nicholas-office-v1";
const outputDir = fileURLToPath(new URL(`../apps/runtime-web/public/assets/scenes/${sceneId}/`, import.meta.url));

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c >>> 0;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rawRow = y * (1 + width * 4);
    const srcRow = y * width * 4;
    raw[rawRow] = 0;
    for (let x = 0; x < width * 4; x += 1) {
      raw[rawRow + 1 + x] = rgba[srcRow + x];
    }
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

class NodeImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

class NodeCanvasContext2D {
  constructor(canvas) {
    this.canvas = canvas;
  }

  translate() {}

  scale() {}

  putImageData(imageData, dx, dy) {
    this.canvas.ensurePixels();
    if (dx === 0 && dy === 0 && imageData.width === this.canvas.width && imageData.height === this.canvas.height) {
      this.canvas.pixels.set(imageData.data);
      return;
    }
    for (let y = 0; y < imageData.height; y += 1) {
      for (let x = 0; x < imageData.width; x += 1) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= this.canvas.width || ty >= this.canvas.height) continue;
        const src = (y * imageData.width + x) * 4;
        const dst = (ty * this.canvas.width + tx) * 4;
        this.canvas.pixels[dst] = imageData.data[src];
        this.canvas.pixels[dst + 1] = imageData.data[src + 1];
        this.canvas.pixels[dst + 2] = imageData.data[src + 2];
        this.canvas.pixels[dst + 3] = imageData.data[src + 3];
      }
    }
  }
}

class NodeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
  }

  ensurePixels() {
    const required = this.width * this.height * 4;
    if (this.pixels.length !== required) {
      this.pixels = new Uint8Array(required);
    }
  }

  getContext(type) {
    if (type !== "2d") return null;
    this.ensurePixels();
    return new NodeCanvasContext2D(this);
  }

  async convertToBlob(options = {}) {
    this.ensurePixels();
    return new Blob([encodePng(this.width, this.height, this.pixels)], { type: options.type ?? "image/png" });
  }
}

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

globalThis.OffscreenCanvas ??= NodeOffscreenCanvas;
globalThis.ImageData ??= NodeImageData;

function clamp(value, min = 0, max = 255) {
  return Math.max(min, Math.min(max, value));
}

function rgb(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function mixColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    255
  ];
}

function hashNoise(x, y, seed = 1) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}

function makeTexture(name, width, height, painter, repeat = [1, 1]) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = painter(x / (width - 1), y / (height - 1), x, y);
      const offset = (y * width + x) * 4;
      data[offset] = clamp(Math.round(r));
      data[offset + 1] = clamp(Math.round(g));
      data[offset + 2] = clamp(Math.round(b));
      data[offset + 3] = clamp(Math.round(a));
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.name = name;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat[0], repeat[1]);
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

const textures = {
  damask: makeTexture("livadia-damask-warm-ivory-procedural", 256, 256, (u, v, x, y) => {
    const base = rgb(0xead9b7);
    const gold = rgb(0xd3b36d);
    const shadow = rgb(0xc8b38d);
    const wave = Math.sin(u * Math.PI * 8) * Math.sin(v * Math.PI * 6);
    const floral = Math.cos((u + v) * Math.PI * 10) * Math.cos((u - v) * Math.PI * 10);
    const panelLine = x % 64 < 2 || y % 64 < 2 ? 0.2 : 0;
    const t = clamp(0.16 + wave * 0.08 + floral * 0.07 + panelLine, 0, 0.42);
    return mixColor(base, t > 0.22 ? gold : shadow, t);
  }, [2, 1.5]),
  parquet: makeTexture("livadia-herringbone-oak-parquet-procedural", 256, 256, (u, v, x, y) => {
    const honey = rgb(0xd3a25b);
    const amber = rgb(0x9a6131);
    const dark = rgb(0x6f3d1d);
    const cellX = Math.floor(x / 24);
    const cellY = Math.floor(y / 12);
    const stripe = ((x + y * (cellY % 2 === 0 ? 1 : -1)) % 24) / 24;
    const grain = hashNoise(x, Math.floor(y / 3), 5) * 0.18 + Math.sin((u * 32 + v * 11) * Math.PI) * 0.08;
    const seam = x % 24 < 2 || y % 12 < 1 ? 0.35 : 0;
    const base = (cellX + cellY) % 2 === 0 ? honey : amber;
    return mixColor(base, seam > 0 ? dark : amber, clamp(0.12 + grain + seam, 0, 0.55));
  }, [5, 4]),
  walnut: makeTexture("livadia-dark-walnut-grain-procedural", 256, 256, (u, v, x, y) => {
    const deep = rgb(0x3f2012);
    const warm = rgb(0x87522b);
    const gold = rgb(0xb36a32);
    const grain = Math.sin((u * 18 + Math.sin(v * 18) * 0.6) * Math.PI) * 0.5 + 0.5;
    const pores = hashNoise(Math.floor(x / 2), Math.floor(y / 8), 9) * 0.18;
    return mixColor(deep, grain > 0.55 ? gold : warm, clamp(grain * 0.4 + pores, 0, 0.65));
  }, [1.5, 1.5]),
  marble: makeTexture("livadia-white-marble-veins-procedural", 256, 256, (u, v, x, y) => {
    const white = rgb(0xf5eddd);
    const cream = rgb(0xdcc9a8);
    const vein = rgb(0x9b8a76);
    const line = Math.abs(Math.sin((u * 5 + v * 9 + Math.sin(v * 20) * 0.08) * Math.PI));
    const n = hashNoise(x, y, 13) * 0.07;
    return mixColor(line < 0.09 ? vein : white, cream, clamp(0.12 + n, 0, 0.34));
  }, [1, 1]),
  velvet: makeTexture("livadia-burgundy-velvet-weave-procedural", 256, 256, (u, v, x, y) => {
    const red = rgb(0x7b2638);
    const wine = rgb(0x42121d);
    const highlight = rgb(0xb45a62);
    const weave = (x % 8 < 2 ? 0.16 : 0) + (y % 10 < 2 ? 0.12 : 0);
    const nap = Math.sin((u * 6 + v * 3) * Math.PI) * 0.12 + hashNoise(x, y, 21) * 0.1;
    return mixColor(nap + weave > 0.22 ? highlight : wine, red, 0.38 + nap + weave);
  }, [1.4, 1.4]),
  leather: makeTexture("livadia-imperial-green-leather-procedural", 256, 256, (u, v, x, y) => {
    const green = rgb(0x1d4b36);
    const dark = rgb(0x0e2419);
    const gold = rgb(0xba9448);
    const border = u < 0.08 || u > 0.92 || v < 0.08 || v > 0.92;
    const pores = hashNoise(x, y, 34) * 0.2;
    return border ? mixColor(gold, dark, 0.25) : mixColor(dark, green, 0.55 + pores);
  }, [1, 1]),
  rug: makeTexture("livadia-crimson-rug-medallion-procedural", 512, 512, (u, v, x, y) => {
    const crimson = rgb(0x9d2d3e);
    const navy = rgb(0x18304d);
    const gold = rgb(0xd4ad5c);
    const cream = rgb(0xe7cf9e);
    const border = u < 0.12 || u > 0.88 || v < 0.12 || v > 0.88;
    const du = u - 0.5;
    const dv = v - 0.5;
    const medallion = du * du / 0.08 + dv * dv / 0.045 < 1;
    const vine = Math.abs(Math.sin((u * 9 + Math.sin(v * 12) * 0.25) * Math.PI)) < 0.08;
    const small = Math.abs(Math.sin((u + v) * Math.PI * 18)) < 0.035;
    if (border) return mixColor(navy, gold, vine ? 0.45 : 0.06);
    if (medallion) return mixColor(gold, cream, 0.32 + hashNoise(x, y, 2) * 0.12);
    if (small) return mixColor(crimson, gold, 0.36);
    return mixColor(crimson, navy, hashNoise(x, y, 4) * 0.12);
  }, [1, 1]),
  panorama: makeTexture("livadia-crimean-estate-panorama-equirect-procedural", 1024, 512, (u, v, x, y) => {
    const noise = hashNoise(Math.floor(x / 3), Math.floor(y / 3), 71);
    if (v > 0.66) {
      const sky = mixColor(rgb(0x75b5e4), rgb(0xf2d8ad), 1 - v);
      const cloud = Math.abs(Math.sin((u * 7.5 + v * 2.1) * Math.PI)) < 0.08 && v > 0.74;
      return cloud ? mixColor(sky, rgb(0xffefd6), 0.55 + noise * 0.18) : sky;
    }
    if (v > 0.51) {
      const ridge = 0.54 + Math.sin(u * Math.PI * 8) * 0.035 + hashNoise(Math.floor(x / 12), 2, 75) * 0.025;
      return v < ridge
        ? mixColor(rgb(0x41593f), rgb(0xa6a86b), 0.38 + noise * 0.22)
        : mixColor(rgb(0xd9c28d), rgb(0x84bfdf), 0.34);
    }
    if (v > 0.29) {
      const shimmer = Math.sin((u * 44 + v * 9) * Math.PI) * 0.055 + noise * 0.08;
      return mixColor(rgb(0x1e668f), rgb(0x9bd6ef), 0.36 + (v - 0.29) * 0.9 + shimmer);
    }
    const cypressBand = ((u * 22 + Math.sin(u * Math.PI * 6) * 0.4) % 1 + 1) % 1;
    const cypress = cypressBand > 0.47 && cypressBand < 0.56 && v > 0.08 && v < 0.33;
    const roof = Math.abs(Math.sin(u * Math.PI * 11)) < 0.12 && v > 0.18 && v < 0.25;
    if (cypress) return mixColor(rgb(0x0d2a1f), rgb(0x2f5634), noise * 0.25);
    if (roof) return mixColor(rgb(0xb27a4a), rgb(0x6f3c27), noise * 0.2);
    return mixColor(rgb(0x31543a), rgb(0x9c9f64), 0.28 + noise * 0.22);
  }, [1, 1])
};

function material(name, color, options = {}) {
  const result = new THREE.MeshStandardMaterial({
    name,
    color,
    roughness: options.roughness ?? 0.72,
    metalness: options.metalness ?? 0,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0,
    map: options.map ?? null,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    side: options.side ?? THREE.FrontSide
  });
  if (options.depthWrite !== undefined) result.depthWrite = options.depthWrite;
  return result;
}

function basicMaterial(name, color, options = {}) {
  const result = new THREE.MeshBasicMaterial({
    name,
    color,
    map: options.map ?? null,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    side: options.side ?? THREE.FrontSide
  });
  if (options.depthWrite !== undefined) result.depthWrite = options.depthWrite;
  return result;
}

const mats = {
  wall: material("livadia-ivory-damask-plaster-pbr", 0xf0dfbf, { roughness: 0.9, map: textures.damask, emissive: 0xead9b7, emissiveIntensity: 0.035, side: THREE.DoubleSide }),
  wallPanel: material("livadia-raised-warm-cream-panel-pbr", 0xd8c39b, { roughness: 0.88, map: textures.damask }),
  parquet: material("livadia-herringbone-golden-oak-pbr", 0xc98b45, { roughness: 0.62, map: textures.parquet, side: THREE.DoubleSide }),
  walnut: material("livadia-carved-dark-walnut-pbr", 0x5b321d, { roughness: 0.52, map: textures.walnut }),
  walnutDark: material("livadia-shadowed-walnut-trim-pbr", 0x2f170d, { roughness: 0.58, map: textures.walnut }),
  brass: material("livadia-aged-brass-pbr", 0xc89a3e, { metalness: 0.72, roughness: 0.28 }),
  marble: material("livadia-veined-white-marble-pbr", 0xf1eadc, { roughness: 0.42, map: textures.marble }),
  velvet: material("livadia-deep-burgundy-velvet-pbr", 0x762838, { roughness: 0.88, map: textures.velvet, emissive: 0x19070b, emissiveIntensity: 0.045 }),
  oliveVelvet: material("livadia-olive-green-velvet-pbr", 0x3e5733, { roughness: 0.86, map: textures.velvet, emissive: 0x10190d, emissiveIntensity: 0.04 }),
  leather: material("livadia-green-leather-gold-tooled-pbr", 0x1f5139, { roughness: 0.48, map: textures.leather }),
  rug: material("livadia-crimson-rug-with-medallion-pbr", 0x992f3c, { roughness: 0.9, map: textures.rug, side: THREE.DoubleSide }),
  glass: material("livadia-clear-arched-window-glass-pbr", 0xe1f8ff, { roughness: 0.06, transparent: true, opacity: 0.22, emissive: 0x8acbec, emissiveIntensity: 0.035, side: THREE.DoubleSide, depthWrite: false }),
  panorama: basicMaterial("livadia-exterior-crimean-panorama-sphere-unlit", 0xffffff, { map: textures.panorama, side: THREE.BackSide }),
  paper: material("livadia-aged-paper-pbr", 0xf1ddad, { roughness: 0.86, emissive: 0xe6c98d, emissiveIntensity: 0.035 }),
  ink: material("livadia-black-glass-inkwell-pbr", 0x0b0e12, { roughness: 0.24, metalness: 0.12 }),
  porcelain: material("livadia-warm-porcelain-lamp-shade-pbr", 0xf1ddba, { roughness: 0.42, emissive: 0xffc982, emissiveIntensity: 0.16 }),
  lampGlow: material("livadia-warm-lamp-glow-emissive", 0xffd892, { roughness: 0.2, emissive: 0xffbe63, emissiveIntensity: 1.6 }),
  soot: material("livadia-fireplace-soot-black-pbr", 0x15100d, { roughness: 0.95 }),
  bookRed: material("livadia-book-spine-oxblood", 0x8f2f2d, { roughness: 0.78 }),
  bookGreen: material("livadia-book-spine-forest", 0x315a3a, { roughness: 0.78 }),
  bookBlue: material("livadia-book-spine-navy", 0x254d6d, { roughness: 0.78 }),
  bookTan: material("livadia-book-spine-tan", 0xa67a40, { roughness: 0.78 }),
  portrait: material("livadia-muted-oil-portrait-canvas-pbr", 0x66513c, { roughness: 0.92 }),
  mapGreen: material("livadia-crimea-map-green-ink-pbr", 0x55764d, { roughness: 0.84 }),
  mapBlue: material("livadia-crimea-map-blue-water-pbr", 0x4779a1, { roughness: 0.84 })
};

const scene = new THREE.Scene();
scene.name = `${sceneId}-art-pass-export-scene`;

const root = new THREE.Group();
root.name = `${sceneId}-root`;
scene.add(root);

function addMesh(name, geometry, mat, position = [0, 0, 0], rotation = [0, 0, 0], parent = root) {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  parent.add(mesh);
  return mesh;
}

function addBox(name, size, position, mat, rotation = [0, 0, 0], parent = root) {
  return addMesh(name, new THREE.BoxGeometry(size[0], size[1], size[2]), mat, position, rotation, parent);
}

function roundedRectShape(width, height, radius) {
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(radius, w, h);
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  return shape;
}

function roundedBoxGeometry(width, height, depth, radius = 0.08, bevel = 0.025) {
  const geometry = new THREE.ExtrudeGeometry(roundedRectShape(width, height, radius), {
    depth,
    steps: 1,
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 3
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function addRoundedBox(name, size, position, mat, radius = 0.08, rotation = [0, 0, 0], parent = root) {
  return addMesh(name, roundedBoxGeometry(size[0], size[1], size[2], radius), mat, position, rotation, parent);
}

function addCylinder(name, radiusTop, radiusBottom, height, position, mat, radialSegments = 24, rotation = [0, 0, 0], parent = root) {
  return addMesh(name, new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments), mat, position, rotation, parent);
}

function addSphere(name, radius, position, mat, widthSegments = 24, heightSegments = 14, parent = root) {
  return addMesh(name, new THREE.SphereGeometry(radius, widthSegments, heightSegments), mat, position, [0, 0, 0], parent);
}

function addCone(name, radius, height, position, mat, radialSegments = 24, rotation = [0, 0, 0], parent = root) {
  return addMesh(name, new THREE.ConeGeometry(radius, height, radialSegments), mat, position, rotation, parent);
}

function addLight(name, color, intensity, distance, position) {
  const light = new THREE.PointLight(color, intensity, distance, 2);
  light.name = name;
  light.position.set(position[0], position[1], position[2]);
  root.add(light);
}

function segmentAngle(a, b) {
  return -Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function addSegmentBox(name, a, b, height, y, depth, mat, yRotationOffset = 0) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  return addBox(name, [length, height, depth], [(a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2], mat, [0, segmentAngle(a, b) + yRotationOffset, 0]);
}

function projectPointOnSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  return ((point[0] - (a[0] + b[0]) / 2) * dx + (point[1] - (a[1] + b[1]) / 2) * dz) / length;
}

function archOpeningPath(width, height, xOffset, yOffset) {
  const r = width / 2;
  const left = xOffset - width / 2;
  const right = xOffset + width / 2;
  const springY = yOffset + height - r;
  const path = new THREE.Path();
  path.moveTo(left, yOffset);
  path.lineTo(left, springY);
  path.quadraticCurveTo(left, yOffset + height, xOffset, yOffset + height);
  path.quadraticCurveTo(right, yOffset + height, right, springY);
  path.lineTo(right, yOffset);
  path.lineTo(left, yOffset);
  return path;
}

function wallSegmentGeometry(length, height, depth, openings = []) {
  const shape = new THREE.Shape();
  shape.moveTo(-length / 2, 0);
  shape.lineTo(length / 2, 0);
  shape.lineTo(length / 2, height);
  shape.lineTo(-length / 2, height);
  shape.lineTo(-length / 2, 0);

  for (const opening of openings) {
    const halfWidth = Math.min(opening.width / 2, length / 2 - 0.18);
    const x = clamp(opening.x, -length / 2 + halfWidth + 0.08, length / 2 - halfWidth - 0.08);
    shape.holes.push(archOpeningPath(halfWidth * 2, opening.height, x, opening.y));
  }

  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function addWallSegment(name, a, b, height, depth, mat, openings = []) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  return addMesh(
    name,
    wallSegmentGeometry(length, height, depth, openings),
    mat,
    [(a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2],
    [0, segmentAngle(a, b), 0]
  );
}

function polygonGeometry(points, y) {
  const vertices = [];
  const uvs = [];
  const indices = [];
  const center = points.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]).map((value) => value / points.length);
  vertices.push(center[0], y, center[1]);
  uvs.push((center[0] + 8) / 16, (center[1] + 7) / 14);
  for (const point of points) {
    vertices.push(point[0], y, point[1]);
    uvs.push((point[0] + 8) / 16, (point[1] + 7) / 14);
  }
  for (let i = 1; i <= points.length; i += 1) {
    const next = i === points.length ? 1 : i + 1;
    indices.push(0, next, i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function archPath(width, height, yOffset = 0) {
  const r = width / 2;
  const springY = yOffset + height - r;
  const path = new THREE.Path();
  path.moveTo(-width / 2, yOffset);
  path.lineTo(-width / 2, springY);
  path.quadraticCurveTo(-width / 2, yOffset + height, 0, yOffset + height);
  path.quadraticCurveTo(width / 2, yOffset + height, width / 2, springY);
  path.lineTo(width / 2, yOffset);
  path.lineTo(-width / 2, yOffset);
  return path;
}

function archFrameGeometry(width, height, thickness, depth) {
  const shape = new THREE.Shape();
  const outer = archPath(width, height);
  shape.curves = outer.curves;
  shape.holes.push(archPath(width - thickness * 2, height - thickness * 2, thickness));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function archSolidGeometry(width, height, depth) {
  const shape = new THREE.Shape();
  const outer = archPath(width, height);
  shape.curves = outer.curves;
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function addArchPanel(name, width, height, position, mat, rotation = [0, 0, 0], frame = false, parent = root) {
  const geometry = frame ? archFrameGeometry(width, height, 0.12, 0.08) : archSolidGeometry(width, height, 0.035);
  return addMesh(name, geometry, mat, position, rotation, parent);
}

function addWindow(prefix, position, yaw, width = 1.9, height = 3.25) {
  const group = new THREE.Group();
  group.name = `${prefix}-window-group`;
  group.position.set(position[0], position[1], position[2]);
  group.rotation.y = yaw;
  root.add(group);

  addArchPanel(`${prefix}-transparent-glass-arch`, width * 0.92, height * 0.88, [0, 0.06, -0.055], mats.glass, [0, 0, 0], false, group);
  addArchPanel(`${prefix}-carved-walnut-arch-frame`, width, height, [0, 0, 0], mats.walnut, [0, 0, 0], true, group);
  addBox(`${prefix}-center-mullion`, [0.065, height * 0.72, 0.09], [0, height * 0.38, -0.11], mats.walnut, [0, 0, 0], group);
  addBox(`${prefix}-lower-crossbar`, [width * 0.72, 0.065, 0.09], [0, height * 0.34, -0.11], mats.walnut, [0, 0, 0], group);
  addBox(`${prefix}-burgundy-left-drape`, [0.22, height * 0.9, 0.18], [-width * 0.64, height * 0.44, -0.18], mats.velvet, [0, 0, 0.04], group);
  addBox(`${prefix}-burgundy-right-drape`, [0.22, height * 0.9, 0.18], [width * 0.64, height * 0.44, -0.18], mats.velvet, [0, 0, -0.04], group);
  addCylinder(`${prefix}-brass-curtain-rod`, 0.035, 0.035, width * 1.32, [0, height + 0.12, -0.15], mats.brass, 16, [0, 0, Math.PI / 2], group);
}

function addColumn(prefix, x, z, height = 4.6) {
  addCylinder(`${prefix}-marble-base`, 0.24, 0.3, 0.22, [x, 0.11, z], mats.marble, 28);
  addCylinder(`${prefix}-fluted-shaft`, 0.18, 0.2, height, [x, 0.22 + height / 2, z], mats.marble, 32);
  addCylinder(`${prefix}-brass-capital-ring`, 0.29, 0.24, 0.16, [x, height + 0.34, z], mats.brass, 28);
  addBox(`${prefix}-square-abacus`, [0.62, 0.12, 0.62], [x, height + 0.48, z], mats.marble);
}

function addBookcase(prefix, position, yaw, width = 2.4, height = 3.4) {
  const group = new THREE.Group();
  group.name = `${prefix}-bookcase-group`;
  group.position.set(position[0], position[1], position[2]);
  group.rotation.y = yaw;
  root.add(group);

  addRoundedBox(`${prefix}-case-back`, [width, height, 0.16], [0, height / 2, 0], mats.walnutDark, 0.08, [0, 0, 0], group);
  addArchPanel(`${prefix}-arched-crown`, width * 0.74, 1.02, [0, height - 1.0, -0.13], mats.walnut, [0, 0, 0], true, group);
  addBox(`${prefix}-left-stile`, [0.16, height, 0.34], [-width / 2 + 0.08, height / 2, -0.03], mats.walnut, [0, 0, 0], group);
  addBox(`${prefix}-right-stile`, [0.16, height, 0.34], [width / 2 - 0.08, height / 2, -0.03], mats.walnut, [0, 0, 0], group);
  for (const y of [0.58, 1.18, 1.8, 2.44]) {
    addBox(`${prefix}-shelf-${y}`, [width * 0.88, 0.08, 0.4], [0, y, -0.1], mats.walnut, [0, 0, 0], group);
  }
  const bookMats = [mats.bookRed, mats.bookGreen, mats.bookBlue, mats.bookTan];
  let bookIndex = 0;
  for (const y of [0.64, 1.24, 1.86]) {
    for (let i = 0; i < 5; i += 1) {
      const h = 0.34 + ((i + bookIndex) % 4) * 0.06;
      const w = 0.11 + (i % 3) * 0.03;
      const x = -width * 0.32 + i * (width * 0.64 / 4);
      addBox(`${prefix}-book-${bookIndex}`, [w, h, 0.16], [x, y + h / 2, -0.34], bookMats[bookIndex % bookMats.length], [0, 0, (i % 2 - 0.5) * 0.04], group);
      bookIndex += 1;
    }
  }
}

function addArmchair(prefix, x, z, yaw, seatMat = mats.velvet) {
  const group = new THREE.Group();
  group.name = `${prefix}-armchair-group`;
  group.position.set(x, 0, z);
  group.rotation.y = yaw;
  root.add(group);

  addRoundedBox(`${prefix}-rounded-seat-cushion`, [0.9, 0.18, 0.82], [0, 0.48, 0], seatMat, 0.16, [0, 0, 0], group);
  addRoundedBox(`${prefix}-arched-back-cushion`, [0.94, 1.18, 0.2], [0, 1.08, 0.43], seatMat, 0.2, [-0.1, 0, 0], group);
  addCylinder(`${prefix}-left-rolled-arm`, 0.13, 0.13, 0.82, [-0.58, 0.76, 0.02], seatMat, 20, [Math.PI / 2, 0, 0], group);
  addCylinder(`${prefix}-right-rolled-arm`, 0.13, 0.13, 0.82, [0.58, 0.76, 0.02], seatMat, 20, [Math.PI / 2, 0, 0], group);
  addBox(`${prefix}-front-carved-rail`, [1.05, 0.12, 0.12], [0, 0.4, -0.48], mats.walnut, [0, 0, 0], group);
  for (const lx of [-0.34, 0.34]) {
    for (const lz of [-0.28, 0.28]) {
      addCylinder(`${prefix}-turned-leg-${lx}-${lz}`, 0.045, 0.06, 0.42, [lx, 0.22, lz], mats.walnut, 12, [0, 0, 0], group);
    }
  }
}

function addDesk() {
  addRoundedBox("livadia-hero-imperial-writing-desk-top", [3.25, 0.22, 1.45], [0, 0.88, -1.55], mats.walnut, 0.18);
  addRoundedBox("livadia-desk-green-tooled-leather-inlay", [2.66, 0.035, 1.02], [0, 1.015, -1.55], mats.leather, 0.1);
  addRoundedBox("livadia-desk-front-bowed-panel", [3.0, 0.72, 0.18], [0, 0.52, -0.84], mats.walnutDark, 0.12);
  addCylinder("livadia-desk-bowed-front-rounding", 0.14, 0.14, 2.78, [0, 0.9, -0.74], mats.walnut, 24, [0, 0, Math.PI / 2]);
  for (const x of [-1.24, -0.42, 0.42, 1.24]) {
    addRoundedBox(`livadia-desk-carved-drawer-${x}`, [0.55, 0.24, 0.07], [x, 0.7, -0.68], mats.walnut, 0.04);
    addCylinder(`livadia-desk-brass-drawer-pull-${x}`, 0.035, 0.035, 0.28, [x, 0.7, -0.61], mats.brass, 12, [Math.PI / 2, 0, 0]);
  }
  for (const x of [-1.25, 1.25]) {
    for (const z of [-2.08, -1.02]) {
      addCylinder(`livadia-desk-turned-heavy-leg-${x}-${z}`, 0.11, 0.14, 0.76, [x, 0.46, z], mats.walnut, 18);
      addCylinder(`livadia-desk-brass-foot-${x}-${z}`, 0.13, 0.13, 0.06, [x, 0.08, z], mats.brass, 18);
    }
  }
  addBox("livadia-desk-paper-stack", [0.58, 0.04, 0.36], [-0.76, 1.06, -1.3], mats.paper, [0, 0.2, 0]);
  addBox("livadia-desk-crimea-map-paper", [0.86, 0.03, 0.62], [0.32, 1.06, -1.58], mats.paper, [0, -0.18, 0]);
  addBox("livadia-desk-map-sea-mark", [0.28, 0.035, 0.12], [0.13, 1.085, -1.52], mats.mapBlue, [0, -0.18, 0]);
  addBox("livadia-desk-map-green-coast-mark", [0.28, 0.035, 0.18], [0.43, 1.088, -1.68], mats.mapGreen, [0, -0.18, 0]);
  addCylinder("livadia-desk-black-glass-inkwell", 0.09, 0.11, 0.12, [-1.05, 1.09, -1.78], mats.ink, 18);
  addCylinder("livadia-desk-lamp-brass-stem", 0.035, 0.045, 0.72, [1.08, 1.43, -1.4], mats.brass, 14);
  addCone("livadia-desk-lamp-porcelain-shade", 0.28, 0.34, [1.08, 1.84, -1.4], mats.porcelain, 28);
  addSphere("livadia-desk-lamp-warm-bulb", 0.105, [1.08, 1.57, -1.4], mats.lampGlow, 18, 12);
  addLight("livadia-desk-lamp-warm-point-light", 0xffd5a0, 5.5, 7, [1.08, 1.58, -1.4]);
}

function addFireplace() {
  addRoundedBox("livadia-side-fireplace-marble-hearth", [1.85, 0.22, 0.58], [5.95, 0.12, 1.15], mats.marble, 0.08, [0, Math.PI / 2, 0]);
  addRoundedBox("livadia-side-fireplace-marble-surround", [1.66, 1.58, 0.32], [6.62, 0.92, 1.15], mats.marble, 0.08, [0, Math.PI / 2, 0]);
  addArchPanel("livadia-fireplace-soot-arched-opening", 0.9, 1.05, [6.43, 0.42, 1.15], mats.soot, [0, Math.PI / 2, 0]);
  addRoundedBox("livadia-fireplace-heavy-mantel", [1.95, 0.18, 0.5], [6.35, 1.73, 1.15], mats.marble, 0.06, [0, Math.PI / 2, 0]);
  addCylinder("livadia-mantel-clock-brass-body", 0.2, 0.2, 0.17, [6.08, 1.98, 1.15], mats.brass, 28, [0, 0, Math.PI / 2]);
  addBox("livadia-mantel-clock-cream-face", [0.035, 0.24, 0.24], [5.94, 1.98, 1.15], mats.paper);
  addSphere("livadia-fireplace-warm-ember-left", 0.08, [6.22, 0.55, 0.9], mats.lampGlow, 14, 8);
  addSphere("livadia-fireplace-warm-ember-right", 0.08, [6.22, 0.55, 1.38], mats.lampGlow, 14, 8);
  addLight("livadia-fireplace-soft-ember-light", 0xff8f50, 2.4, 4, [5.9, 0.75, 1.15]);
}

function drawPreviewPpm(filePath) {
  const width = 1280;
  const height = 720;
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
      for (let px = Math.max(0, x); px < Math.min(width, x + w); px += 1) setPixel(px, py, color);
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
        if ((yi < y && yj >= y) || (yj < y && yi >= y)) nodes.push(Math.round(xi + ((y - yi) / (yj - yi)) * (xj - xi)));
      }
      nodes.sort((a, b) => a - b);
      for (let k = 0; k < nodes.length; k += 2) {
        for (let x = Math.max(0, nodes[k]); x < Math.min(width, nodes[k + 1] ?? nodes[k]); x += 1) setPixel(x, y, color);
      }
    }
  }

  fillRect(0, 0, width, height, [226, 211, 183]);
  fillRect(0, 0, width, 250, [211, 192, 155]);
  fillPoly([[0, 720], [1280, 720], [1020, 280], [260, 280]], [160, 91, 42]);
  fillPoly([[86, 650], [1194, 650], [910, 322], [370, 322]], [139, 35, 50]);
  fillPoly([[140, 612], [1140, 612], [870, 346], [410, 346]], [28, 48, 75]);
  fillRect(350, 300, 580, 8, [200, 154, 75]);
  for (const x of [296, 496, 694, 892]) {
    fillRect(x, 92, 130, 230, [145, 204, 231]);
    fillRect(x + 4, 206, 122, 58, [36, 105, 150]);
    fillRect(x + 14, 184, 102, 30, [106, 139, 89]);
    fillRect(x + 22, 242, 18, 58, [27, 67, 44]);
    fillRect(x + 82, 238, 18, 62, [24, 61, 42]);
    fillRect(x + 22, 100, 12, 188, [219, 244, 250]);
    fillRect(x + 82, 92, 8, 176, [205, 235, 246]);
    fillRect(x - 18, 70, 166, 16, [92, 47, 27]);
    fillRect(x - 18, 322, 166, 16, [92, 47, 27]);
    fillRect(x - 36, 76, 22, 280, [106, 31, 45]);
    fillRect(x + 148, 76, 22, 280, [106, 31, 45]);
  }
  fillRect(455, 352, 370, 135, [91, 45, 25]);
  fillRect(494, 336, 292, 42, [124, 67, 35]);
  fillRect(530, 342, 220, 22, [30, 75, 52]);
  fillRect(510, 490, 260, 34, [57, 28, 16]);
  fillRect(360, 475, 128, 102, [68, 25, 36]);
  fillRect(792, 475, 128, 102, [68, 25, 36]);
  fillRect(65, 205, 148, 338, [66, 34, 20]);
  fillRect(1068, 205, 148, 338, [66, 34, 20]);
  for (let i = 0; i < 18; i += 1) {
    fillRect(86 + i * 6, 250, 4, 82, [[143, 50, 43], [48, 82, 54], [36, 73, 101], [166, 120, 62]][i % 4]);
    fillRect(1090 + i * 6, 250, 4, 82, [[143, 50, 43], [48, 82, 54], [36, 73, 101], [166, 120, 62]][(i + 1) % 4]);
  }
  fillRect(942, 344, 112, 158, [230, 222, 206]);
  fillRect(970, 382, 54, 82, [24, 18, 15]);
  fillRect(603, 40, 74, 118, [197, 150, 66]);
  fillRect(520, 154, 240, 24, [197, 150, 66]);
  for (const x of [500, 554, 608, 662, 716, 770]) fillRect(x, 180, 28, 28, [252, 211, 134]);

  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  return writeFile(filePath, Buffer.concat([header, pixels]));
}

const floorPlan = [
  [-6.9, 4.9],
  [6.9, 4.9],
  [6.9, -2.6],
  [4.8, -4.7],
  [2.25, -5.85],
  [0, -6.28],
  [-2.25, -5.85],
  [-4.8, -4.7],
  [-6.9, -2.6]
];

function windowOpening(segmentIndex, point, width, height, y = 0.86) {
  const a = floorPlan[segmentIndex];
  const b = floorPlan[(segmentIndex + 1) % floorPlan.length];
  return { x: projectPointOnSegment(point, a, b), width, height, y };
}

const wallWindowOpenings = new Map([
  [1, [windowOpening(1, [6.9, -0.65], 1.46, 3.18)]],
  [3, [windowOpening(3, [3.45, -5.12], 1.78, 3.45)]],
  [6, [windowOpening(6, [-3.45, -5.12], 1.78, 3.45)]],
  [8, [windowOpening(8, [-6.9, -0.65], 1.46, 3.18)]]
]);

// Enlarged non-box plan: broad study plus faceted sea-facing bay.
const panoramaSphere = addMesh("livadia-exterior-panorama-sphere", new THREE.SphereGeometry(34, 72, 36), mats.panorama, [0, 2.35, -0.8], [0, -0.35, 0]);
panoramaSphere.userData.vrataExcludeFromSceneBounds = true;
addMesh("livadia-herringbone-parquet-irregular-floor", polygonGeometry(floorPlan, 0), mats.parquet);
addMesh("livadia-coffered-plaster-ceiling-irregular-plan", polygonGeometry(floorPlan, 5.18), mats.wall);

for (let i = 0; i < floorPlan.length; i += 1) {
  const a = floorPlan[i];
  const b = floorPlan[(i + 1) % floorPlan.length];
  addWallSegment(`livadia-articulated-wall-${i}`, a, b, 5.18, 0.18, mats.wall, wallWindowOpenings.get(i) ?? []);
  addSegmentBox(`livadia-walnut-baseboard-${i}`, a, b, 0.28, 0.16, 0.25, mats.walnut);
  addSegmentBox(`livadia-brass-picture-rail-${i}`, a, b, 0.08, 3.18, 0.23, mats.brass);
  addSegmentBox(`livadia-deep-crown-molding-${i}`, a, b, 0.24, 4.96, 0.32, mats.walnut);
}

for (const [index, [x, z]] of floorPlan.entries()) {
  if (index === 0 || index === 1) continue;
  addColumn(`livadia-bay-and-corner-column-${index}`, x, z, index >= 3 && index <= 7 ? 4.42 : 4.25);
}

// Front entry doors and side wall articulation.
addRoundedBox("livadia-front-grand-double-door", [2.85, 3.12, 0.16], [0, 1.56, 4.78], mats.walnut, 0.14);
addBox("livadia-front-door-center-brass-line", [0.055, 2.82, 0.18], [0, 1.5, 4.62], mats.brass);
addArchPanel("livadia-front-door-arched-brass-frame", 3.18, 3.62, [0, 0.72, 4.58], mats.brass, [0, Math.PI, 0], true);
for (const x of [-4.9, -3.25, 3.25, 4.9]) {
  addRoundedBox(`livadia-front-raised-damask-panel-${x}`, [1.05, 1.82, 0.07], [x, 1.62, 4.66], mats.wallPanel, 0.08);
}
for (const z of [-1.6, 0.8, 3.0]) {
  addRoundedBox(`livadia-left-raised-panel-${z}`, [0.07, 1.62, 1.45], [-6.78, 1.65, z], mats.wallPanel, 0.08);
  addRoundedBox(`livadia-right-raised-panel-${z}`, [0.07, 1.62, 1.45], [6.78, 1.65, z], mats.wallPanel, 0.08);
}

addWindow("livadia-center-bay", [0, 1.08, -6.12], 0, 2.4, 3.6);
addWindow("livadia-left-bay", [-3.45, 1.05, -5.12], -0.63, 2.0, 3.35);
addWindow("livadia-right-bay", [3.45, 1.05, -5.12], 0.63, 2.0, 3.35);
addWindow("livadia-left-side-window", [-6.72, 1.05, -0.65], -Math.PI / 2, 1.65, 3.05);
addWindow("livadia-right-side-window", [6.72, 1.05, -0.65], Math.PI / 2, 1.65, 3.05);

// Ceiling coffers and central chandelier.
for (const x of [-4.4, -2.2, 0, 2.2, 4.4]) addBox(`livadia-ceiling-cross-coffer-rib-${x}`, [0.12, 0.16, 8.6], [x, 5.02, -0.45], mats.brass);
for (const z of [-3.8, -1.8, 0.2, 2.2, 4.0]) addBox(`livadia-ceiling-long-coffer-rib-${z}`, [11.5, 0.16, 0.12], [0, 5.02, z], mats.brass);
addCylinder("livadia-ceiling-large-oval-rosette", 0.72, 0.72, 0.07, [0, 4.93, 0.55], mats.marble, 48);
addCylinder("livadia-chandelier-chain", 0.025, 0.025, 0.86, [0, 4.46, 0.55], mats.brass, 12);
addMesh("livadia-chandelier-brass-ring", new THREE.TorusGeometry(0.65, 0.035, 12, 48), mats.brass, [0, 3.94, 0.55], [Math.PI / 2, 0, 0]);
for (let i = 0; i < 8; i += 1) {
  const angle = (i / 8) * Math.PI * 2;
  const x = Math.cos(angle) * 0.7;
  const z = 0.55 + Math.sin(angle) * 0.7;
  addCylinder(`livadia-chandelier-brass-arm-${i}`, 0.018, 0.018, 0.7, [x / 2, 3.92, 0.55 + (z - 0.55) / 2], mats.brass, 8, [Math.PI / 2, 0, Math.PI / 2 - angle]);
  addSphere(`livadia-chandelier-warm-bulb-${i}`, 0.08, [x, 3.82, z], mats.lampGlow, 16, 10);
  addCone(`livadia-chandelier-porcelain-shade-${i}`, 0.16, 0.24, [x, 3.69, z], mats.porcelain, 18, [Math.PI, 0, 0]);
}
addLight("livadia-chandelier-warm-room-light", 0xffddb0, 9.2, 10, [0, 3.9, 0.55]);

// Focal furniture and social layout.
addBox("livadia-large-rug-with-procedural-medallion", [6.2, 0.035, 4.0], [0, 0.045, 0.58], mats.rug);
addDesk();
addArmchair("livadia-imperial-desk-chair", 0, -2.85, Math.PI, mats.oliveVelvet);
addArmchair("livadia-guest-left-armchair", -1.18, 0.8, 0, mats.velvet);
addArmchair("livadia-guest-right-armchair", 1.18, 0.8, 0, mats.velvet);

// Lounge corner and book-lined study walls.
addRoundedBox("livadia-left-sofa-single-long-seat", [1.05, 0.24, 2.45], [-5.45, 0.5, 2.0], mats.velvet, 0.2);
addRoundedBox("livadia-left-sofa-tall-curved-back", [0.22, 1.08, 2.62], [-6.02, 0.98, 2.0], mats.velvet, 0.18);
addCylinder("livadia-left-sofa-front-rolled-arm", 0.16, 0.16, 1.0, [-5.45, 0.82, 0.68], mats.velvet, 20, [0, 0, Math.PI / 2]);
addCylinder("livadia-left-sofa-back-rolled-arm", 0.16, 0.16, 1.0, [-5.45, 0.82, 3.32], mats.velvet, 20, [0, 0, Math.PI / 2]);
addBox("livadia-sofa-carved-front-rail", [0.12, 0.2, 2.58], [-4.9, 0.45, 2.0], mats.walnut);
addFireplace();
addArmchair("livadia-fireplace-reading-armchair", 4.65, 1.2, Math.PI / 2, mats.velvet);
addBookcase("livadia-left-library-bay", [-6.58, 0, -2.95], Math.PI / 2, 2.6, 3.35);
addBookcase("livadia-right-library-bay", [6.58, 0, -2.85], -Math.PI / 2, 2.6, 3.35);

// Period objects: bust, telescope, portrait and map board.
addRoundedBox("livadia-white-marble-bust-pedestal", [0.62, 0.86, 0.62], [-4.18, 0.43, -3.72], mats.marble, 0.09);
addSphere("livadia-white-marble-bust-head", 0.25, [-4.18, 1.17, -3.72], mats.marble, 24, 14);
addRoundedBox("livadia-white-marble-bust-shoulders", [0.55, 0.2, 0.34], [-4.18, 0.9, -3.72], mats.marble, 0.08);
addCylinder("livadia-brass-telescope-main-tube", 0.055, 0.072, 1.08, [3.7, 1.08, -3.62], mats.brass, 18, [Math.PI / 2, 0.24, 0.12]);
addCylinder("livadia-telescope-front-lens", 0.1, 0.1, 0.05, [3.22, 1.05, -3.72], mats.glass, 18, [Math.PI / 2, 0.24, 0.12]);
for (const [index, [x, z, rz]] of [[3.45, -3.35, -0.26], [4.0, -3.35, 0.26], [3.72, -3.9, 0]].entries()) {
  addBox(`livadia-telescope-walnut-tripod-leg-${index}`, [0.055, 0.82, 0.055], [x, 0.48, z], mats.walnut, [0.24, 0, rz]);
}
addRoundedBox("livadia-left-wall-imperial-portrait-frame", [0.08, 1.25, 0.96], [-6.73, 2.75, 2.45], mats.brass, 0.04);
addRoundedBox("livadia-left-wall-muted-portrait-canvas", [0.055, 0.96, 0.68], [-6.68, 2.75, 2.45], mats.portrait, 0.04);
addRoundedBox("livadia-right-wall-crimea-map-frame", [0.08, 1.18, 1.62], [6.73, 2.68, 2.5], mats.walnut, 0.05);
addRoundedBox("livadia-right-wall-crimea-map-paper", [0.055, 0.9, 1.28], [6.68, 2.68, 2.5], mats.paper, 0.04);
addBox("livadia-right-wall-map-blue-sea", [0.06, 0.26, 0.46], [6.63, 2.46, 2.78], mats.mapBlue);
addBox("livadia-right-wall-map-green-coast", [0.062, 0.2, 0.62], [6.62, 2.68, 2.35], mats.mapGreen);

// Daylight accents from the bay. Clean mode ambient remains enough even if punctual lights are ignored.
addLight("livadia-bay-daylight-left", 0xccecff, 3.2, 8, [-3.4, 2.7, -4.7]);
addLight("livadia-bay-daylight-center", 0xdaf2ff, 4.2, 9, [0, 2.8, -5.55]);
addLight("livadia-bay-daylight-right", 0xccecff, 3.2, 8, [3.4, 2.7, -4.7]);

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
    source: "Vrata original procedural art-pass scene inspired by public-domain Livadia Palace imperial office history",
    glbPath: "scene.glb",
    renderMode: "clean",
    spawnPoints: [
      {
        id: "main",
        position: { x: 0, y: 0, z: 4.05 }
      }
    ],
    anchors: {
      teleportFloorY: 0,
      seatAnchors: [
        {
          id: "livadia-office-desk-chair",
          position: { x: 0, y: 0.48, z: -2.85 },
          yaw: 3.142,
          seatHeight: 0.06,
          radius: 0.56,
          label: "Imperial writing desk chair"
        },
        {
          id: "livadia-office-guest-left",
          position: { x: -1.18, y: 0.48, z: 0.8 },
          yaw: 0,
          seatHeight: 0.06,
          radius: 0.54,
          label: "Guest armchair left"
        },
        {
          id: "livadia-office-guest-right",
          position: { x: 1.18, y: 0.48, z: 0.8 },
          yaw: 0,
          seatHeight: 0.06,
          radius: 0.54,
          label: "Guest armchair right"
        },
        {
          id: "livadia-office-sofa-left",
          position: { x: -5.45, y: 0.5, z: 1.32 },
          yaw: -1.571,
          seatHeight: 0.06,
          radius: 0.56,
          label: "Sofa left seat"
        },
        {
          id: "livadia-office-sofa-right",
          position: { x: -5.45, y: 0.5, z: 2.68 },
          yaw: -1.571,
          seatHeight: 0.06,
          radius: 0.56,
          label: "Sofa right seat"
        },
        {
          id: "livadia-office-fireplace-armchair",
          position: { x: 4.65, y: 0.48, z: 1.2 },
          yaw: 1.571,
          seatHeight: 0.06,
          radius: 0.56,
          label: "Fireplace reading armchair"
        }
      ]
    },
    bounds: { width: 14.2, height: 5.35, depth: 11.4 },
    preview: "preview.webp",
    rights: {
      owner: "vrata",
      license: "internal-original",
      clearedFor: ["staging", "production", "web-runtime", "screenshots", "optimization"],
      sourceAssets: [
        {
          id: "livadia-nicholas-office-v1-procedural-geometry-art-pass",
          type: "mesh",
          author: "Vrata/OpenCode",
          licenseRef: "LICENSES.md"
        },
        {
          id: "livadia-nicholas-office-v1-procedural-pbr-textures",
          type: "texture",
          author: "Vrata/OpenCode",
          licenseRef: "LICENSES.md"
        },
        {
          id: "livadia-nicholas-office-v1-procedural-panorama-sphere",
          type: "texture",
          author: "Vrata/OpenCode",
          licenseRef: "LICENSES.md"
        },
        {
          id: "livadia-nicholas-office-v1-procedural-preview",
          type: "texture",
          author: "Vrata/OpenCode",
          licenseRef: "LICENSES.md"
        }
      ]
    },
    visual: {
      intentionalDark: false
    },
    notes: "Original larger-scale VR office art pass: faceted sea-facing bay, transparent arched windows, procedural exterior panorama sphere, columns, coffered ceiling, procedural PBR-style damask, herringbone parquet, walnut, marble, velvet, leather, central imperial writing desk, fireplace lounge, library shelves, readable spawn, and clean-mode lighting. No external meshes, textures, fonts, photos, scans, or private source paths."
  };

  await writeFile(join(outputDir, "scene.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDir, "LICENSES.md"), `# Licenses And Provenance\n\nScene: ${manifest.label}\n\n- Geometry: original procedural mesh composition authored for Vrata/OpenCode.\n- Materials: original named PBR-style procedural materials and embedded procedural textures generated by tools/generate-livadia-office-scene.mjs.\n- Exterior panorama: original procedural equirectangular Crimea/estate panorama texture generated by tools/generate-livadia-office-scene.mjs.\n- Preview: original procedural raster preview generated from the same concept.\n- External assets: none. No third-party meshes, textures, fonts, photos, scans, or proprietary scene layouts are included.\n- Historical basis: public-domain historical theme of Nicholas II's Livadia Palace office, interpreted as a new Vrata scene rather than copied from any prior digital room or copyrighted reference package.\n- Cleared usage: staging, production, web runtime, screenshots, and optimization.\n`);
}

await main();
