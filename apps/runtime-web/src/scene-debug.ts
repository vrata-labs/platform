import * as THREE from "three";

export interface SceneDiagnosticsSnapshot {
  bundleUrl: string | null;
  state: "fallback" | "loaded" | "failed";
  label: string | null;
  source: string | null;
  assetUrl: string | null;
  assetType: string | null;
  spawnPointId: string | null;
  spawnApplied: boolean;
  loadMs: number | null;
  objectCount: number;
  meshCount: number;
  materialCount: number;
  texturedMaterialCount: number;
  geometryCount: number;
  triangleEstimate: number;
  textureCount: number;
  missingAssets: string[];
  materialSamples: Array<{
    name: string;
    meshCount: number;
    hasMap: boolean;
    hasNormalMap: boolean;
    hasAoMap: boolean;
    color?: { r: number; g: number; b: number } | null;
    mapSource?: string | null;
  }>;
  boundingBox: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
    size: { x: number; y: number; z: number };
    center: { x: number; y: number; z: number };
  } | null;
  camera: {
    world: { x: number; y: number; z: number };
    forward: { x: number; y: number; z: number };
  } | null;
  screenshot: {
    width: number;
    height: number;
    centerPixel: { r: number; g: number; b: number; a: number };
    averageColor: { r: number; g: number; b: number; a: number };
    darkPixelRatio: number;
    pixelSamples: Array<{ x: number; y: number; r: number; g: number; b: number; a: number }>;
    dataUrl?: string;
  } | null;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function colorFromData(data: Uint8ClampedArray, offset: number) {
  return {
    r: data[offset] ?? 0,
    g: data[offset + 1] ?? 0,
    b: data[offset + 2] ?? 0,
    a: data[offset + 3] ?? 0
  };
}

export function createEmptySceneDiagnostics(): SceneDiagnosticsSnapshot {
  return {
    bundleUrl: null,
    state: "fallback",
    label: null,
    source: null,
    assetUrl: null,
    assetType: null,
    spawnPointId: null,
    spawnApplied: false,
    loadMs: null,
    objectCount: 0,
    meshCount: 0,
    materialCount: 0,
    texturedMaterialCount: 0,
    geometryCount: 0,
    triangleEstimate: 0,
    textureCount: 0,
    missingAssets: [],
    materialSamples: [],
    boundingBox: null,
    camera: null,
    screenshot: null
  };
}

export function inspectSceneObject(input: {
  root: THREE.Object3D;
  camera: THREE.Camera;
  previous: SceneDiagnosticsSnapshot;
}): SceneDiagnosticsSnapshot {
  const materialKeys = new Set<string>();
  const geometryKeys = new Set<string>();
  const textureKeys = new Set<string>();
  const materialSamples = new Map<string, {
    name: string;
    meshCount: number;
    hasMap: boolean;
    hasNormalMap: boolean;
    hasAoMap: boolean;
    color?: { r: number; g: number; b: number } | null;
    mapSource?: string | null;
  }>();
  let objectCount = 0;
  let meshCount = 0;
  let texturedMaterialCount = 0;
  let triangleEstimate = 0;

  input.root.traverse((child) => {
    objectCount += 1;
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    meshCount += 1;
    if (child.geometry) {
      geometryKeys.add(child.geometry.uuid);
      if (child.geometry.index) {
        triangleEstimate += Math.floor(child.geometry.index.count / 3);
      } else if (child.geometry.attributes.position) {
        triangleEstimate += Math.floor(child.geometry.attributes.position.count / 3);
      }
    }
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!(material instanceof THREE.Material)) {
        continue;
      }
      materialKeys.add(material.uuid);
      const maybeTextured = material as THREE.MeshStandardMaterial & { map?: THREE.Texture | null; normalMap?: THREE.Texture | null; emissiveMap?: THREE.Texture | null; alphaMap?: THREE.Texture | null; aoMap?: THREE.Texture | null; roughnessMap?: THREE.Texture | null; metalnessMap?: THREE.Texture | null; specularMap?: THREE.Texture | null; }; 
      const textures = [maybeTextured.map, maybeTextured.normalMap, maybeTextured.emissiveMap, maybeTextured.alphaMap, maybeTextured.aoMap, maybeTextured.roughnessMap, maybeTextured.metalnessMap, maybeTextured.specularMap].filter(Boolean) as THREE.Texture[];
      if (textures.length > 0) {
        texturedMaterialCount += 1;
      }
      for (const texture of textures) {
        textureKeys.add(texture.uuid);
      }
      const sampleKey = material.name || material.uuid;
      const existing = materialSamples.get(sampleKey) ?? {
        name: material.name || "(unnamed)",
        meshCount: 0,
        hasMap: false,
        hasNormalMap: false,
        hasAoMap: false,
        color: null,
        mapSource: null
      };
      existing.meshCount += 1;
      existing.hasMap = existing.hasMap || Boolean(maybeTextured.map);
      existing.hasNormalMap = existing.hasNormalMap || Boolean(maybeTextured.normalMap);
      existing.hasAoMap = existing.hasAoMap || Boolean(maybeTextured.aoMap);
      if ("color" in maybeTextured && maybeTextured.color instanceof THREE.Color) {
        existing.color = {
          r: round(maybeTextured.color.r),
          g: round(maybeTextured.color.g),
          b: round(maybeTextured.color.b)
        };
      }
      if (maybeTextured.map?.source && typeof maybeTextured.map.source.data === "object" && maybeTextured.map.source.data && "currentSrc" in maybeTextured.map.source.data) {
        existing.mapSource = String((maybeTextured.map.source.data as { currentSrc?: string }).currentSrc ?? "");
      }
      materialSamples.set(sampleKey, existing);
    }
  });

  const boundingBox = new THREE.Box3().setFromObject(input.root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  const hasBounds = Number.isFinite(boundingBox.min.x) && !boundingBox.isEmpty();
  if (hasBounds) {
    boundingBox.getSize(size);
    boundingBox.getCenter(center);
  }

  const cameraWorld = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();
  input.camera.getWorldPosition(cameraWorld);
  input.camera.getWorldDirection(cameraForward);

  return {
    ...input.previous,
    objectCount,
    meshCount,
    materialCount: materialKeys.size,
    texturedMaterialCount,
    geometryCount: geometryKeys.size,
    triangleEstimate,
    textureCount: textureKeys.size,
    materialSamples: Array.from(materialSamples.values()).sort((a, b) => b.meshCount - a.meshCount).slice(0, 40),
    boundingBox: hasBounds ? {
      min: { x: round(boundingBox.min.x), y: round(boundingBox.min.y), z: round(boundingBox.min.z) },
      max: { x: round(boundingBox.max.x), y: round(boundingBox.max.y), z: round(boundingBox.max.z) },
      size: { x: round(size.x), y: round(size.y), z: round(size.z) },
      center: { x: round(center.x), y: round(center.y), z: round(center.z) }
    } : null,
    camera: {
      world: { x: round(cameraWorld.x), y: round(cameraWorld.y), z: round(cameraWorld.z) },
      forward: { x: round(cameraForward.x), y: round(cameraForward.y), z: round(cameraForward.z) }
    }
  };
}

export function captureCanvasDiagnostics(input: {
  canvas: HTMLCanvasElement;
  includeImage: boolean;
}): SceneDiagnosticsSnapshot["screenshot"] {
  const width = Math.max(1, Math.min(320, input.canvas.width || 1));
  const height = Math.max(1, Math.min(180, input.canvas.height || 1));
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  context.drawImage(input.canvas, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  let darkCount = 0;
  const pixelSamples: Array<{ x: number; y: number; r: number; g: number; b: number; a: number }> = [];
  const samplePoints = [
    [0.5, 0.5],
    [0.1, 0.1],
    [0.9, 0.1],
    [0.1, 0.9],
    [0.9, 0.9],
    [0.5, 0.2],
    [0.5, 0.8]
  ];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3] ?? 0;
    sumR += r;
    sumG += g;
    sumB += b;
    sumA += a;
    if ((r + g + b) / 3 < 24) {
      darkCount += 1;
    }
  }

  for (const [xRatio, yRatio] of samplePoints) {
    const x = Math.min(width - 1, Math.max(0, Math.round((width - 1) * xRatio)));
    const y = Math.min(height - 1, Math.max(0, Math.round((height - 1) * yRatio)));
    const offset = (y * width + x) * 4;
    pixelSamples.push({ x, y, ...colorFromData(data, offset) });
  }

  const centerOffset = ((Math.floor(height / 2) * width) + Math.floor(width / 2)) * 4;
  const pixelCount = Math.max(1, width * height);
  const screenshot = {
    width,
    height,
    centerPixel: colorFromData(data, centerOffset),
    averageColor: {
      r: Math.round(sumR / pixelCount),
      g: Math.round(sumG / pixelCount),
      b: Math.round(sumB / pixelCount),
      a: Math.round(sumA / pixelCount)
    },
    darkPixelRatio: Number((darkCount / pixelCount).toFixed(4)),
    pixelSamples
  };

  if (input.includeImage) {
    return {
      ...screenshot,
      dataUrl: scratch.toDataURL("image/jpeg", 0.72)
    };
  }
  return screenshot;
}
