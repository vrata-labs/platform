import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import { resolveLocalSeatId } from "../seating/seating-controller.js";

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

export { resolveLocalSeatId };
