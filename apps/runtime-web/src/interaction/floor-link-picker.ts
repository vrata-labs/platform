import * as THREE from "three";
import type { SceneFloorLink } from "@vrata/shared-types";
import type { InteractionTarget } from "./interaction-targets.js";

export type FloorLinkPicker = (ray: THREE.Ray, floorY: number, maxDistance: number) =>
  Extract<InteractionTarget, { kind: "floor" }> | null;

/** Bind authored links once. Only an actual visible triangle of the uniquely
 * named GLB node (or one of its primitives) activates the link. */
export function createFloorLinkPicker(root: THREE.Object3D | null, links?: SceneFloorLink[]): FloorLinkPicker | undefined {
  if (!root || !links?.length) return undefined;
  const meshes: THREE.Mesh[] = [];
  const nodes = new Map<string, THREE.Object3D[]>();
  root.traverseVisible(object => {
    if (object instanceof THREE.Mesh) meshes.push(object);
    const name = object.userData.name ?? object.name;
    if (name) nodes.set(name, [...(nodes.get(name) ?? []), object]);
  });
  const levels = new Map<number, Map<THREE.Object3D, SceneFloorLink>>();
  for (const link of links) {
    const candidates = nodes.get(link.node);
    if (candidates?.length !== 1) continue;
    const level = levels.get(link.fromY) ?? new Map();
    levels.set(link.fromY, level);
    candidates[0].traverseVisible(o => { if (o instanceof THREE.Mesh) level.set(o, link); });
  }
  const caster = new THREE.Raycaster();
  return (ray, y, maxDistance) => {
    const level = levels.get(y);
    if (!level) return null;
    caster.ray.copy(ray); caster.far = maxDistance;
    const hit = caster.intersectObjects([...level.keys()], false)[0];
    if (!hit) return null;
    caster.far = hit.distance - 0.005;
    if (caster.intersectObjects(meshes, false).some(other => !level.has(other.object))) return null;
    return { kind: "floor", point: hit.point, destination: level.get(hit.object)!.destination };
  };
}
