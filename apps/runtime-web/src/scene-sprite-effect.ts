import { DoubleSide, Mesh, MeshStandardMaterial, ShaderMaterial, Vector2, type Object3D } from "three";
import type { SceneSpriteEffect } from "@vrata/shared-types";

export function collectSpriteMeshes(root: Object3D) {
  const meshes: Array<Mesh & { material: MeshStandardMaterial }> = [];
  root.traverse(node => {
    if (!(node instanceof Mesh)) return;
    if (!(node.material instanceof MeshStandardMaterial) || !node.material.map || !node.material.emissiveMap || !node.geometry.hasAttribute("uv")) {
      throw new Error("invalid_scene_sprite_material");
    }
    meshes.push(node as Mesh & { material: MeshStandardMaterial });
  });
  if (!meshes.length || meshes.length > 16) throw new Error("invalid_scene_sprite_count");
  return meshes;
}

/** Bounded animation of GLB textures already owned by the scene. No executable asset content. */
export function createSceneSpriteAnimator(meshes: ReturnType<typeof collectSpriteMeshes>, atlas: SceneSpriteEffect["atlas"]) {
  const frames = atlas.columns * atlas.rows;
  const grid = new Vector2(atlas.columns, atlas.rows);
  const sprites = meshes.map(mesh => {
    const source = mesh.material;
    const frame = { value: 0 };
    const animated = new ShaderMaterial({
      uniforms: {
        frame, grid: { value: grid }, albedo: { value: source.map }, emission: { value: source.emissiveMap },
        tint: { value: source.emissive.clone().multiplyScalar(source.emissiveIntensity) }
      },
      vertexShader: `
        varying vec2 spriteUv;
        void main() { spriteUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }
      `,
      fragmentShader: `
        uniform float frame; uniform vec2 grid; uniform sampler2D albedo, emission; uniform vec3 tint;
        varying vec2 spriteUv;
        void main() {
          vec2 cell = vec2(mod(frame, grid.x), floor(frame / grid.x));
          vec2 st = (cell + clamp(spriteUv, vec2(.004), vec2(.996))) / grid;
          vec4 c = texture2D(albedo, st);
          if (c.a < .01) discard;
          gl_FragColor = vec4(c.rgb + texture2D(emission, st).r * tint, c.a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: DoubleSide, transparent: true, depthWrite: false
    });
    (mesh as Mesh).material = animated;
    return { mesh, source, animated, frame };
  });
  return {
    update(seconds: number) {
      for (let i = 0; i < sprites.length; i++) {
        const phase = (seconds / atlas.cycleSeconds + i / sprites.length) % 1;
        sprites[i]!.frame.value = Math.floor(frames * phase * phase * (3 - 2 * phase));
      }
    },
    dispose() {
      for (const { mesh, source, animated } of sprites) {
        mesh.material = source;
        animated.dispose();
      }
    }
  };
}
