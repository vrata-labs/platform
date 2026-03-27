import type { PresenceState } from "./index.js";

export interface RoomStateSnapshot {
  roomId: string;
  participants: PresenceState[];
}

export interface RoomStateClient {
  socket: WebSocket;
  close(): void;
}

export function createRoomStateUrl(baseHost: string, roomId: string, participantId: string): string {
  const url = new URL(baseHost);
  url.searchParams.set("roomId", roomId);
  url.searchParams.set("participantId", participantId);
  return url.toString();
}

export function connectRoomState(
  baseHost: string,
  roomId: string,
  participantId: string,
  onRoomState: (snapshot: RoomStateSnapshot) => void,
  onError: (error: unknown) => void
): RoomStateClient {
  const socket = new WebSocket(createRoomStateUrl(baseHost, roomId, participantId));

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as { type?: string; room?: RoomStateSnapshot };
      if (payload.type === "room_state" && payload.room) {
        onRoomState(payload.room);
      }
    } catch (error) {
      onError(error);
    }
  });

  socket.addEventListener("error", onError);

  return {
    socket,
    close() {
      socket.close();
    }
  };
}

export function sendParticipantUpdate(client: RoomStateClient, participant: PresenceState): void {
  if (client.socket.readyState !== client.socket.OPEN) {
    return;
  }
  client.socket.send(JSON.stringify({ type: "participant_update", participant }));
}
