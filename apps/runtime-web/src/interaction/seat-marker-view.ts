import * as THREE from "three";

import { resolveSeatRootPosition } from "../avatar/avatar-seating.js";
import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import {
  createSeatMarkerGeometries, createSeatMarkerParts, updateSeatMarkerParts,
  type SeatMarkerGeometries, type SeatMarkerParts
} from "./seat-marker-geometry.js";

export interface SeatMarkerView extends SeatMarkerParts {
  anchor: SceneBundleSeatAnchor;
  group: THREE.Group;
}

export interface SeatMarkerVisualState {
  hoveredSeatId: string | null;
  currentSeatId: string | null;
  pendingSeatId: string | null;
  occupancy: Readonly<Record<string, string>>;
  timeSeconds: number;
}

export interface SeatMarkerViewController {
  root: THREE.Group;
  hitMeshes: THREE.Object3D[];
  clear(): void;
  rebuild(anchors: SceneBundleSeatAnchor[]): void;
  update(state: SeatMarkerVisualState): void;
  getMarker(seatId: string): SeatMarkerView | null;
}

export const SEAT_MARKER_HOVER_SECONDS = 0.15;
interface MarkerTransition {
  value: number;
  from: number;
  target: number;
  startedAt: number;
}

function advanceTransition(transition: MarkerTransition, target: number, now: number): number {
  const progress = THREE.MathUtils.clamp((now - transition.startedAt) / SEAT_MARKER_HOVER_SECONDS, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  transition.value = THREE.MathUtils.lerp(transition.from, transition.target, eased);
  if (transition.target !== target) {
    transition.from = transition.value;
    transition.target = target;
    transition.startedAt = now;
  }
  return transition.value;
}

export function createSeatMarkerViewController(): SeatMarkerViewController {
  const root = new THREE.Group();
  root.name = "seat-markers";
  const hitMeshes: THREE.Object3D[] = [];
  const views = new Map<string, SeatMarkerView>();
  const transitions = new Map<string, MarkerTransition>();
  let geometry: SeatMarkerGeometries | null = null;
  let clock = 0;

  function clear(): void {
    const materials = new Set<THREE.Material>();
    for (const marker of views.values()) {
      marker.group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
        }
      });
    }
    for (const material of materials) material.dispose();
    if (geometry) for (const resource of Object.values(geometry)) resource.dispose();
    geometry = null;
    root.clear();
    views.clear();
    transitions.clear();
    // Callers retain this array; never replace it during clear/rebuild.
    hitMeshes.length = 0;
    clock = 0;
  }

  function rebuild(anchors: SceneBundleSeatAnchor[]): void {
    clear();
    if (anchors.length === 0) return;
    geometry = createSeatMarkerGeometries();
    for (const anchor of anchors) {
      const group = new THREE.Group();
      group.name = `seat-marker:${anchor.id}`;
      const position = resolveSeatRootPosition(anchor);
      group.position.set(position.x, position.y, position.z);
      group.rotation.y = anchor.yaw;
      const parts = createSeatMarkerParts(geometry);
      for (const mesh of Object.values(parts)) {
        mesh.userData.seatAnchorId = anchor.id;
        group.add(mesh);
      }
      // This mirrors authoritative visual input; it does not reserve a seat.
      // Keep the hidden collider raycastable so a busy seat cannot become a floor target.
      parts.hit.userData.seatMarkerBlocked = false;
      hitMeshes.push(parts.hit);
      root.add(group);
      views.set(anchor.id, { anchor, group, ...parts });
      transitions.set(anchor.id, { value: 0, from: 0, target: 0, startedAt: 0 });
    }
    root.updateMatrixWorld(true);
  }

  function update(input: SeatMarkerVisualState): void {
    if (Number.isFinite(input.timeSeconds)) clock = Math.max(clock, input.timeSeconds);
    for (const [seatId, marker] of views) {
      const hidden = input.currentSeatId === seatId || input.occupancy[seatId] != null;
      marker.group.visible = !hidden;
      marker.hit.userData.seatMarkerBlocked = hidden;
      const pending = input.pendingSeatId === seatId;
      const transition = transitions.get(seatId)!;
      if (hidden) {
        transition.value = transition.from = transition.target = 0;
        transition.startedAt = clock;
      }
      const emphasis = advanceTransition(transition, hidden ? 0 : pending ? 0.5 : input.hoveredSeatId === seatId ? 1 : 0, clock);
      updateSeatMarkerParts(marker, emphasis, pending && !hidden);
    }
  }

  return { root, hitMeshes, clear, rebuild, update, getMarker: (seatId) => views.get(seatId) ?? null };
}
