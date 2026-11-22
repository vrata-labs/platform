export interface FloorPoint { x: number; y: number; z: number }

/** Clear standing footprint, in world metres. */
export interface SceneFloorArea {
  y: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Unique original GLB node selected from the indicated level (stairs, lift, etc.). */
export interface SceneFloorLink { fromY: number; node: string; destination: FloorPoint }

export function isFloorPoint(value: unknown): value is FloorPoint {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<FloorPoint>;
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

export function onFloorArea(a: SceneFloorArea, p: FloorPoint): boolean {
  return Math.abs(a.y - p.y) < 0.01 && p.x >= a.minX && p.x <= a.maxX && p.z >= a.minZ && p.z <= a.maxZ;
}

export function isWalkablePoint(areas: SceneFloorArea[], point: FloorPoint): boolean {
  return areas.some(a => onFloorArea(a, point));
}

export function isSceneFloorAreas(value: unknown): value is SceneFloorArea[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return false;
  return value.every(a => a && [a.y, a.minX, a.maxX, a.minZ, a.maxZ].every(Number.isFinite)
    && a.minX < a.maxX && a.minZ < a.maxZ);
}

export function isSceneFloorLinks(value: unknown, areas: SceneFloorArea[]): value is SceneFloorLink[] {
  return Array.isArray(value) && value.length <= 128 && value.every((link, i) => link && typeof link.node === "string"
    && link.node.trim().length > 0 && areas.some(a => a.y === link.fromY) && isFloorPoint(link.destination)
    && isWalkablePoint(areas, link.destination) && !value.slice(0, i).some(other => other.node === link.node && other.fromY === link.fromY));
}
