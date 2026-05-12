import type { RoomPermission, RoomRole } from "@noah/shared-types";

import type { PresenceState } from "./index.js";
import type { AvatarReliableState, CompactPoseFrame } from "./avatar/avatar-types.js";
import { parseCompactPoseFrame } from "./avatar/avatar-pose-frame.js";
import { parseAvatarReliableState } from "./avatar/avatar-reliable-state.js";

export interface RoomStateSnapshot {
  roomId: string;
  participants: PresenceState[];
  seatOccupancy: Record<string, string>;
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
  onSeatClaimResult?: (result: { seatId: string; accepted: boolean; occupantId: string | null; previousSeatId: string | null }) => void;
  onAccessDenied?: (result: { accepted: boolean; permission: RoomPermission; role: RoomRole }) => void;
  onSurfaceCommandResult?: (result: { accepted: boolean; permission: RoomPermission; role: RoomRole }) => void;
  onError: (error: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export function createRoomStateUrl(baseHost: string, roomId: string, participantId: string, accessToken?: string): string {
  const url = new URL(baseHost);
  url.searchParams.set("roomId", roomId);
  url.searchParams.set("participantId", participantId);
  if (accessToken) {
    url.searchParams.set("accessToken", accessToken);
  }
  return url.toString();
}

export function connectRoomState(
  baseHost: string,
  roomId: string,
  participantId: string,
  handlers: RoomStateClientHandlers,
  accessToken?: string
): RoomStateClient {
  const socket = new WebSocket(createRoomStateUrl(baseHost, roomId, participantId, accessToken));

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
        seatClaimResult?: {
          seatId?: unknown;
          accepted?: unknown;
          occupantId?: unknown;
          previousSeatId?: unknown;
        };
        result?: {
          accepted?: unknown;
          permission?: unknown;
          role?: unknown;
        };
      };
      if (payload.type === "room_state" && payload.room) {
        handlers.onRoomState({
          roomId: payload.room.roomId,
          participants: payload.room.participants,
          seatOccupancy: payload.room.seatOccupancy ?? {}
        });
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
        return;
      }
      if (payload.type === "seat_claim_result" && payload.seatClaimResult) {
        const seatId = typeof payload.seatClaimResult.seatId === "string" ? payload.seatClaimResult.seatId : null;
        const accepted = payload.seatClaimResult.accepted;
        if (!seatId || typeof accepted !== "boolean") {
          throw new Error("invalid_seat_claim_result");
        }
        handlers.onSeatClaimResult?.({
          seatId,
          accepted,
          occupantId: typeof payload.seatClaimResult.occupantId === "string" ? payload.seatClaimResult.occupantId : null,
          previousSeatId: typeof payload.seatClaimResult.previousSeatId === "string" ? payload.seatClaimResult.previousSeatId : null
        });
        return;
      }
      if ((payload.type === "access_denied" || payload.type === "surface_command_result") && payload.result) {
        if (typeof payload.result.accepted !== "boolean" || typeof payload.result.permission !== "string" || typeof payload.result.role !== "string") {
          throw new Error("invalid_access_result");
        }
        const result = {
          accepted: payload.result.accepted,
          permission: payload.result.permission as RoomPermission,
          role: payload.result.role as RoomRole
        };
        if (payload.type === "access_denied") {
          handlers.onAccessDenied?.(result);
        } else {
          handlers.onSurfaceCommandResult?.(result);
        }
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

export function sendSeatClaim(client: RoomStateClient, seatId: string): void {
  if (!canSend(client.socket)) {
    return;
  }
  client.socket.send(JSON.stringify({ type: "seat_claim", seatId }));
}

export function sendSeatRelease(client: RoomStateClient, seatId?: string): void {
  if (!canSend(client.socket)) {
    return;
  }
  client.socket.send(JSON.stringify({ type: "seat_release", seatId }));
}

export function sendSurfaceCreateObjectCommand(client: RoomStateClient): void {
  if (!canSend(client.socket)) {
    return;
  }
  client.socket.send(JSON.stringify({ type: "surface_create_object" }));
}
