import * as THREE from "three";

export function disposeSceneObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();

  function collectUniformTextures(value: unknown, visited: Set<object>): void {
    if (value instanceof THREE.Texture) {
      textures.add(value);
      return;
    }
    if (!value || typeof value !== "object" || visited.has(value)) {
      return;
    }
    visited.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      collectUniformTextures(child, visited);
    }
  }

  root.traverse((object) => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (renderable.geometry instanceof THREE.BufferGeometry) {
      geometries.add(renderable.geometry);
    }
    const objectMaterials = Array.isArray(renderable.material)
      ? renderable.material
      : renderable.material
        ? [renderable.material]
        : [];
    for (const material of objectMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) {
          textures.add(value);
        }
      }
      if (material instanceof THREE.ShaderMaterial) {
        collectUniformTextures(material.uniforms, new Set());
      }
    }
    if (object instanceof THREE.SkinnedMesh) {
      skeletons.add(object.skeleton);
    }
  });

  root.removeFromParent();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
