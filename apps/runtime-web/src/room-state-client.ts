import type { PresenceState } from "./index.js";
import type { AvatarReliableState, CompactPoseFrame } from "./avatar/avatar-types.js";
import { parseCompactPoseFrame } from "./avatar/avatar-pose-frame.js";
import { parseAvatarReliableState } from "./avatar/avatar-reliable-state.js";

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
  onAvatarReliableState?: (state: AvatarReliableState) => void;
  onAvatarPoseFrame?: (participantId: string, frame: CompactPoseFrame) => void;
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
      const payload = JSON.parse(String(event.data)) as {
        type?: string;
        room?: RoomStateSnapshot;
        reliableState?: unknown;
        poseFrame?: unknown;
        participantId?: unknown;
      };
      if (payload.type === "room_state" && payload.room) {
        handlers.onRoomState(payload.room);
        return;
      }
      if (payload.type === "avatar_reliable_state" && payload.reliableState) {
        handlers.onAvatarReliableState?.(parseAvatarReliableState(payload.reliableState));
        return;
      }
      if (payload.type === "avatar_pose_preview" && payload.poseFrame) {
        const participantId = typeof payload.participantId === "string" ? payload.participantId : null;
        if (!participantId) {
          throw new Error("invalid_avatar_pose_preview_participant");
        }
        handlers.onAvatarPoseFrame?.(participantId, parseCompactPoseFrame(payload.poseFrame));
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

export function sendAvatarPoseFrame(client: RoomStateClient, participantId: string, poseFrame: CompactPoseFrame): void {
  if (!canSend(client.socket)) {
    return;
  }
  client.socket.send(JSON.stringify({ type: "avatar_pose_preview", participantId, poseFrame }));
}
