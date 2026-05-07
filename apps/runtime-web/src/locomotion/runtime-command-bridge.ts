import type { LocalPoseMutationReason, Vector3Like } from "../local/local-pose.js";
import { sendSeatClaim, sendSeatRelease, type RoomStateClient } from "../room-state-client.js";
import type { SeatingController } from "../seating/seating-controller.js";
import { executeRuntimeCommands, type FlatPositionLike, type RuntimeCommand } from "./runtime-commands.js";

export interface RuntimeCommandBridgeInput {
  seatingController: Pick<SeatingController, "requestSeatClaim">;
  getRoomStateClient(): RoomStateClient | null;
  isRoomStateConnected(): boolean;
  syncSeatDebugState(): void;
  releaseLocalSeat(): void;
  lockToSeat(
    position: Vector3Like,
    reason: Extract<LocalPoseMutationReason, "seat_enter" | "seat_lock">,
    options?: { yaw?: number }
  ): void;
  moveFlatTo(position: FlatPositionLike, reason: Extract<LocalPoseMutationReason, "desktop_move" | "xr_move">): void;
  applySnapTurnYaw(yaw: number): void;
  teleportToFloor(point: Vector3Like): void;
  setStatus(message: string): void;
  markTelemetry(kind: string): void;
  sendSeatClaim?: (client: RoomStateClient, seatId: string) => void;
  sendSeatRelease?: (client: RoomStateClient, seatId: string) => void;
}

export type RuntimeCommandExecutor = (commands: RuntimeCommand[]) => void;

export function createRuntimeCommandExecutor(input: RuntimeCommandBridgeInput): RuntimeCommandExecutor {
  const sendClaim = input.sendSeatClaim ?? sendSeatClaim;
  const sendRelease = input.sendSeatRelease ?? sendSeatRelease;

  function getConnectedRoomStateClient(): RoomStateClient | null {
    const client = input.getRoomStateClient();
    return client && input.isRoomStateConnected() ? client : null;
  }

  return (commands) => {
    executeRuntimeCommands(commands, {
      requestSeatClaim(seatId) {
        input.seatingController.requestSeatClaim(seatId);
        input.syncSeatDebugState();
      },
      sendSeatClaim(seatId) {
        const client = getConnectedRoomStateClient();
        if (client) {
          sendClaim(client, seatId);
        }
      },
      sendSeatRelease(seatId) {
        const client = getConnectedRoomStateClient();
        if (client) {
          sendRelease(client, seatId);
        }
      },
      releaseLocalSeat() {
        input.releaseLocalSeat();
      },
      lockToSeat(position, reason, options) {
        input.lockToSeat(position, reason, options);
      },
      moveFlatTo(position, reason) {
        input.moveFlatTo(position, reason);
      },
      applySnapTurnYaw(yaw) {
        input.applySnapTurnYaw(yaw);
      },
      teleportToFloor(point) {
        input.teleportToFloor(point);
      },
      setStatus(message) {
        input.setStatus(message);
      },
      markTelemetry(kind) {
        input.markTelemetry(kind);
      }
    });
  };
}
