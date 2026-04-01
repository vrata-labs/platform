import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import { parseSceneBundleManifest, pickSceneSpawnPoint, resolveSceneAssetUrl, type SceneBundleManifest } from "./scene-bundle.js";

export interface LoadedSceneBundle {
  manifest: SceneBundleManifest;
  group: THREE.Group;
  spawnPointApplied: boolean;
  spawnPointId: string | null;
  assetUrl: string;
  assetType: string;
  loadMs: number;
  missingAssets: string[];
}

export interface GltfLoaderOptions {
  renderer?: THREE.WebGLRenderer;
  dracoDecoderPath?: string;
  ktx2TranscoderPath?: string;
}

export function configureGltfLoader(loader: GLTFLoader, options: GltfLoaderOptions = {}): GLTFLoader {
  loader.setMeshoptDecoder(MeshoptDecoder);

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(options.dracoDecoderPath ?? "https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  loader.setDRACOLoader(dracoLoader);

  if (options.renderer) {
    const ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath(options.ktx2TranscoderPath ?? "https://unpkg.com/three@0.176.0/examples/jsm/libs/basis/");
    ktx2Loader.detectSupport(options.renderer);
    loader.setKTX2Loader(ktx2Loader);
  }

  return loader;
}

function materialOverrideMatches(pattern: string, materialName: string): boolean {
  if (pattern.endsWith("*")) {
    return materialName.startsWith(pattern.slice(0, -1));
  }
  return materialName === pattern;
}

async function applyMaterialOverrides(input: {
  root: THREE.Object3D;
  manifest: SceneBundleManifest;
  bundleUrl: string;
}): Promise<void> {
  if (!input.manifest.materialOverrides || input.manifest.materialOverrides.length === 0) {
    return;
  }
  const textureLoader = new THREE.TextureLoader();
  const textureCache = new Map<string, Promise<THREE.Texture>>();

  input.root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (!(material instanceof THREE.Material)) {
        return;
      }
      const override = input.manifest.materialOverrides?.find((entry) => materialOverrideMatches(entry.match, material.name));
      if (!override) {
        return;
      }
      if (override.color && "color" in material) {
        const colorMaterial = material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial | THREE.MeshPhongMaterial;
        colorMaterial.color.setRGB(override.color.r, override.color.g, override.color.b);
      }
      if (override.mapPath && "map" in material) {
        const mapMaterial = material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial | THREE.MeshPhongMaterial;
        const textureUrl = resolveSceneAssetUrl(input.bundleUrl, override.mapPath);
        if (!textureCache.has(textureUrl)) {
          textureCache.set(textureUrl, textureLoader.loadAsync(textureUrl).then((texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            return texture;
          }));
        }
        textureCache.get(textureUrl)?.then((texture) => {
          mapMaterial.map = texture;
          mapMaterial.needsUpdate = true;
        }).catch(() => undefined);
      }
    });
  });

  await Promise.allSettled(Array.from(textureCache.values()));
}

export async function loadSceneBundle(input: {
  scene: THREE.Scene;
  player: THREE.Object3D;
  bundleUrl: string;
}): Promise<LoadedSceneBundle> {
  const startedAt = performance.now();
  const response = await fetch(input.bundleUrl);
  if (!response.ok) {
    throw new Error(`failed_to_load_scene_bundle_manifest:${response.status}`);
  }

  const manifest = parseSceneBundleManifest(await response.json());
  const group = new THREE.Group();
  group.name = `scene-bundle:${manifest.sceneId}`;
  const sceneAssetUrl = resolveSceneAssetUrl(response.url, manifest.glbPath);
  const missingAssets = new Set<string>();
  if (/[.]fbx$/i.test(sceneAssetUrl)) {
    const manager = new THREE.LoadingManager();
    manager.onError = (url) => {
      missingAssets.add(url);
    };
    const loader = new FBXLoader(manager);
    const fbx = await loader.loadAsync(sceneAssetUrl);
    group.add(fbx);
  } else {
    const manager = new THREE.LoadingManager();
    manager.onError = (url) => {
      missingAssets.add(url);
    };
    const loader = configureGltfLoader(new GLTFLoader(manager));
    const gltf = await loader.loadAsync(sceneAssetUrl);
    group.add(gltf.scene);
  }
  await applyMaterialOverrides({
    root: group,
    manifest,
    bundleUrl: response.url
  });
  input.scene.add(group);

  const spawnPoint = pickSceneSpawnPoint(manifest);
  if (spawnPoint) {
    input.player.position.set(spawnPoint.position.x, spawnPoint.position.y, spawnPoint.position.z);
  }

  return {
    manifest,
    group,
    spawnPointApplied: Boolean(spawnPoint),
    spawnPointId: spawnPoint?.id ?? null,
    assetUrl: sceneAssetUrl,
    assetType: sceneAssetUrl.split(".").pop()?.toLowerCase() ?? "unknown",
    loadMs: Math.round(performance.now() - startedAt),
    missingAssets: Array.from(missingAssets)
  };
}
