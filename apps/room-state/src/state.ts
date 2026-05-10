import type { PresenceState, TransformState } from "./schema.js";

export type ParticipantState = PresenceState;

export type SeatOccupancyState = Record<string, string>;

export interface RoomState {
  roomId: string;
  participants: ParticipantState[];
  seatOccupancy: SeatOccupancyState;
}

export interface SeatClaimResult {
  room: RoomState;
  accepted: boolean;
  seatId: string;
  occupantId: string | null;
  previousSeatId: string | null;
}

export interface SeatReleaseResult {
  room: RoomState;
  releasedSeatId: string | null;
}

function mergeTransformState(current: TransformState | undefined, next: TransformState | undefined): TransformState | undefined {
  if (!current && !next) {
    return undefined;
  }
  if (!next) {
    return current ? { ...current } : undefined;
  }
  return {
    x: next?.x ?? current?.x ?? 0,
    y: next?.y ?? current?.y ?? 0,
    z: next?.z ?? current?.z ?? 0,
    yaw: next?.yaw ?? current?.yaw ?? 0,
    pitch: next?.pitch ?? current?.pitch ?? 0,
    roll: next?.roll ?? current?.roll ?? 0
  };
}

export function createParticipantState(participantId: string): ParticipantState {
  return {
    participantId,
    displayName: participantId,
    mode: "desktop",
    rootTransform: { x: 0, y: 0, z: 0, yaw: 0 },
    bodyTransform: { x: 0, y: 0.92, z: 0, yaw: 0 },
    headTransform: { x: 0, y: 1.58, z: 0, yaw: 0, pitch: 0 },
    muted: true,
    activeMedia: {
      audio: false,
      screenShare: false
    },
    seq: 0,
    clientTimeMs: 0,
    updatedAt: new Date(0).toISOString()
  };
}

export function mergeParticipantState(current: ParticipantState, nextState: Partial<ParticipantState>): ParticipantState {
  if (typeof nextState.seq === "number" && typeof current.seq === "number" && nextState.seq < current.seq) {
    return current;
  }

  return {
    participantId: current.participantId,
    displayName: nextState.displayName ?? current.displayName,
    mode: nextState.mode ?? current.mode,
    rootTransform: mergeTransformState(current.rootTransform, nextState.rootTransform) ?? current.rootTransform,
    bodyTransform: mergeTransformState(current.bodyTransform, nextState.bodyTransform),
    headTransform: mergeTransformState(current.headTransform, nextState.headTransform),
    muted: nextState.muted ?? current.muted,
    activeMedia: {
      audio: nextState.activeMedia?.audio ?? current.activeMedia.audio,
      screenShare: nextState.activeMedia?.screenShare ?? current.activeMedia.screenShare
    },
    seq: nextState.seq ?? current.seq,
    clientTimeMs: nextState.clientTimeMs ?? current.clientTimeMs,
    serverTimeMs: nextState.serverTimeMs ?? current.serverTimeMs,
    updatedAt: nextState.updatedAt ?? current.updatedAt
  };
}

export function createRoomState(roomId: string): RoomState {
  return {
    roomId,
    participants: [],
    seatOccupancy: {}
  };
}

export function joinRoom(state: RoomState, participantId: string): RoomState {
  if (state.participants.some((item) => item.participantId === participantId)) {
    return state;
  }
  return {
    ...state,
    participants: [...state.participants, createParticipantState(participantId)]
  };
}

export function leaveRoom(state: RoomState, participantId: string): RoomState {
  const nextSeatOccupancy = { ...state.seatOccupancy };
  for (const [seatId, occupantId] of Object.entries(nextSeatOccupancy)) {
    if (occupantId === participantId) {
      delete nextSeatOccupancy[seatId];
    }
  }
  return {
    ...state,
    participants: state.participants.filter((item) => item.participantId !== participantId),
    seatOccupancy: nextSeatOccupancy
  };
}

export function findParticipantSeatId(state: RoomState, participantId: string): string | null {
  for (const [seatId, occupantId] of Object.entries(state.seatOccupancy)) {
    if (occupantId === participantId) {
      return seatId;
    }
  }
  return null;
}

export function claimSeat(state: RoomState, participantId: string, seatId: string): SeatClaimResult {
  const occupantId = state.seatOccupancy[seatId] ?? null;
  const previousSeatId = findParticipantSeatId(state, participantId);
  if (occupantId && occupantId !== participantId) {
    return {
      room: state,
      accepted: false,
      seatId,
      occupantId,
      previousSeatId
    };
  }

  const nextSeatOccupancy = { ...state.seatOccupancy };
  if (previousSeatId && previousSeatId !== seatId) {
    delete nextSeatOccupancy[previousSeatId];
  }
  nextSeatOccupancy[seatId] = participantId;
  return {
    room: {
      ...state,
      seatOccupancy: nextSeatOccupancy
    },
    accepted: true,
    seatId,
    occupantId: participantId,
    previousSeatId
  };
}

export function releaseSeat(state: RoomState, participantId: string, seatId?: string): SeatReleaseResult {
  const targetSeatId = seatId ?? findParticipantSeatId(state, participantId);
  if (!targetSeatId || state.seatOccupancy[targetSeatId] !== participantId) {
    return {
      room: state,
      releasedSeatId: null
    };
  }
  const nextSeatOccupancy = { ...state.seatOccupancy };
  delete nextSeatOccupancy[targetSeatId];
  return {
    room: {
      ...state,
      seatOccupancy: nextSeatOccupancy
    },
    releasedSeatId: targetSeatId
  };
}

export function updateParticipantState(state: RoomState, nextState: Partial<ParticipantState> & { participantId: string }): RoomState {
  const current = state.participants.find((item) => item.participantId === nextState.participantId);
  const merged = mergeParticipantState(current ?? createParticipantState(nextState.participantId), nextState);

  if (!current) {
    return {
      ...state,
      participants: [...state.participants, merged]
    };
  }

  return {
    ...state,
    participants: state.participants.map((item) => item.participantId === nextState.participantId ? merged : item)
  };
}

export function serializeRoomState(state: RoomState): RoomState {
  return {
    roomId: state.roomId,
    participants: state.participants.map((item) => ({ ...item })),
    seatOccupancy: { ...state.seatOccupancy }
  };
}
