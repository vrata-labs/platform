export interface ParticipantState {
  participantId: string;
  x: number;
  y: number;
  z: number;
  mode: "desktop" | "mobile" | "vr";
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

export interface RoomState {
  roomId: string;
  participants: ParticipantState[];
}

export function createRoomState(roomId: string): RoomState {
  return {
    roomId,
    participants: []
  };
}

export function joinRoom(state: RoomState, participantId: string): RoomState {
  return {
    ...state,
    participants: [...state.participants, createParticipantState(participantId)]
  };
}
