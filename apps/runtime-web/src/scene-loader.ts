import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import { parseSceneBundleManifest, pickSceneSpawnPoint, resolveSceneAssetUrl, type SceneBundleManifest, type SceneBundleSpawnPoint } from "./scene-bundle.js";
import { disposeSceneObject } from "./scene-dispose.js";
import { applyBakedLightMaps } from "./scene-lightmaps.js";
import { SceneEffects } from "./scene-effects.js";
import { isSceneAudioWav, SCENE_AUDIO_MAX_BYTES, type SceneBundleIntegrity } from "@vrata/shared-types";
import { assertSelfContainedGlb, verifySceneBytes } from "./scene-integrity.js";
import type { PrivateSceneFileFetch } from "./private-scene-source.js";

export interface LoadedSceneBundle {
  effects?: SceneEffects;
  manifest: SceneBundleManifest;
  group: THREE.Group;
  spawnPointApplied: boolean;
  spawnPointId: string | null;
  spawnPoint: SceneBundleSpawnPoint | null;
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
  bundleUrl: string;
  privateFile?: PrivateSceneFileFetch;
  integrity?: SceneBundleIntegrity;
  renderer?: THREE.WebGLRenderer;
  onLoadStage?: (stage: string) => void;
  onAssetProgress?: (loaded: number, expected: number | null) => void;
}): Promise<LoadedSceneBundle> {
  const startedAt = performance.now();
  input.onLoadStage?.("manifest_requested");
  if (input.privateFile && !input.integrity) throw new Error("private_scene_integrity_required");
  const response = input.privateFile ? await input.privateFile("scene.json") : await fetch(input.bundleUrl);
  if (!response.ok) {
    throw new Error(`failed_to_load_scene_bundle_manifest:${response.status}`);
  }

  let manifestData: unknown;
  if (input.integrity) {
    const bytes = await response.arrayBuffer();
    await verifySceneBytes(bytes, input.integrity.manifestSha256, "manifest");
    manifestData = JSON.parse(new TextDecoder().decode(bytes));
    input.onLoadStage?.("manifest_verified");
  } else manifestData = await response.json();
  const manifest = parseSceneBundleManifest(manifestData);
  if (input.integrity && manifest.materialOverrides?.some(override => override.mapPath)) throw new Error("verified_scene_external_resource");
  input.onLoadStage?.("manifest_loaded");
  const group = new THREE.Group();
  group.name = `scene-bundle:${manifest.sceneId}`;
  if (input.privateFile && manifest.glbPath!=="scene.glb") throw new Error("private_scene_expected_glb");
  const logicalBase=input.privateFile ? input.bundleUrl : response.url;
  const sceneAssetUrl = resolveSceneAssetUrl(logicalBase, manifest.glbPath);
  if (input.integrity && !/[.]glb$/i.test(sceneAssetUrl)) throw new Error("verified_scene_requires_glb");
  const missingAssets = new Set<string>();
  let effects: SceneEffects | undefined;
  input.onLoadStage?.("asset_load_started");
  if (/[.]fbx$/i.test(sceneAssetUrl)) {
    if (manifest.renderProfile === "baked-pbr-v1") {
      throw new Error("unsupported_baked_pbr_asset:fbx");
    }
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
    const loader = configureGltfLoader(new GLTFLoader(manager), { renderer: input.renderer });
    let gltf;
    if (/[.]glb$/i.test(sceneAssetUrl)) {
      input.onLoadStage?.("asset_response_requested");
      const assetResponse = input.privateFile ? await input.privateFile("scene.glb") : await fetch(sceneAssetUrl);
      if (!assetResponse.ok) {
        throw new Error(`failed_to_load_scene_asset:${assetResponse.status}`);
      }
      input.onLoadStage?.("asset_response_received");
      const expectedBytes = Number.parseInt(assetResponse.headers.get("content-length") ?? "", 10);
      const expected = Number.isFinite(expectedBytes) ? expectedBytes : null;
      const assetBuffer = await assetResponse.arrayBuffer();
      input.onAssetProgress?.(assetBuffer.byteLength, expected);
      input.onLoadStage?.("asset_buffer_loaded");
      if (input.integrity) {
        await verifySceneBytes(assetBuffer, input.integrity.assetSha256, "asset");
        assertSelfContainedGlb(assetBuffer);
        input.onLoadStage?.("asset_verified");
      }
      gltf = await loader.parseAsync(assetBuffer, new URL("./", sceneAssetUrl).toString());
      input.onLoadStage?.("asset_parsed");
    } else {
      gltf = await loader.loadAsync(sceneAssetUrl);
    }
    try {
      if (manifest.renderProfile === "baked-pbr-v1") {
        const lightMappedMaterialCount = applyBakedLightMaps(gltf.scene);
        if (lightMappedMaterialCount === 0) {
          throw new Error("missing_baked_lightmaps");
        }
      }
      if (manifest.sceneEffects?.length) effects = new SceneEffects(gltf.scene, gltf.animations, manifest.sceneEffects, async (sound, signal) => {
        const audio = input.privateFile ? await input.privateFile(sound.path, signal) :
          await fetch(resolveSceneAssetUrl(logicalBase, sound.path), { signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
        const reader = audio.body?.getReader();
        try {
          if (!audio.ok || !reader || Number(audio.headers.get("content-length")) > SCENE_AUDIO_MAX_BYTES) throw new Error("scene_audio_unavailable");
          const buffer = new Uint8Array(SCENE_AUDIO_MAX_BYTES);
          let length = 0;
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            if (length + value.length > buffer.length) throw new Error("scene_audio_too_large");
            buffer.set(value, length);
            length += value.length;
          }
          const bytes = buffer.slice(0, length);
          if (!isSceneAudioWav(bytes)) throw new Error("invalid_scene_audio");
          await verifySceneBytes(bytes.buffer, sound.sha256, "audio");
          return bytes.buffer;
        } finally {
          if (reader) void reader.cancel().catch(() => undefined);
        }
      });
      group.add(gltf.scene);
    } catch (error) {
      disposeSceneObject(gltf.scene);
      throw error;
    }
  }
  input.onLoadStage?.("asset_loaded");
  await applyMaterialOverrides({
    root: group,
    manifest,
    bundleUrl: logicalBase
  });
  input.onLoadStage?.("material_overrides_applied");

  const spawnPoint = pickSceneSpawnPoint(manifest);

  return {
    effects,
    manifest,
    group,
    spawnPointApplied: false,
    spawnPointId: spawnPoint?.id ?? null,
    spawnPoint,
    assetUrl: sceneAssetUrl,
    assetType: sceneAssetUrl.split(".").pop()?.toLowerCase() ?? "unknown",
    loadMs: Math.round(performance.now() - startedAt),
    missingAssets: Array.from(missingAssets)
  };
}
