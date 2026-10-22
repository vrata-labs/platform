import type { RuntimeCommand } from "../locomotion/runtime-commands.js";

export const STAND_UP_STATUS = "You are standing. To sit again, point at a free seat and select it.";

/** The platform's own stand action: release the confirmed seat and return to the scene's
 * entry point through the ordinary teleport transition. Without a known entry point the
 * participant stands where the seat was released; no exit geometry is invented. */
export function planStandUp(input: { seatId: string | null; exit: { x: number; y: number; z: number } | null }): RuntimeCommand[] {
  if (!input.seatId) return [];
  return [
    { type: "telemetry", kind: "seat_release" },
    { type: "send_seat_release", seatId: input.seatId },
    { type: "release_local_seat" },
    ...(input.exit ? [{ type: "teleport_to_floor" as const, point: { ...input.exit } }] : []),
    { type: "status", message: STAND_UP_STATUS }
  ];
}
