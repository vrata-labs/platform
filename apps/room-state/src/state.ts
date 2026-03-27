export interface ParticipantState {
  participantId: string;
  x: number;
  y: number;
  z: number;
  mode: "desktop" | "mobile" | "vr";
}

export interface RoomState {
  roomId: string;
  participants: ParticipantState[];
}

export function createParticipantState(participantId: string): ParticipantState {
  return {
    participantId,
    x: 0,
    y: 0,
    z: 0,
    mode: "desktop"
  };
}

export function createRoomState(roomId: string): RoomState {
  return {
    roomId,
    participants: []
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
  return {
    ...state,
    participants: state.participants.filter((item) => item.participantId !== participantId)
  };
}

export function updateParticipantState(state: RoomState, nextState: ParticipantState): RoomState {
  return {
    ...state,
    participants: state.participants.map((item) => item.participantId === nextState.participantId ? nextState : item)
  };
}

export function serializeRoomState(state: RoomState): RoomState {
  return {
    roomId: state.roomId,
    participants: state.participants.map((item) => ({ ...item }))
  };
}
