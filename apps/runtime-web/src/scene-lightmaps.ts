import * as THREE from "three";

interface BakedLightMapUserData {
  vrataLightMap?: unknown;
  vrataLightMapIntensity?: unknown;
  vrataOriginalEmissive?: unknown;
  vrataOriginalEmissiveIntensity?: unknown;
  vrataLightMapIncludesEnvironment?: unknown;
}

export type BakedEnvironmentMode = "legacy" | "pending-compile" | "specular-only" | "fallback";

const environmentModes = new WeakMap<THREE.Material, BakedEnvironmentMode>();
const physicalInclude = "#include <lights_physical_pars_fragment>";
const environmentDiffuse = "reflectedLight.indirectDiffuse += diffuse * cosineWeightedIrradiance;";

export function getBakedEnvironmentMode(material: THREE.Material): BakedEnvironmentMode {
  return environmentModes.get(material) ?? "legacy";
}

function installBakedEnvironment(material: THREE.MeshStandardMaterial, physicalChunk: string): void {
  const originalCompile = material.onBeforeCompile;
  const originalKey = material.customProgramCacheKey;
  const defaultKey = originalKey === THREE.Material.prototype.customProgramCacheKey
    ? originalCompile.toString()
    : null;
  material.customProgramCacheKey = () => `${defaultKey ?? originalKey.call(material)}:vrata-baked-environment-v1`;
  environmentModes.set(material, "pending-compile");
  material.onBeforeCompile = function (shader, renderer) {
    originalCompile.call(this, shader, renderer);
    if (!shader.fragmentShader.includes(physicalInclude)) {
      // A custom material hook may replace the standard physical shader entirely.
      // Keep that shader usable and expose the fallback rather than compiling invalid GLSL.
      environmentModes.set(this, "fallback");
      return;
    }
    shader.fragmentShader = shader.fragmentShader.replace(physicalInclude, physicalChunk);
    environmentModes.set(this, "specular-only");
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function emissiveColor(value: unknown): THREE.Color {
  if (!Array.isArray(value) || value.length < 3 || value.slice(0, 3).some((channel) => typeof channel !== "number" || !Number.isFinite(channel))) {
    return new THREE.Color(0, 0, 0);
  }
  return new THREE.Color(value[0], value[1], value[2]);
}

export function applyBakedLightMaps(root: THREE.Object3D): number {
  const materials = new Set<THREE.MeshStandardMaterial>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const candidate of objectMaterials) {
      if (!(candidate instanceof THREE.MeshStandardMaterial)) continue;
      const metadata = candidate.userData as BakedLightMapUserData;
      if (metadata.vrataLightMap !== true) continue;
      if (metadata.vrataLightMapIncludesEnvironment !== undefined && typeof metadata.vrataLightMapIncludesEnvironment !== "boolean") {
        throw new Error(`invalid_baked_environment_metadata:${candidate.name || candidate.uuid}`);
      }
      if (!object.geometry.getAttribute("uv1")) {
        throw new Error(`missing_baked_lightmap_uv:${object.name || object.uuid}`);
      }
      if (!candidate.emissiveMap || candidate.emissiveMap.channel !== 1) {
        throw new Error(`invalid_baked_lightmap_material:${candidate.name || candidate.uuid}`);
      }
      materials.add(candidate);
    }
  });

  const needsBakedEnvironment = Array.from(materials).some((material) => material.userData.vrataLightMapIncludesEnvironment === true);
  const physicalSource = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (needsBakedEnvironment && physicalSource.split(environmentDiffuse).length !== 2) {
    throw new Error("unsupported_baked_environment_shader");
  }
  // The atlas already includes indirect diffuse/environment illumination. Keep
  // environment specular and multiscattering, but do not add IBL diffuse again.
  const bakedPhysicalChunk = physicalSource.replace(environmentDiffuse, "// Diffuse environment irradiance is already included in the baked lightmap.");

  for (const material of materials) {
    const metadata = material.userData as BakedLightMapUserData;
    material.lightMap = material.emissiveMap;
    material.lightMapIntensity = finiteNumber(metadata.vrataLightMapIntensity, 1);
    material.emissiveMap = null;
    material.emissive.copy(emissiveColor(metadata.vrataOriginalEmissive));
    material.emissiveIntensity = finiteNumber(metadata.vrataOriginalEmissiveIntensity, 0);
    if (metadata.vrataLightMapIncludesEnvironment === true) {
      installBakedEnvironment(material, bakedPhysicalChunk);
    }
    material.needsUpdate = true;
  }

  return materials.size;
}
