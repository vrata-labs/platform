import type { LocalPoseMutationReason, Vector3Like } from "../local/local-pose.js";
import type { XrAxesSample } from "../movement.js";
import type { LocomotionMode } from "./local-locomotion.js";

export interface FlatPositionLike {
  x: number;
  z: number;
}

export interface FlatVectorLike {
  x: number;
  z: number;
}

export type RuntimeDebugLocomotionMode = "vr" | "vr-seated" | "desktop" | "mobile-touch";

export type RuntimeCommand =
  | { type: "request_seat_claim"; seatId: string }
  | { type: "send_seat_claim"; seatId: string }
  | { type: "send_seat_release"; seatId: string }
  | { type: "release_local_seat" }
  | {
    type: "lock_to_seat";
    seatId: string;
    position: Vector3Like;
    reason: Extract<LocalPoseMutationReason, "seat_enter" | "seat_lock">;
    yaw?: number;
  }
  | {
    type: "move_flat_to";
    position: FlatPositionLike;
    reason: Extract<LocalPoseMutationReason, "desktop_move" | "xr_move">;
  }
  | { type: "apply_snap_turn_yaw"; yaw: number }
  | { type: "set_xr_input_profile"; profile: string | null }
  | { type: "set_debug_xr_axes"; axes: XrAxesSample }
  | { type: "set_xr_ray_visible_latched"; visible: boolean }
  | { type: "set_xr_turn_cooldown"; seconds: number }
  | { type: "set_xr_turn_armed"; armed: boolean }
  | { type: "set_xr_select_pressed_last_frame"; pressed: boolean }
  | { type: "clear_xr_avatar_debug" }
  | { type: "set_debug_locomotion_mode"; mode: RuntimeDebugLocomotionMode }
  | { type: "set_last_applied_seat_lock_id"; seatId: string }
  | { type: "set_avatar_movement"; move: FlatVectorLike; turnRate: number }
  | { type: "update_local_position_debug" }
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
  lockToSeat(
    position: Vector3Like,
    reason: Extract<LocalPoseMutationReason, "seat_enter" | "seat_lock">,
    options?: { yaw?: number }
  ): void;
  moveFlatTo(position: FlatPositionLike, reason: Extract<LocalPoseMutationReason, "desktop_move" | "xr_move">): void;
  applySnapTurnYaw(yaw: number): void;
  setXrInputProfile(profile: string | null): void;
  setDebugXrAxes(axes: XrAxesSample): void;
  setXrRayVisibleLatched(visible: boolean): void;
  setXrTurnCooldown(seconds: number): void;
  setXrTurnArmed(armed: boolean): void;
  setXrSelectPressedLastFrame(pressed: boolean): void;
  clearXrAvatarDebug(): void;
  setDebugLocomotionMode(mode: RuntimeDebugLocomotionMode): void;
  setLastAppliedSeatLockId(seatId: string): void;
  setAvatarMovement(move: FlatVectorLike, turnRate: number): void;
  updateLocalPositionDebug(): void;
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
      case "lock_to_seat":
        handlers.lockToSeat(
          command.position,
          command.reason,
          command.yaw === undefined ? undefined : { yaw: command.yaw }
        );
        break;
      case "move_flat_to":
        handlers.moveFlatTo(command.position, command.reason);
        break;
      case "apply_snap_turn_yaw":
        handlers.applySnapTurnYaw(command.yaw);
        break;
      case "set_xr_input_profile":
        handlers.setXrInputProfile(command.profile);
        break;
      case "set_debug_xr_axes":
        handlers.setDebugXrAxes(command.axes);
        break;
      case "set_xr_ray_visible_latched":
        handlers.setXrRayVisibleLatched(command.visible);
        break;
      case "set_xr_turn_cooldown":
        handlers.setXrTurnCooldown(command.seconds);
        break;
      case "set_xr_turn_armed":
        handlers.setXrTurnArmed(command.armed);
        break;
      case "set_xr_select_pressed_last_frame":
        handlers.setXrSelectPressedLastFrame(command.pressed);
        break;
      case "clear_xr_avatar_debug":
        handlers.clearXrAvatarDebug();
        break;
      case "set_debug_locomotion_mode":
        handlers.setDebugLocomotionMode(command.mode);
        break;
      case "set_last_applied_seat_lock_id":
        handlers.setLastAppliedSeatLockId(command.seatId);
        break;
      case "set_avatar_movement":
        handlers.setAvatarMovement(command.move, command.turnRate);
        break;
      case "update_local_position_debug":
        handlers.updateLocalPositionDebug();
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
