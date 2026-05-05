import * as THREE from "three";

import { resolveSeatRootPosition } from "../avatar/avatar-seating.js";
import type { SceneBundleSeatAnchor } from "../scene-bundle.js";

export interface SeatMarkerView {
  anchor: SceneBundleSeatAnchor;
  group: THREE.Group;
  ring: THREE.Mesh;
  beacon: THREE.Mesh;
  orb: THREE.Mesh;
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

function createSeatMarker(anchor: SceneBundleSeatAnchor, hitMeshes: THREE.Object3D[]): SeatMarkerView {
  const group = new THREE.Group();
  const markerPosition = resolveSeatRootPosition(anchor);
  group.position.set(markerPosition.x, markerPosition.y, markerPosition.z);

  const markerMaterial = new THREE.MeshBasicMaterial({
    color: 0x64d7ff,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
    depthWrite: false
  });
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(Math.max(anchor.radius * 0.7, 0.24), 0.035, 12, 32),
    markerMaterial.clone()
  );
  ring.userData.seatAnchorId = anchor.id;
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.06;
  group.add(ring);
  hitMeshes.push(ring);

  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.026, 0.026, 0.48, 12),
    markerMaterial.clone()
  );
  beacon.userData.seatAnchorId = anchor.id;
  beacon.position.y = 0.36;
  group.add(beacon);
  hitMeshes.push(beacon);

  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 14, 14),
    markerMaterial.clone()
  );
  orb.userData.seatAnchorId = anchor.id;
  orb.position.y = 0.64;
  group.add(orb);
  hitMeshes.push(orb);

  return { anchor, group, ring, beacon, orb };
}

function updateMaterialColor(material: THREE.Material | THREE.Material[], color: number, opacity: number): void {
  if (material instanceof THREE.MeshBasicMaterial) {
    material.color.setHex(color);
    material.opacity = opacity;
  }
}

export function createSeatMarkerViewController(): SeatMarkerViewController {
  const root = new THREE.Group();
  const hitMeshes: THREE.Object3D[] = [];
  let views = new Map<string, SeatMarkerView>();

  function clear(): void {
    root.clear();
    views = new Map<string, SeatMarkerView>();
    hitMeshes.length = 0;
  }

  function rebuild(anchors: SceneBundleSeatAnchor[]): void {
    clear();
    for (const anchor of anchors) {
      const marker = createSeatMarker(anchor, hitMeshes);
      root.add(marker.group);
      views.set(anchor.id, marker);
    }
  }

  function update(input: SeatMarkerVisualState): void {
    for (const [seatId, marker] of views.entries()) {
      const occupantId = input.occupancy[seatId] ?? null;
      const isCurrent = input.currentSeatId === seatId;
      const isHovered = input.hoveredSeatId === seatId;
      const isPending = input.pendingSeatId === seatId;
      const isOccupied = occupantId !== null;
      const color = isCurrent
        ? 0x66ff99
        : isHovered
          ? 0xb8ff8d
          : isPending
            ? 0xffd166
            : isOccupied
              ? 0xff7b7b
              : 0x64d7ff;
      const opacity = isCurrent || isHovered ? 1 : isOccupied ? 0.55 : 0.82;
      const scale = isCurrent ? 1.18 : isHovered ? 1.12 : 1;
      const bob = isCurrent || isHovered ? Math.sin(input.timeSeconds * 4 + marker.anchor.position.x) * 0.03 : 0;

      updateMaterialColor(marker.ring.material, color, opacity);
      updateMaterialColor(marker.beacon.material, color, Math.min(1, opacity + 0.08));
      updateMaterialColor(marker.orb.material, color, Math.min(1, opacity + 0.12));

      marker.group.visible = true;
      marker.group.scale.setScalar(scale);
      marker.ring.position.y = 0.06 + bob * 0.3;
      marker.beacon.position.y = 0.36 + bob * 0.6;
      marker.orb.position.y = 0.64 + bob;
    }
  }

  return {
    root,
    hitMeshes,
    clear,
    rebuild,
    update,
    getMarker(seatId) {
      return views.get(seatId) ?? null;
    }
  };
}
