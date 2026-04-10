import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";

export interface AvatarSeatState {
  currentSeatId: string | null;
  pendingSeatId: string | null;
}

export function createAvatarSeatAnchorMap(anchors: SceneBundleSeatAnchor[]): Map<string, SceneBundleSeatAnchor> {
  return new Map(anchors.map((anchor) => [anchor.id, anchor]));
}

export function resolveSeatRootPosition(anchor: SceneBundleSeatAnchor): { x: number; y: number; z: number } {
  return {
    x: anchor.position.x,
    y: anchor.position.y + anchor.seatHeight,
    z: anchor.position.z
  };
}

export function applySeatAnchorToPlayer(player: THREE.Object3D, anchor: SceneBundleSeatAnchor): void {
  const position = resolveSeatRootPosition(anchor);
  player.position.set(position.x, position.y, position.z);
  player.rotation.y = anchor.yaw;
}

export function resolveLocalSeatId(seatOccupancy: Record<string, string>, participantId: string): string | null {
  for (const [seatId, occupantId] of Object.entries(seatOccupancy)) {
    if (occupantId === participantId) {
      return seatId;
    }
  }
  return null;
}
