import * as THREE from "three";

interface BakedLightMapUserData {
  vrataLightMap?: unknown;
  vrataLightMapIntensity?: unknown;
  vrataOriginalEmissive?: unknown;
  vrataOriginalEmissiveIntensity?: unknown;
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
      if (!object.geometry.getAttribute("uv1")) {
        throw new Error(`missing_baked_lightmap_uv:${object.name || object.uuid}`);
      }
      if (!candidate.emissiveMap || candidate.emissiveMap.channel !== 1) {
        throw new Error(`invalid_baked_lightmap_material:${candidate.name || candidate.uuid}`);
      }
      materials.add(candidate);
    }
  });

  for (const material of materials) {
    const metadata = material.userData as BakedLightMapUserData;
    material.lightMap = material.emissiveMap;
    material.lightMapIntensity = finiteNumber(metadata.vrataLightMapIntensity, 1);
    material.emissiveMap = null;
    material.emissive.copy(emissiveColor(metadata.vrataOriginalEmissive));
    material.emissiveIntensity = finiteNumber(metadata.vrataOriginalEmissiveIntensity, 0);
    material.needsUpdate = true;
  }

  return materials.size;
}
