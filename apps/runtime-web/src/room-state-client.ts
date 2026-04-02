import type { PresenceState } from "./index.js";
import type { AvatarReliableState, CompactPoseFrame } from "./avatar/avatar-types.js";

export interface RoomStateSnapshot {
  roomId: string;
  participants: PresenceState[];
}

export interface RoomStateClient {
  socket: WebSocket;
  close(): void;
}

type SendableSocket = Pick<WebSocket, "OPEN" | "readyState" | "send">;

function canSend(socket: SendableSocket): boolean {
  return socket.readyState === socket.OPEN;
}

export interface RoomStateClientHandlers {
  onRoomState: (snapshot: RoomStateSnapshot) => void;
  onError: (error: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
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
  handlers: RoomStateClientHandlers
): RoomStateClient {
  const socket = new WebSocket(createRoomStateUrl(baseHost, roomId, participantId));

  socket.addEventListener("open", () => {
    handlers.onOpen?.();
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as { type?: string; room?: RoomStateSnapshot };
      if (payload.type === "room_state" && payload.room) {
        handlers.onRoomState(payload.room);
      }
    } catch (error) {
      handlers.onError(error);
    }
  });

  socket.addEventListener("error", handlers.onError);
  socket.addEventListener("close", () => {
    handlers.onClose?.();
  });

  return {
    socket,
    close() {
      socket.close();
    }
  };
}

export function sendParticipantUpdate(client: RoomStateClient, participant: PresenceState): void {
  if (!canSend(client.socket)) {
    return;
  }
  client.socket.send(JSON.stringify({ type: "participant_update", participant }));
}

export function sendAvatarReliableState(client: RoomStateClient, reliableState: AvatarReliableState): void {
  if (!canSend(client.socket)) {
    return;
  }
  client.socket.send(JSON.stringify({ type: "avatar_reliable_state", reliableState }));
}

export function sendAvatarPoseFrame(client: RoomStateClient, poseFrame: CompactPoseFrame): void {
  if (!canSend(client.socket)) {
    return;
  }
  client.socket.send(JSON.stringify({ type: "avatar_pose_preview", poseFrame }));
}
