import type { RuntimeCommand } from "../locomotion/runtime-commands.js";

export const DEFAULT_SEAT_RECLAIM_RETRY_DELAY_MS = 250;

export interface SeatReclaimPlan {
  seatId: string | null;
  commands: RuntimeCommand[];
  retryDelayMs: number | null;
}

export function planSeatReclaimOnReconnect(input: {
  currentSeatId: string | null;
  seatingEnabled: boolean;
  roomStateClientAvailable: boolean;
  pendingReleaseSeatIds?: readonly string[];
  retryDelayMs?: number;
}): SeatReclaimPlan {
  if (!input.roomStateClientAvailable) {
    return { seatId: null, commands: [], retryDelayMs: null };
  }

  const releaseCommands: RuntimeCommand[] = (input.pendingReleaseSeatIds ?? []).map(seatId => ({ type: "send_seat_release", seatId }));
  if (!input.currentSeatId || !input.seatingEnabled) {
    return { seatId: null, commands: releaseCommands, retryDelayMs: null };
  }

  return {
    seatId: input.currentSeatId,
    commands: [
      ...releaseCommands,
      { type: "request_seat_claim", seatId: input.currentSeatId },
      { type: "send_seat_claim", seatId: input.currentSeatId }
    ],
    retryDelayMs: input.retryDelayMs ?? DEFAULT_SEAT_RECLAIM_RETRY_DELAY_MS
  };
}

export function shouldRetrySeatReclaim(input: {
  seatId: string;
  roomStateConnected: boolean;
  sameRoomStateClient: boolean;
  currentSeatId: string | null;
  pendingSeatId: string | null;
}): boolean {
  return input.roomStateConnected
    && input.sameRoomStateClient
    && input.currentSeatId !== input.seatId
    && input.pendingSeatId === input.seatId;
}
