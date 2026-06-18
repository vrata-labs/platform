export type SeatOccupancy = Record<string, string>;

export interface SeatClaimResultLike {
  seatId: string;
  accepted: boolean;
  previousSeatId: string | null;
}

export function cloneSeatOccupancy(occupancy: SeatOccupancy): SeatOccupancy {
  return { ...occupancy };
}

export function removeParticipantFromSeatOccupancy(occupancy: SeatOccupancy, participantId: string): SeatOccupancy {
  const next = cloneSeatOccupancy(occupancy);
  for (const [seatId, occupantId] of Object.entries(next)) {
    if (occupantId === participantId) {
      delete next[seatId];
    }
  }
  return next;
}

export function removeLocalSeatFromOccupancy(occupancy: SeatOccupancy, input: { seatId: string; participantId: string }): SeatOccupancy {
  const next = cloneSeatOccupancy(occupancy);
  if (next[input.seatId] === input.participantId) {
    delete next[input.seatId];
  }
  return next;
}

export function applyForcedSeatOccupancy(occupancy: SeatOccupancy, input: { forcedSeatId: string | null; participantId: string }): SeatOccupancy {
  const next = cloneSeatOccupancy(occupancy);
  if (input.forcedSeatId) {
    next[input.forcedSeatId] = input.participantId;
  }
  return next;
}

export function applyAcceptedSeatClaimToOccupancy(occupancy: SeatOccupancy, input: { result: SeatClaimResultLike; participantId: string }): SeatOccupancy {
  if (!input.result.accepted) {
    return cloneSeatOccupancy(occupancy);
  }

  const next = cloneSeatOccupancy(occupancy);
  if (input.result.previousSeatId) {
    delete next[input.result.previousSeatId];
  }
  next[input.result.seatId] = input.participantId;
  return next;
}
