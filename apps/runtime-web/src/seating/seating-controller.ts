export type SeatingState =
  | { kind: "standing"; pendingSeatId: null }
  | { kind: "claiming"; pendingSeatId: string }
  | { kind: "seated"; seatId: string; pendingSeatId: null };

export type SeatingCommand = { type: "send_seat_release"; seatId: string; commandId?: string };
export interface CorrelatedSeatRelease { seatId: string; commandId: string }

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
  // Room snapshots already in flight may still contain our old occupancy after
  // local teleport. Suppress it and retain the release for reconnect delivery
  // until a server snapshot acknowledges that this participant no longer owns it.
  private releasedSeatIds = new Set<string>();
  // A cancelled pending claim may still be accepted by the server after an older
  // snapshot without us arrived. Its seat stays suppressed until the server
  // acknowledges this exact release; snapshots alone never lift it.
  private cancelledSeats = new Map<string, string>();
  // Correlated claim IDs: the pending one, and cancelled ones keyed by their release.
  private pendingCommandId: string | null = null;
  private cancelledClaims = new Map<string, string>();

  constructor(private participantId: string) {}

  adoptParticipantId(participantId: string): void {
    if (!participantId || this.state.kind !== "standing" || this.releasedSeatIds.size !== 0 || this.cancelledSeats.size !== 0) {
      throw new Error("seating_identity_transition_requires_standing");
    }
    this.participantId = participantId;
  }

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

  getPendingReleaseSeatIds(): string[] {
    return [...this.releasedSeatIds];
  }

  /** Correlated releases still awaiting their acknowledgement; resent first after a reconnect. */
  getPendingCorrelatedReleases(): CorrelatedSeatRelease[] {
    return [...this.cancelledSeats].map(([commandId, seatId]) => ({ seatId, commandId }));
  }

  isSuppressed(seatId: string): boolean {
    return this.releasedSeatIds.has(seatId) || [...this.cancelledSeats.values()].includes(seatId);
  }

  /** Cancel only a still-pending own claim: never a confirmed seat. */
  cancelPending(releaseCommandId: string): { snapshot: SeatingControllerSnapshot; commands: SeatingCommand[] } {
    if (this.state.kind !== "claiming" || this.cancelledSeats.has(releaseCommandId)) return { snapshot: this.getSnapshot(), commands: [] };
    const seatId = this.state.pendingSeatId;
    this.cancelledSeats.set(releaseCommandId, seatId);
    if (this.pendingCommandId) this.cancelledClaims.set(releaseCommandId, this.pendingCommandId);
    this.state = { kind: "standing", pendingSeatId: null };
    this.pendingCommandId = null;
    return { snapshot: this.getSnapshot(), commands: [{ type: "send_seat_release", seatId, commandId: releaseCommandId }] };
  }

  acknowledgeRelease(commandId: string): SeatingControllerSnapshot {
    this.cancelledSeats.delete(commandId);
    this.cancelledClaims.delete(commandId);
    return this.getSnapshot();
  }

  reset(): SeatingControllerSnapshot {
    this.cancelledSeats.clear();
    this.cancelledClaims.clear();
    this.pendingCommandId = null;
    this.releasedSeatIds.clear();
    this.state = { kind: "standing", pendingSeatId: null };
    return this.getSnapshot();
  }

  requestSeatClaim(seatId: string, commandId?: string): SeatingControllerSnapshot {
    this.releasedSeatIds.delete(seatId);
    if (this.state.kind === "seated" && this.state.seatId === seatId) {
      return this.getSnapshot();
    }
    this.state = { kind: "claiming", pendingSeatId: seatId };
    this.pendingCommandId = commandId ?? null;
    return this.getSnapshot();
  }

  clearPending(): SeatingControllerSnapshot {
    if (this.state.kind === "claiming") {
      this.state = { kind: "standing", pendingSeatId: null };
    }
    this.pendingCommandId = null;
    return this.getSnapshot();
  }

  getPendingCommandId(): string | null {
    return this.state.kind === "claiming" ? this.pendingCommandId : null;
  }

  isCancelledClaim(commandId: string | undefined): boolean {
    return commandId !== undefined && [...this.cancelledClaims.values()].includes(commandId);
  }

  /** A busy/unavailable answer clears only the claim it answers: never a newer pending claim. */
  settleRejectedClaim(result: { seatId: string; commandId?: string }): SeatingControllerSnapshot {
    if (this.isCancelledClaim(result.commandId)) return this.getSnapshot();
    if (this.state.kind === "claiming" && this.state.pendingSeatId === result.seatId && (result.commandId ?? null) === this.pendingCommandId) {
      return this.clearPending();
    }
    return this.getSnapshot();
  }

  forceSeated(seatId: string): SeatingControllerSnapshot {
    this.releasedSeatIds.delete(seatId);
    this.pendingCommandId = null;
    this.state = { kind: "seated", seatId, pendingSeatId: null };
    return this.getSnapshot();
  }

  applyOccupancy(input: { seatOccupancy: Record<string, string>; forcedSeatId?: string | null }): SeatingControllerSnapshot {
    for (const seatId of this.releasedSeatIds) {
      if (input.seatOccupancy[seatId] !== this.participantId) this.releasedSeatIds.delete(seatId);
    }
    const occupiedSeatId = input.forcedSeatId ?? resolveLocalSeatId(input.seatOccupancy, this.participantId);
    if (occupiedSeatId && !this.isSuppressed(occupiedSeatId)) {
      this.state = { kind: "seated", seatId: occupiedSeatId, pendingSeatId: null };
      this.pendingCommandId = null;
      return this.getSnapshot();
    }
    if (this.state.kind === "seated") {
      this.state = { kind: "standing", pendingSeatId: null };
    }
    return this.getSnapshot();
  }

  releaseLocal(): SeatingControllerSnapshot {
    this.pendingCommandId = null;
    const seatId = this.getCurrentSeatId();
    if (seatId) this.releasedSeatIds.add(seatId);
    this.state = { kind: "standing", pendingSeatId: null };
    return this.getSnapshot();
  }

  reconcileAnchors(availableSeatIds: ReadonlySet<string>): { snapshot: SeatingControllerSnapshot; commands: SeatingCommand[] } {
    const currentSeatId = this.getCurrentSeatId();
    if (!currentSeatId || availableSeatIds.has(currentSeatId)) {
      return { snapshot: this.getSnapshot(), commands: [] };
    }

    this.releaseLocal();
    return {
      snapshot: this.getSnapshot(),
      commands: [{ type: "send_seat_release", seatId: currentSeatId }]
    };
  }
}

export function createSeatingController(input: { participantId: string }): SeatingController {
  return new SeatingController(input.participantId);
}
