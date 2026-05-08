import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import type { LocalPose, LocalPoseMutationReason, Vector3Like } from "../local/local-pose.js";
import { projectMovementToWorld, type FlatVector } from "../movement.js";
import { resolveLocomotionMode, stepLocalLocomotion } from "./local-locomotion.js";
import type { FrameLocomotionCommand } from "./frame-locomotion.js";
import type { RuntimeCommand, RuntimeDebugLocomotionMode } from "./runtime-commands.js";

export type FrameLocomotionMovementPlan =
  | {
    kind: "seat_lock";
    seatId: string;
    position: Vector3Like;
    reason: Extract<LocalPoseMutationReason, "seat_enter" | "seat_lock">;
    yaw?: number;
    commands: RuntimeCommand[];
    avatarMove: FlatVector;
    avatarTurnRate: number;
  }
  | {
    kind: "standing";
    pose: LocalPose;
    movementReason: Extract<LocalPoseMutationReason, "desktop_move" | "xr_move"> | null;
    debugLocomotionMode: Extract<RuntimeDebugLocomotionMode, "desktop" | "mobile-touch"> | null;
    commands: RuntimeCommand[];
    avatarMove: FlatVector;
    avatarTurnRate: number;
  };

export interface FrameLocomotionMovementInput {
  pose: LocalPose;
  frameContext: Pick<RuntimeFrameContext, "source" | "intents">;
  deltaSeconds: number;
  floorY: number;
  currentSeatId: string | null;
  seatRootPosition?: Vector3Like | null;
  seatYaw?: number;
  lastAppliedSeatLockId: string | null;
  cameraForward: FlatVector;
  desktopFastMove: boolean;
  botMove?: FlatVector | null;
}

export interface FrameLocomotionMovementPlanHandlers {
  executeCommands(commands: FrameLocomotionCommand[]): void;
}

const ZERO_MOVE: FlatVector = { x: 0, z: 0 };

function hasMove(move: FlatVector): boolean {
  return move.x !== 0 || move.z !== 0;
}

function planStandingDebugLocomotionMode(
  input: FrameLocomotionMovementInput
): Extract<RuntimeDebugLocomotionMode, "desktop" | "mobile-touch"> | null {
  if (input.frameContext.source === "xr") {
    return null;
  }

  if (input.frameContext.source === "touch" && !input.botMove) {
    return "mobile-touch";
  }

  return "desktop";
}

export function planFrameLocomotionMovement(input: FrameLocomotionMovementInput): FrameLocomotionMovementPlan {
  const xrLocomotionActive = input.frameContext.source === "xr";
  const mode = resolveLocomotionMode({ seatId: input.currentSeatId, floorY: input.floorY });
  if (mode.kind === "seated" && input.seatRootPosition) {
    const reason = input.lastAppliedSeatLockId === mode.seatId ? "seat_lock" : "seat_enter";
    const yaw = input.lastAppliedSeatLockId === mode.seatId ? undefined : input.seatYaw;
    return {
      kind: "seat_lock",
      seatId: mode.seatId,
      position: input.seatRootPosition,
      reason,
      yaw,
      commands: [{
        type: "lock_to_seat",
        seatId: mode.seatId,
        position: input.seatRootPosition,
        reason,
        ...(yaw === undefined ? {} : { yaw })
      }],
      avatarMove: ZERO_MOVE,
      avatarTurnRate: 0
    };
  }

  const commands: RuntimeCommand[] = [];
  if (mode.kind === "seated") {
    commands.push({ type: "release_local_seat" });
  }

  const speed = xrLocomotionActive ? 2.4 : input.desktopFastMove ? 5 : 3.2;
  const avatarMove = !xrLocomotionActive && input.botMove ? input.botMove : {
    x: input.frameContext.intents.move.x,
    z: input.frameContext.intents.move.z
  };
  const debugLocomotionMode = planStandingDebugLocomotionMode(input);
  if (!hasMove(avatarMove)) {
    return {
      kind: "standing",
      pose: input.pose,
      movementReason: null,
      debugLocomotionMode,
      commands,
      avatarMove,
      avatarTurnRate: 0
    };
  }

  const locomotion = stepLocalLocomotion({
    pose: input.pose,
    mode: resolveLocomotionMode({ seatId: null, floorY: input.floorY }),
    intents: input.frameContext.intents,
    deltaSeconds: input.deltaSeconds,
    speed,
    worldMove: projectMovementToWorld(avatarMove, input.cameraForward)
  });

  return {
    kind: "standing",
    pose: locomotion.pose,
    movementReason: xrLocomotionActive ? "xr_move" : "desktop_move",
    debugLocomotionMode,
    commands: [
      ...commands,
      {
        type: "move_flat_to",
        position: { x: locomotion.pose.position.x, z: locomotion.pose.position.z },
        reason: xrLocomotionActive ? "xr_move" : "desktop_move"
      }
    ],
    avatarMove,
    avatarTurnRate: 0
  };
}

export function executeFrameLocomotionMovementPlan(
  plan: FrameLocomotionMovementPlan,
  handlers: FrameLocomotionMovementPlanHandlers
): void {
  const commands = planFrameLocomotionMovementCommands(plan);
  if (commands.length > 0) {
    handlers.executeCommands(commands);
  }
}

export function planFrameLocomotionMovementCommands(
  plan: FrameLocomotionMovementPlan
): FrameLocomotionCommand[] {
  if (plan.kind === "seat_lock") {
    return [
      ...plan.commands,
      { type: "set_last_applied_seat_lock_id", seatId: plan.seatId },
      { type: "set_avatar_movement", move: plan.avatarMove, turnRate: plan.avatarTurnRate },
      { type: "update_local_position_debug" }
    ];
  }

  const movementCommands = plan.commands.filter((command) => command.type === "move_flat_to");
  const preMovementCommands = plan.commands.filter((command) => command.type !== "move_flat_to");
  return [
    ...preMovementCommands,
    ...(plan.debugLocomotionMode ? [{ type: "set_debug_locomotion_mode", mode: plan.debugLocomotionMode } as const] : []),
    ...movementCommands,
    { type: "set_avatar_movement", move: plan.avatarMove, turnRate: plan.avatarTurnRate },
    { type: "update_local_position_debug" }
  ];
}
