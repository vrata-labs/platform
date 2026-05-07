import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import type { LocalPose, LocalPoseMutationReason, Vector3Like } from "../local/local-pose.js";
import { applySnapTurn, projectMovementToWorld, type FlatVector, type XrAxesSample } from "../movement.js";
import { resolveLocomotionMode, stepLocalLocomotion } from "./local-locomotion.js";
import type { RuntimeCommand, RuntimeDebugLocomotionMode } from "./runtime-commands.js";

export type FrameLocomotionCommand = RuntimeCommand | { type: "confirm_interaction_target" };

export interface FrameLocomotionCommandHandlers {
  executeRuntimeCommands(commands: RuntimeCommand[]): void;
  confirmInteractionTarget(): void;
}

export type FrameXrControlPlan =
  | {
    kind: "xr";
    inputProfile: string;
    sanitizedAxes: XrAxesSample;
    clearAvatarDebug: false;
    debugLocomotionMode: Extract<RuntimeDebugLocomotionMode, "vr" | "vr-seated">;
    rayVisibleLatched: boolean;
    turnCooldownSeconds: number;
    turnArmed: boolean;
    nextYaw: number | null;
    snapTurnCommands: RuntimeCommand[];
    confirmInteraction: boolean;
    confirmInteractionCommands: FrameLocomotionCommand[];
    triggerPressedLastFrame: boolean;
  }
  | {
    kind: "non_xr";
    inputProfile: null;
    sanitizedAxes: XrAxesSample;
    clearAvatarDebug: true;
    debugLocomotionMode: null;
    rayVisibleLatched: false;
    turnArmed: true;
    confirmInteraction: false;
    snapTurnCommands: RuntimeCommand[];
    confirmInteractionCommands: FrameLocomotionCommand[];
    triggerPressedLastFrame: false;
  };

export interface FrameXrControlInput {
  frameContext: RuntimeFrameContext;
  yaw: number;
  currentSeatId: string | null;
  turnCooldownSeconds: number;
  turnArmed: boolean;
  deltaSeconds: number;
}

export interface FrameXrControlPlanHandlers {
  executeCommands(commands: FrameLocomotionCommand[]): void;
}

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

export interface FrameLocomotionPipelineInput {
  frameContext: RuntimeFrameContext;
  deltaSeconds: number;
  floorY: number;
  turnCooldownSeconds: number;
  turnArmed: boolean;
}

export type FrameLocomotionPipelineHandlers = FrameXrControlPlanHandlers
  & FrameLocomotionMovementPlanHandlers
  & {
    getYaw(): number;
    getPose(): LocalPose;
    getCurrentSeatId(): string | null;
    getSeatRootPosition(seatId: string): Vector3Like | null;
    getSeatYaw(seatId: string): number | undefined;
    getLastAppliedSeatLockId(): string | null;
    getCameraForward(): FlatVector;
    getDesktopFastMove(): boolean;
    getBotMove(): FlatVector | null;
  };

export interface FrameLocomotionPipelineResult {
  xrControlPlan: FrameXrControlPlan;
  movementPlan: FrameLocomotionMovementPlan;
}

const ZERO_MOVE: FlatVector = { x: 0, z: 0 };

function createZeroXrAxes(): XrAxesSample {
  return { moveX: 0, moveY: 0, turnX: 0, turnY: 0 };
}

function hasMove(move: FlatVector): boolean {
  return move.x !== 0 || move.z !== 0;
}

export function executeFrameLocomotionCommands(
  commands: FrameLocomotionCommand[],
  handlers: FrameLocomotionCommandHandlers
): void {
  const runtimeCommands: RuntimeCommand[] = [];
  const flushRuntimeCommands = () => {
    if (runtimeCommands.length > 0) {
      handlers.executeRuntimeCommands(runtimeCommands.splice(0));
    }
  };

  for (const command of commands) {
    if (command.type === "confirm_interaction_target") {
      flushRuntimeCommands();
      handlers.confirmInteractionTarget();
      continue;
    }
    runtimeCommands.push(command);
  }

  flushRuntimeCommands();
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

export function planFrameXrControls(input: FrameXrControlInput): FrameXrControlPlan {
  if (input.frameContext.source !== "xr" || !input.frameContext.xr) {
    return {
      kind: "non_xr",
      inputProfile: null,
      sanitizedAxes: createZeroXrAxes(),
      clearAvatarDebug: true,
      debugLocomotionMode: null,
      rayVisibleLatched: false,
      turnArmed: true,
      confirmInteraction: false,
      snapTurnCommands: [],
      confirmInteractionCommands: [],
      triggerPressedLastFrame: false
    };
  }

  const sanitizedAxes = input.frameContext.xr.sanitizedAxes;
  const turn = applySnapTurn(
    { angle: input.yaw, cooldownSeconds: input.turnCooldownSeconds, armed: input.turnArmed },
    input.frameContext.intents.snapTurn.axis,
    input.deltaSeconds,
    sanitizedAxes.turnX
  );
  const nextYaw = turn.angle !== input.yaw ? turn.angle : null;
  const snapTurnCommands: RuntimeCommand[] = nextYaw === null ? [] : [
    { type: "apply_snap_turn_yaw", yaw: nextYaw },
    { type: "telemetry", kind: "snap_turn" }
  ];
  const confirmInteraction = input.frameContext.intents.confirmInteraction;
  return {
    kind: "xr",
    inputProfile: input.frameContext.xr.profile,
    sanitizedAxes,
    clearAvatarDebug: false,
    debugLocomotionMode: input.currentSeatId ? "vr-seated" : "vr",
    rayVisibleLatched: input.frameContext.xr.rayVisibleLatched,
    turnCooldownSeconds: turn.cooldownSeconds,
    turnArmed: turn.armed ?? true,
    nextYaw,
    snapTurnCommands,
    confirmInteraction,
    confirmInteractionCommands: confirmInteraction
      ? [{ type: "telemetry", kind: "trigger_press" }, { type: "confirm_interaction_target" }]
      : [],
    triggerPressedLastFrame: input.frameContext.xr.triggerPressed
  };
}

export function executeFrameXrControlPlan(
  plan: FrameXrControlPlan,
  handlers: FrameXrControlPlanHandlers
): void {
  if (plan.kind === "xr") {
    handlers.executeCommands([
      { type: "set_xr_input_profile", profile: plan.inputProfile },
      { type: "set_debug_xr_axes", axes: plan.sanitizedAxes },
      { type: "set_xr_ray_visible_latched", visible: plan.rayVisibleLatched },
      { type: "set_xr_turn_cooldown", seconds: plan.turnCooldownSeconds },
      { type: "set_xr_turn_armed", armed: plan.turnArmed }
    ]);
    if (plan.snapTurnCommands.length > 0) {
      handlers.executeCommands(plan.snapTurnCommands);
    }
    handlers.executeCommands([{ type: "set_debug_locomotion_mode", mode: plan.debugLocomotionMode }]);

    if (plan.confirmInteraction) {
      if (plan.confirmInteractionCommands.length > 0) {
        handlers.executeCommands(plan.confirmInteractionCommands);
      }
    }
    handlers.executeCommands([{ type: "set_xr_select_pressed_last_frame", pressed: plan.triggerPressedLastFrame }]);
    return;
  }

  handlers.executeCommands([
    { type: "set_xr_select_pressed_last_frame", pressed: plan.triggerPressedLastFrame },
    { type: "set_xr_ray_visible_latched", visible: plan.rayVisibleLatched },
    { type: "set_xr_turn_armed", armed: plan.turnArmed },
    { type: "set_xr_input_profile", profile: plan.inputProfile },
    ...(plan.clearAvatarDebug ? [{ type: "clear_xr_avatar_debug" } as const] : []),
    { type: "set_debug_xr_axes", axes: plan.sanitizedAxes }
  ]);
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
  if (plan.kind === "seat_lock") {
    if (plan.commands.length > 0) {
      handlers.executeCommands(plan.commands);
    }
    handlers.executeCommands([
      { type: "set_last_applied_seat_lock_id", seatId: plan.seatId },
      { type: "set_avatar_movement", move: plan.avatarMove, turnRate: plan.avatarTurnRate },
      { type: "update_local_position_debug" }
    ]);
    return;
  }

  const movementCommands = plan.commands.filter((command) => command.type === "move_flat_to");
  const preMovementCommands = plan.commands.filter((command) => command.type !== "move_flat_to");
  if (preMovementCommands.length > 0) {
    handlers.executeCommands(preMovementCommands);
  }

  if (plan.debugLocomotionMode) {
    handlers.executeCommands([{ type: "set_debug_locomotion_mode", mode: plan.debugLocomotionMode }]);
  }

  if (movementCommands.length > 0) {
    handlers.executeCommands(movementCommands);
  }

  handlers.executeCommands([
    { type: "set_avatar_movement", move: plan.avatarMove, turnRate: plan.avatarTurnRate },
    { type: "update_local_position_debug" }
  ]);
}

function executeFrameXrControlStage(
  input: FrameLocomotionPipelineInput,
  handlers: FrameLocomotionPipelineHandlers
): FrameXrControlPlan {
  const xrControlPlan = planFrameXrControls({
    frameContext: input.frameContext,
    yaw: handlers.getYaw(),
    currentSeatId: handlers.getCurrentSeatId(),
    turnCooldownSeconds: input.turnCooldownSeconds,
    turnArmed: input.turnArmed,
    deltaSeconds: input.deltaSeconds
  });

  executeFrameXrControlPlan(xrControlPlan, handlers);
  return xrControlPlan;
}

function executeFrameMovementStage(
  input: FrameLocomotionPipelineInput,
  handlers: FrameLocomotionPipelineHandlers
): FrameLocomotionMovementPlan {
  const currentSeatId = handlers.getCurrentSeatId();
  const movementPlan = planFrameLocomotionMovement({
    pose: handlers.getPose(),
    frameContext: input.frameContext,
    deltaSeconds: input.deltaSeconds,
    floorY: input.floorY,
    currentSeatId,
    seatRootPosition: currentSeatId ? handlers.getSeatRootPosition(currentSeatId) : null,
    seatYaw: currentSeatId ? handlers.getSeatYaw(currentSeatId) : undefined,
    lastAppliedSeatLockId: handlers.getLastAppliedSeatLockId(),
    cameraForward: handlers.getCameraForward(),
    desktopFastMove: handlers.getDesktopFastMove(),
    botMove: handlers.getBotMove()
  });

  executeFrameLocomotionMovementPlan(movementPlan, handlers);
  return movementPlan;
}

export function executeFrameLocomotionPipeline(
  input: FrameLocomotionPipelineInput,
  handlers: FrameLocomotionPipelineHandlers
): FrameLocomotionPipelineResult {
  const xrControlPlan = executeFrameXrControlStage(input, handlers);
  const movementPlan = executeFrameMovementStage(input, handlers);

  return { xrControlPlan, movementPlan };
}
