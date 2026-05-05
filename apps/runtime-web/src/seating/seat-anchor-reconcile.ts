import type { RuntimeCommand } from "../locomotion/runtime-commands.js";
import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import { removeLocalSeatFromOccupancy } from "./seat-occupancy.js";
import type { SeatingCommand } from "./seating-controller.js";

export interface SeatAnchorReadModel {
  anchors: SceneBundleSeatAnchor[];
  anchorMap: Map<string, SceneBundleSeatAnchor>;
  availableSeatIds: Set<string>;
  teleportFloorY: number;
}

export interface SeatAnchorReconciliationPlan {
  seatOccupancy: Record<string, string>;
  commands: RuntimeCommand[];
  resetSeatLock: boolean;
}

export function createSeatAnchorReadModel(anchors: SceneBundleSeatAnchor[], teleportFloorY = 0): SeatAnchorReadModel {
  return {
    anchors,
    anchorMap: new Map(anchors.map((anchor) => [anchor.id, anchor])),
    availableSeatIds: new Set(anchors.map((anchor) => anchor.id)),
    teleportFloorY
  };
}

export function planSeatAnchorReconciliation(input: {
  releases: SeatingCommand[];
  seatOccupancy: Record<string, string>;
  participantId: string;
}): SeatAnchorReconciliationPlan {
  let seatOccupancy = input.seatOccupancy;
  const commands: RuntimeCommand[] = [];
  for (const release of input.releases) {
    seatOccupancy = removeLocalSeatFromOccupancy(seatOccupancy, {
      seatId: release.seatId,
      participantId: input.participantId
    });
    commands.push(
      { type: "send_seat_release", seatId: release.seatId },
      { type: "status", message: "Seat anchor unavailable, returned to standing" }
    );
  }
  return {
    seatOccupancy,
    commands,
    resetSeatLock: input.releases.length > 0
  };
}

export function planMissingCurrentSeatAnchorCommands(input: {
  currentSeatId: string | null;
  anchorsReady: boolean;
  seatAnchorMap: ReadonlyMap<string, SceneBundleSeatAnchor>;
}): RuntimeCommand[] {
  if (!input.currentSeatId || input.seatAnchorMap.has(input.currentSeatId) || !input.anchorsReady) {
    return [];
  }
  return [
    { type: "send_seat_release", seatId: input.currentSeatId },
    { type: "release_local_seat" },
    { type: "status", message: "Seat anchor unavailable, returned to standing" }
  ];
}
