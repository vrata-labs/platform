import type { Vector3Like } from "../local/local-pose.js";
import type { LocomotionMode } from "./local-locomotion.js";

export type RuntimeCommand =
  | { type: "request_seat_claim"; seatId: string }
  | { type: "send_seat_claim"; seatId: string }
  | { type: "send_seat_release"; seatId: string }
  | { type: "release_local_seat" }
  | { type: "teleport_to_floor"; point: Vector3Like }
  | { type: "status"; message: string }
  | { type: "telemetry"; kind: string };

export type RuntimeCommandInteractionTarget =
  | { kind: "none" }
  | { kind: "floor"; point: Vector3Like }
  | { kind: "seat"; point: Vector3Like; seatId: string; label?: string | null };

export interface PlanInteractionCommandInput {
  target: RuntimeCommandInteractionTarget;
  mode: LocomotionMode;
  pendingSeatId: string | null;
  seatingAvailable: boolean;
  nowMs: number;
  lastInteractionConfirmAtMs: number;
  debounceMs?: number;
}

export interface PlanInteractionCommandResult {
  commands: RuntimeCommand[];
  lastInteractionConfirmAtMs: number;
}

export interface RuntimeCommandHandlers {
  requestSeatClaim(seatId: string): void;
  sendSeatClaim(seatId: string): void;
  sendSeatRelease(seatId: string): void;
  releaseLocalSeat(): void;
  teleportToFloor(point: Vector3Like): void;
  setStatus(message: string): void;
  markTelemetry(kind: string): void;
}

export function planInteractionCommands(input: PlanInteractionCommandInput): PlanInteractionCommandResult {
  if (input.target.kind === "none") {
    return { commands: [], lastInteractionConfirmAtMs: input.lastInteractionConfirmAtMs };
  }

  const debounceMs = input.debounceMs ?? 250;
  if (input.nowMs - input.lastInteractionConfirmAtMs < debounceMs) {
    return { commands: [], lastInteractionConfirmAtMs: input.lastInteractionConfirmAtMs };
  }

  const lastInteractionConfirmAtMs = input.nowMs;
  if (input.target.kind === "seat") {
    if (!input.seatingAvailable) {
      return {
        commands: [{ type: "status", message: "Seating unavailable" }],
        lastInteractionConfirmAtMs
      };
    }
    if (input.pendingSeatId === input.target.seatId) {
      return { commands: [], lastInteractionConfirmAtMs };
    }
    return {
      commands: [
        { type: "request_seat_claim", seatId: input.target.seatId },
        { type: "telemetry", kind: "seat_claim" },
        { type: "send_seat_claim", seatId: input.target.seatId },
        { type: "status", message: `Claiming seat ${input.target.label ?? input.target.seatId}` }
      ],
      lastInteractionConfirmAtMs
    };
  }

  const commands: RuntimeCommand[] = [];
  if (input.mode.kind === "seated") {
    commands.push(
      { type: "telemetry", kind: "seat_release" },
      { type: "send_seat_release", seatId: input.mode.seatId },
      { type: "release_local_seat" }
    );
  }
  commands.push(
    { type: "teleport_to_floor", point: input.target.point },
    { type: "status", message: "Teleported" }
  );

  return { commands, lastInteractionConfirmAtMs };
}

export function executeRuntimeCommands(commands: RuntimeCommand[], handlers: RuntimeCommandHandlers): void {
  for (const command of commands) {
    switch (command.type) {
      case "request_seat_claim":
        handlers.requestSeatClaim(command.seatId);
        break;
      case "send_seat_claim":
        handlers.sendSeatClaim(command.seatId);
        break;
      case "send_seat_release":
        handlers.sendSeatRelease(command.seatId);
        break;
      case "release_local_seat":
        handlers.releaseLocalSeat();
        break;
      case "teleport_to_floor":
        handlers.teleportToFloor(command.point);
        break;
      case "status":
        handlers.setStatus(command.message);
        break;
      case "telemetry":
        handlers.markTelemetry(command.kind);
        break;
    }
  }
}
