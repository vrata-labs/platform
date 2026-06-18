export type SeatingState =
  | { kind: "standing"; pendingSeatId: null }
  | { kind: "claiming"; pendingSeatId: string }
  | { kind: "seated"; seatId: string; pendingSeatId: null };

export type SeatingCommand = { type: "send_seat_release"; seatId: string };

export interface SeatingControllerSnapshot {
  state: SeatingState;
  currentSeatId: string | null;
  pendingSeatId: string | null;
}

function cloneState(state: SeatingState): SeatingState {
  return { ...state } as SeatingState;
}

export function resolveLocalSeatId(seatOccupancy: Record<string, string>, participantId: string): string | null {
  for (const [seatId, occupantId] of Object.entries(seatOccupancy)) {
    if (occupantId === participantId) {
      return seatId;
    }
  }
  return null;
}

export class SeatingController {
  private state: SeatingState = { kind: "standing", pendingSeatId: null };

  constructor(private readonly participantId: string) {}

  getSnapshot(): SeatingControllerSnapshot {
    return {
      state: cloneState(this.state),
      currentSeatId: this.getCurrentSeatId(),
      pendingSeatId: this.getPendingSeatId()
    };
  }

  getCurrentSeatId(): string | null {
    return this.state.kind === "seated" ? this.state.seatId : null;
  }

  getPendingSeatId(): string | null {
    return this.state.kind === "claiming" ? this.state.pendingSeatId : null;
  }

  reset(): SeatingControllerSnapshot {
    this.state = { kind: "standing", pendingSeatId: null };
    return this.getSnapshot();
  }

  requestSeatClaim(seatId: string): SeatingControllerSnapshot {
    if (this.state.kind === "seated" && this.state.seatId === seatId) {
      return this.getSnapshot();
    }
    this.state = { kind: "claiming", pendingSeatId: seatId };
    return this.getSnapshot();
  }

  clearPending(): SeatingControllerSnapshot {
    if (this.state.kind === "claiming") {
      this.state = { kind: "standing", pendingSeatId: null };
    }
    return this.getSnapshot();
  }

  forceSeated(seatId: string): SeatingControllerSnapshot {
    this.state = { kind: "seated", seatId, pendingSeatId: null };
    return this.getSnapshot();
  }

  applyOccupancy(input: { seatOccupancy: Record<string, string>; forcedSeatId?: string | null }): SeatingControllerSnapshot {
    const occupiedSeatId = input.forcedSeatId ?? resolveLocalSeatId(input.seatOccupancy, this.participantId);
    if (occupiedSeatId) {
      this.state = { kind: "seated", seatId: occupiedSeatId, pendingSeatId: null };
      return this.getSnapshot();
    }
    if (this.state.kind === "seated") {
      this.state = { kind: "standing", pendingSeatId: null };
    }
    return this.getSnapshot();
  }

  releaseLocal(): SeatingControllerSnapshot {
    this.state = { kind: "standing", pendingSeatId: null };
    return this.getSnapshot();
  }

  reconcileAnchors(availableSeatIds: ReadonlySet<string>): { snapshot: SeatingControllerSnapshot; commands: SeatingCommand[] } {
    const currentSeatId = this.getCurrentSeatId();
    if (!currentSeatId || availableSeatIds.has(currentSeatId)) {
      return { snapshot: this.getSnapshot(), commands: [] };
    }

    this.state = { kind: "standing", pendingSeatId: null };
    return {
      snapshot: this.getSnapshot(),
      commands: [{ type: "send_seat_release", seatId: currentSeatId }]
    };
  }
}

export function createSeatingController(input: { participantId: string }): SeatingController {
  return new SeatingController(input.participantId);
}
